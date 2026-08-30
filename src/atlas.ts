import { HTTPException } from "hono/http-exception";
import type {
  AtlasAnchor,
  AtlasCredits,
  AtlasMeasurement,
  AtlasParticipationRequest,
  AtlasResultRow,
  ProbeMeta,
} from "./types";

const ATLAS_BASE = "https://atlas.ripe.net/api/v2";

/** One entry of the Atlas `probes[]` selection array. */
export interface ProbeSelectionGroup {
  type: "country" | "asn" | "area" | "prefix" | "probes" | "msm";
  value: string | number;
  requested: number;
  tags?: { include?: string[]; exclude?: string[] };
}

export interface ProbeQuery {
  asns?: number[];
  countries?: string[];
  af?: 4 | 6;
  limit?: number;
  /** 1-based. Atlas caps a page at 500 however large `limit` is. */
  page?: number;
}

/**
 * Thin REST client for the RIPE Atlas v2 API (there is no official JS SDK).
 *
 * Only creation needs the API key. Measurements are public by default, so
 * every read below works unauthenticated — which is what lets a shared result
 * link render for anyone, including measurements created with a caller's own
 * key. We still send the key when we have one, for the higher rate limits.
 */
/**
 * Marks an error that proves no measurement exists.
 *
 * Two ways to earn it: the request never left this Worker, or Atlas read it and
 * refused it with a 4xx. Only then is it safe to give the caller their credits
 * back — refunding an ambiguous failure charges nobody for a measurement that
 * is running, which is the same disagreement between the two ledgers as the bug
 * that added the refund, pointing the other way.
 *
 * It says "no measurement", not "Atlas rejected", because the caller cannot see
 * where inside this client the failure happened. Naming it after the Atlas
 * answer is what hid the missing-key case: that throw is before `fetch`, so
 * nothing was sent, and an earlier version kept the charge for it.
 */
const NO_MEASUREMENT = Symbol.for("netatlas.noMeasurement");

const certainly = <E extends object>(e: E, no: boolean): E =>
  Object.assign(e, { [NO_MEASUREMENT]: no });

export const noMeasurementCreated = (e: unknown): boolean =>
  typeof e === "object" && e !== null && (e as Record<symbol, unknown>)[NO_MEASUREMENT] === true;

export class AtlasClient {
  constructor(private readonly apiKey?: string) {}

  private headers(json = false): Record<string, string> {
    const h: Record<string, string> = {};
    if (this.apiKey) h.Authorization = `Key ${this.apiKey}`;
    if (json) h["Content-Type"] = "application/json";
    return h;
  }

  private async get<T>(path: string, fallback?: T): Promise<T> {
    const res = await fetch(`${ATLAS_BASE}${path}`, { headers: this.headers() });
    if (res.status === 404 && fallback !== undefined) return fallback;
    if (!res.ok) {
      throw new HTTPException(res.status === 404 ? 404 : 502, {
        message: `atlas GET ${path} failed (${res.status})`,
      });
    }
    return (await res.json()) as T;
  }

  /** Create a one-off measurement. Returns the new measurement id. */
  async createMeasurement(
    definition: Record<string, unknown>,
    probes: ProbeSelectionGroup[],
  ): Promise<number> {
    // Before `fetch`, so nothing was sent and nothing can exist. Deterministic
    // too: it fails the same way until the secret is restored, and a caller
    // whose credits were kept for it would stay short for the rest of the day
    // over a deployment mistake they did not make.
    if (!this.apiKey) {
      throw certainly(new HTTPException(500, { message: "no Atlas API key configured" }), true);
    }
    const res = await fetch(`${ATLAS_BASE}/measurements/`, {
      method: "POST",
      headers: this.headers(true),
      body: JSON.stringify({ definitions: [definition], probes, is_oneoff: true }),
    });
    const body = await res.text();
    if (!res.ok) {
      // A 4xx is Atlas refusing the request: it read it, rejected it, and
      // created nothing. A 5xx is not — Atlas may have persisted the
      // measurement and then failed on the way out, so it belongs with the
      // other ambiguous outcomes here (a fetch that never returned, a body that
      // would not read, JSON that would not parse, a 2xx with no id), all of
      // which leave a measurement that may exist and may be spending.
      // `atlasRejected` is how the caller tells the two apart before handing
      // credits back.
      // Pass Atlas's own wording through — it is far more useful than ours
      // (e.g. "Only anchors may be targeted", quota and concurrency errors).
      throw certainly(
        new HTTPException(res.status === 400 ? 400 : 502, {
          message: `atlas create failed (${res.status}): ${body.slice(0, 400)}`,
        }),
        res.status >= 400 && res.status < 500,
      );
    }
    const data = JSON.parse(body) as { measurements?: number[] };
    const id = data.measurements?.[0];
    if (!id) throw new HTTPException(502, { message: "atlas create returned no measurement id" });
    return id;
  }

  async getMeasurement(id: number): Promise<AtlasMeasurement> {
    try {
      return await this.get<AtlasMeasurement>(`/measurements/${id}/`);
    } catch (err) {
      if (err instanceof HTTPException && err.status === 404) {
        throw new HTTPException(404, { message: `measurement ${id} not found` });
      }
      throw err;
    }
  }

  getResults(id: number): Promise<AtlasResultRow[]> {
    return this.get<AtlasResultRow[]>(`/measurements/${id}/results/`, []);
  }

  /**
   * The original probe selection, stored and served by Atlas. This is what
   * replaces a database: it tells us what was *requested* per group so we can
   * report fill rates on a measurement we know nothing else about.
   */
  async getParticipationRequests(id: number): Promise<AtlasParticipationRequest[]> {
    const data = await this.get<{ results?: AtlasParticipationRequest[] }>(
      `/measurements/${id}/participation-requests/`,
      {},
    );
    return (data.results ?? []).filter((r) => r.action === "add");
  }

  /** Batch-fetch probe metadata (country/ASN) to attribute results to nodes. */
  async getProbes(ids: number[]): Promise<Map<number, ProbeMeta>> {
    const map = new Map<number, ProbeMeta>();
    if (ids.length === 0) return map;
    const url = `/probes/?id__in=${ids.join(",")}&fields=id,country_code,asn_v4,asn_v6,status,geometry,tags&page_size=${ids.length}`;
    const data = await this.get<{ results?: ProbeMeta[] }>(url, {});
    for (const p of data.results ?? []) map.set(p.id, p);
    return map;
  }

  /** Find currently-connected probes, used to resolve nodes to concrete probes. */
  async findProbes(q: ProbeQuery): Promise<ProbeMeta[]> {
    const params = new URLSearchParams({
      status: "1", // Connected
      fields: "id,country_code,asn_v4,asn_v6,status",
      page_size: String(q.limit ?? 500),
    });
    if (q.asns?.length) params.set(q.af === 6 ? "asn_v6__in" : "asn_v4__in", q.asns.join(","));
    if (q.countries?.length) params.set("country_code__in", q.countries.join(","));
    if (q.page && q.page > 1) params.set("page", String(q.page));
    const data = await this.get<{ results?: ProbeMeta[] }>(`/probes/?${params}`, {});
    return data.results ?? [];
  }

  /** Live anchors only — the list is full of decommissioned ones. */
  async getAnchors(): Promise<AtlasAnchor[]> {
    const data = await this.get<{ results?: AtlasAnchor[] }>(
      "/anchors/?page_size=500&fields=id,fqdn,city,country,ip_v4,ip_v6,is_disabled",
      {},
    );
    return (data.results ?? []).filter((a) => !a.is_disabled);
  }

  getCredits(): Promise<AtlasCredits> {
    return this.get<AtlasCredits>("/credits/");
  }
}
