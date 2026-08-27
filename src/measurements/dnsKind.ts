import type { AtlasResultRow, Env } from "../types";
import { parseDnsAnswers, type DnsRecord } from "../dns";
import { assertPublicTarget, asString, af, bad, ms, rttStats, stringifyError } from "./kind";
import type { MeasurementKind, NodeSummary, ProbeOutcome } from "./kind";

export const SUPPORTED_QUERY_TYPES = [
  "A", "AAAA", "CNAME", "NS", "SOA", "TXT", "MX", "PTR", "SRV", "CAA",
] as const;
export type QueryType = (typeof SUPPORTED_QUERY_TYPES)[number];

export interface DnsParams {
  target: string;
  af: 4 | 6;
  queryType: QueryType;
  protocol: "UDP" | "TCP";
  /** Explicit resolver to query. When absent we use each probe's own resolver. */
  resolver?: string;
}

interface ResolverAnswer {
  dst: string | null;
  rttMs: number | null;
  answers: DnsRecord[];
  error?: string;
}

export function normalizeQueryType(input: unknown): QueryType {
  const qt = String(input ?? "A").toUpperCase();
  if (!(SUPPORTED_QUERY_TYPES as readonly string[]).includes(qt)) {
    bad(`unsupported queryType '${qt}'. Supported: ${SUPPORTED_QUERY_TYPES.join(", ")}`);
  }
  return qt as QueryType;
}

/** 10 credits per probe over UDP, 20 over TCP. */
export const dns: MeasurementKind<DnsParams> = {
  type: "dns",
  label: "DNS (解析结果)",
  creditsPerProbe: (p) => (p.protocol === "TCP" ? 20 : 10),

  validate(input: Record<string, unknown>, _env: Env): DnsParams {
    const resolver = typeof input.resolver === "string" && input.resolver.trim()
      ? assertPublicTarget(input.resolver)
      : undefined;
    return {
      target: assertPublicTarget(asString(input, "target")),
      af: af(input),
      queryType: normalizeQueryType(input.queryType),
      protocol: String(input.protocol ?? "UDP").toUpperCase() === "TCP" ? "TCP" : "UDP",
      resolver,
    };
  },

  buildDefinition(p, description) {
    const def: Record<string, unknown> = {
      type: "dns",
      af: p.af,
      query_class: "IN",
      query_type: p.queryType,
      query_argument: p.target,
      protocol: p.protocol,
      resolve_on_probe: true,
      description,
      is_oneoff: true,
    };
    // Either ask each probe's own resolver (this is what reveals real
    // GeoDNS/CDN scheduling) or pin one server — never both.
    if (p.resolver) def.target = p.resolver;
    else def.use_probe_resolver = true;
    return def;
  },

  parseRow(row: AtlasResultRow): ProbeOutcome {
    if (row.error) return { ok: false, rttMs: null, error: stringifyError(row.error), detail: {} };

    const single = row.result as { abuf?: string; rt?: number } | undefined;
    const sets = Array.isArray(row.resultset)
      ? (row.resultset as Array<Record<string, unknown>>)
      : single
        ? [{ result: single }]
        : [];

    const resolvers: ResolverAnswer[] = sets.map((s) => {
      const dst = typeof s.dst_addr === "string" ? s.dst_addr : null;
      if (s.error) return { dst, rttMs: null, answers: [], error: stringifyError(s.error) };
      const res = s.result as { abuf?: string; rt?: number } | undefined;
      return {
        dst,
        rttMs: ms(res?.rt),
        answers: res?.abuf ? parseDnsAnswers(res.abuf) : [],
      };
    });

    const primary = resolvers[0];
    const answered = resolvers.some((r) => r.answers.length > 0);
    return {
      ok: answered,
      rttMs: primary?.rttMs ?? null,
      error: answered ? undefined : (primary?.error ?? "no answer"),
      detail: {
        answers: primary?.answers ?? [],
        // Only surface the per-resolver breakdown when there really are several.
        resolvers: resolvers.length > 1 ? resolvers : undefined,
      },
    };
  },

  summarize(outcomes: ProbeOutcome[]): NodeSummary {
    const values = new Set<string>();
    for (const o of outcomes) {
      for (const rec of (o.detail.answers as DnsRecord[] | undefined) ?? []) {
        // Keep the record type: a CNAME and an A in one answer are different
        // facts, and comparing bare values across nodes conflates them.
        values.add(`${rec.type} ${rec.data}`);
      }
    }
    return { ...rttStats(outcomes.map((o) => o.rttMs)), distinctAnswers: [...values].sort() };
  },
};
