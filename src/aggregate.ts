import { parseDnsAnswers, type DnsRecord } from "./dns";
import type { AtlasDnsResult, ProbeMeta } from "./types";

export interface ResolverResult {
  dst: string | null;
  rttMs: number | null;
  answers: DnsRecord[];
  error?: string;
}

export interface ProbeResult {
  probeId: number;
  asn: number | null;
  rttMs: number | null;
  answers: DnsRecord[];
  error?: string;
  /** Present only when the probe queried more than one local resolver. */
  resolvers?: ResolverResult[];
}

export interface RegionResult {
  country: string;
  requested: number;
  responded: number;
  probes: ProbeResult[];
}

/**
 * Group raw Atlas results by probe country. Always reports `requested` vs
 * `responded` so callers can see under-filled regions (e.g. "JP requested 3,
 * responded 1") rather than mistaking a single probe for a regional verdict.
 */
export function aggregate(
  results: AtlasDnsResult[],
  probeMeta: Map<number, ProbeMeta>,
  requested: Record<string, number>,
): RegionResult[] {
  const byCountry = new Map<string, RegionResult>();
  const ensure = (cc: string): RegionResult => {
    let r = byCountry.get(cc);
    if (!r) {
      r = { country: cc, requested: requested[cc] ?? 0, responded: 0, probes: [] };
      byCountry.set(cc, r);
    }
    return r;
  };

  for (const r of results) {
    const meta = probeMeta.get(r.prb_id);
    const region = ensure(meta?.country_code ?? "??");
    region.responded++;
    region.probes.push(extractProbe(r, meta));
  }

  // Surface requested regions that returned nothing.
  for (const cc of Object.keys(requested)) ensure(cc);

  return [...byCountry.values()].sort((a, b) => a.country.localeCompare(b.country));
}

function extractProbe(r: AtlasDnsResult, meta?: ProbeMeta): ProbeResult {
  const asn = meta?.asn_v4 ?? meta?.asn_v6 ?? null;
  if (r.error) {
    return { probeId: r.prb_id, asn, rttMs: null, answers: [], error: stringifyError(r.error) };
  }

  const sets = r.resultset ?? (r.result ? [{ dst_addr: undefined, result: r.result }] : []);
  const resolvers: ResolverResult[] = sets.map((s) => {
    if (s.error) return { dst: s.dst_addr ?? null, rttMs: null, answers: [], error: stringifyError(s.error) };
    const answers = s.result?.abuf ? parseDnsAnswers(s.result.abuf) : [];
    return { dst: s.dst_addr ?? null, rttMs: s.result?.rt ?? null, answers };
  });

  const primary = resolvers[0];
  const out: ProbeResult = {
    probeId: r.prb_id,
    asn,
    rttMs: primary?.rttMs ?? null,
    answers: primary?.answers ?? [],
  };
  if (primary?.error) out.error = primary.error;
  if (resolvers.length > 1) out.resolvers = resolvers;
  return out;
}

function stringifyError(e: unknown): string {
  if (typeof e === "string") return e;
  try {
    return JSON.stringify(e);
  } catch {
    return "error";
  }
}
