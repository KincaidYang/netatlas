import { HTTPException } from "hono/http-exception";
import type { AtlasDnsResult, AtlasMeasurement, ProbeMeta } from "./types";
import type { ProbeSelectionGroup } from "./regions";

const ATLAS_BASE = "https://atlas.ripe.net/api/v2";

export interface CreateDnsOptions {
  domain: string;
  queryType: string;
  af: 4 | 6;
  probes: ProbeSelectionGroup[];
  description: string;
  /** Explicit resolver/authoritative target. Mutually exclusive with probe resolver. */
  target?: string;
}

/** Thin REST client for the RIPE Atlas v2 API. No official JS SDK exists. */
export class AtlasClient {
  constructor(private readonly apiKey: string) {}

  private authHeaders(): Record<string, string> {
    return { Authorization: `Key ${this.apiKey}` };
  }

  /** Create a one-off DNS measurement. Returns the new measurement id. */
  async createDnsMeasurement(opts: CreateDnsOptions): Promise<number> {
    const definition: Record<string, unknown> = {
      type: "dns",
      af: opts.af,
      query_class: "IN",
      query_type: opts.queryType,
      query_argument: opts.domain,
      resolve_on_probe: true,
      description: opts.description,
      is_oneoff: true,
    };
    // Either query the probe's own resolver (reveals real geo/CDN scheduling)
    // or a specific target server — never both.
    if (opts.target) definition.target = opts.target;
    else definition.use_probe_resolver = true;

    const res = await fetch(`${ATLAS_BASE}/measurements/`, {
      method: "POST",
      headers: { ...this.authHeaders(), "Content-Type": "application/json" },
      body: JSON.stringify({ definitions: [definition], probes: opts.probes, is_oneoff: true }),
    });
    if (!res.ok) {
      throw new HTTPException(502, { message: `atlas create failed (${res.status}): ${await res.text()}` });
    }
    const data = (await res.json()) as { measurements?: number[] };
    const id = data.measurements?.[0];
    if (!id) throw new HTTPException(502, { message: "atlas create returned no measurement id" });
    return id;
  }

  async getMeasurement(id: number): Promise<AtlasMeasurement> {
    const res = await fetch(`${ATLAS_BASE}/measurements/${id}/`, { headers: this.authHeaders() });
    if (!res.ok) {
      throw new HTTPException(res.status === 404 ? 404 : 502, {
        message: `atlas measurement fetch failed (${res.status})`,
      });
    }
    return (await res.json()) as AtlasMeasurement;
  }

  async getResults(id: number): Promise<AtlasDnsResult[]> {
    const res = await fetch(`${ATLAS_BASE}/measurements/${id}/results/`, { headers: this.authHeaders() });
    if (res.status === 404) return []; // not produced yet
    if (!res.ok) throw new HTTPException(502, { message: `atlas results fetch failed (${res.status})` });
    return (await res.json()) as AtlasDnsResult[];
  }

  /** Batch-fetch probe metadata (country/ASN) to group results by region. */
  async getProbes(ids: number[]): Promise<Map<number, ProbeMeta>> {
    const map = new Map<number, ProbeMeta>();
    if (ids.length === 0) return map;
    const url = `${ATLAS_BASE}/probes/?id__in=${ids.join(",")}&fields=id,country_code,asn_v4,asn_v6&page_size=${ids.length}`;
    const res = await fetch(url, { headers: this.authHeaders() });
    if (!res.ok) return map; // best-effort; aggregation falls back to "??"
    const data = (await res.json()) as { results?: Array<{ id: number } & ProbeMeta> };
    for (const p of data.results ?? []) {
      map.set(p.id, { country_code: p.country_code, asn_v4: p.asn_v4, asn_v6: p.asn_v6 });
    }
    return map;
  }
}
