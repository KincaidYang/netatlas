import { HTTPException } from "hono/http-exception";

/**
 * Named region presets — the API surface. Callers pick a preset (or pass
 * explicit ISO country codes) instead of learning RIPE Atlas internals.
 * Each preset is a list of ISO 3166-1 alpha-2 country codes.
 */
export const REGION_PRESETS: Record<string, string[]> = {
  global: ["US", "DE", "GB", "FR", "JP", "SG", "IN", "BR", "AU", "ZA"],
  europe: ["DE", "GB", "FR", "NL", "SE", "IT", "ES", "PL"],
  apac: ["JP", "SG", "IN", "AU", "KR", "HK", "TW", "ID"],
  americas: ["US", "CA", "BR", "MX", "AR", "CL"],
};

/** Cost guards — every probe per measurement burns Atlas credits. */
export const MAX_PROBES_PER_REGION = 5;
export const MAX_TOTAL_PROBES = 50;

/** DNS record types the API accepts (all are pretty-printed by src/dns.ts). */
export const SUPPORTED_QUERY_TYPES = ["A", "AAAA", "CNAME", "NS", "SOA", "TXT", "MX", "PTR", "SRV", "CAA"] as const;
export type QueryType = (typeof SUPPORTED_QUERY_TYPES)[number];

export function normalizeQueryType(input: string | undefined): QueryType {
  const qt = (input ?? "A").toUpperCase();
  if (!(SUPPORTED_QUERY_TYPES as readonly string[]).includes(qt)) {
    throw new HTTPException(400, {
      message: `unsupported queryType '${qt}'. Supported: ${SUPPORTED_QUERY_TYPES.join(", ")}`,
    });
  }
  return qt as QueryType;
}

const clamp = (n: number, lo: number, hi: number) => Math.min(hi, Math.max(lo, n));

/** Resolve the requested region selection into a concrete country list. */
export function resolveCountries(input: { regionSet?: string; countries?: string[] }): string[] {
  if (input.countries?.length) {
    return [...new Set(input.countries.map((c) => c.trim().toUpperCase()))];
  }
  const preset = input.regionSet ?? "global";
  const list = REGION_PRESETS[preset];
  if (!list) {
    throw new HTTPException(400, {
      message: `unknown regionSet '${preset}'. Known: ${Object.keys(REGION_PRESETS).join(", ")}`,
    });
  }
  return list;
}

export interface ProbeSelectionGroup {
  type: "country";
  value: string;
  requested: number;
  tags: { include: string[] };
}

/**
 * Build the Atlas `probes[]` selection: one `country` group per region, asking
 * Atlas to pick currently-connected probes that can actually do DNS over the
 * chosen address family. Returns the selection plus the per-country requested
 * map (stashed in the measurement description so GET can report fill rates).
 */
export function buildProbeSelection(
  countries: string[],
  probesPerRegion: number,
  af: 4 | 6,
): { probes: ProbeSelectionGroup[]; requested: Record<string, number> } {
  if (countries.length === 0) {
    throw new HTTPException(400, { message: "no regions resolved" });
  }
  const per = clamp(Math.floor(probesPerRegion), 1, MAX_PROBES_PER_REGION);
  const total = countries.length * per;
  if (total > MAX_TOTAL_PROBES) {
    throw new HTTPException(400, {
      message: `requested ${total} probes exceeds cap of ${MAX_TOTAL_PROBES}; reduce regions or probesPerRegion`,
    });
  }
  // Filter to probes whose connectivity for this AF works, so we don't spend
  // credits on probes that can't even send the query. (Relax this tag if you
  // are specifically hunting for broken/poisoned resolvers.)
  const tag = af === 6 ? "system-ipv6-works" : "system-ipv4-works";
  const probes = countries.map<ProbeSelectionGroup>((cc) => ({
    type: "country",
    value: cc,
    requested: per,
    tags: { include: [tag] },
  }));
  const requested: Record<string, number> = {};
  for (const cc of countries) requested[cc] = per;
  return { probes, requested };
}
