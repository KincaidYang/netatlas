import type { AtlasResultRow, Env } from "../types";
import { parseDnsMessage, type DnsRecord } from "../dns";
import { assertPublicTarget, asString, af, bad, ms, rttStats, stringifyError } from "./kind";
import type { MeasurementKind, NodeSummary, ProbeOutcome } from "./kind";

/**
 * Exactly what Atlas accepts in `query_type` — not what DNS defines, and not
 * what src/dns.ts can decode. Anything else comes back as
 * `"<TYPE>" is not a valid choice` from the create call.
 *
 * Verified by POSTing each candidate with `probes: []`, which always fails and
 * therefore costs nothing, while still running field validation. CAA, HTTPS,
 * SVCB, NSEC3, NSEC3PARAM, URI, SSHFP, CDS, CDNSKEY, SPF, HINFO, LOC, CERT and
 * DNAME are all rejected; the ones below are all accepted.
 */
export const SUPPORTED_QUERY_TYPES = [
  "A", "AAAA", "CNAME", "NS", "SOA", "TXT", "MX", "PTR", "SRV", "NAPTR",
  "DS", "DNSKEY", "RRSIG", "NSEC", "TLSA", "ANY",
] as const;

/**
 * Types whose whole point is the signature chain. Asking for them without the
 * DO bit gets an unsigned answer back and the resolver never sets AD, so the
 * one thing you came to find out — did this resolver validate — is invisible.
 */
const DNSSEC_TYPES = new Set(["DS", "DNSKEY", "RRSIG", "NSEC", "TLSA"]);
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
  rcode?: string;
  authenticated?: boolean;
  questionType?: string;
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
    if (DNSSEC_TYPES.has(p.queryType)) {
      def.set_do_bit = true;
      // A signed answer does not fit in 512 bytes; without this it comes back
      // truncated and the records we asked for are simply missing.
      def.udp_payload_size = 4096;
    }
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
      const msg = res?.abuf ? parseDnsMessage(res.abuf) : null;
      return {
        dst,
        rttMs: ms(res?.rt),
        answers: msg?.answers ?? [],
        rcode: msg?.rcode,
        authenticated: msg?.authenticated,
        questionType: msg?.questionType,
      };
    });

    const primary = resolvers[0];
    // What was asked is only recoverable from the question the responder
    // echoed back; the result row itself does not carry the query type.
    const dnssec = DNSSEC_TYPES.has(primary?.questionType ?? "");
    const answered = resolvers.some((r) => r.answers.length > 0);
    // An empty NOERROR, an NXDOMAIN and a SERVFAIL are three different facts
    // that all present as "no records"; say which one it was.
    const rcode = primary?.rcode;
    return {
      ok: answered,
      rttMs: primary?.rttMs ?? null,
      error: answered ? undefined : (primary?.error ?? (rcode && rcode !== "NOERROR" ? rcode : "no answer")),
      detail: {
        answers: primary?.answers ?? [],
        rcode: rcode || null,
        // AD only means anything when we asked with the DO bit set.
        authenticated: dnssec ? (primary?.authenticated ?? null) : null,
        // Only surface the per-resolver breakdown when there really are several.
        resolvers: resolvers.length > 1 ? resolvers : undefined,
      },
    };
  },

  summarize(outcomes: ProbeOutcome[]): NodeSummary {
    const values = new Set<string>();
    const ttls: number[] = [];
    for (const o of outcomes) {
      for (const rec of (o.detail.answers as DnsRecord[] | undefined) ?? []) {
        // Keep the record type: a CNAME and an A in one answer are different
        // facts, and comparing bare values across nodes conflates them.
        values.add(`${rec.type} ${rec.data}`);
        if (Number.isFinite(rec.ttl)) ttls.push(rec.ttl);
      }
    }
    const rcodes = [...new Set(outcomes.map((o) => o.detail.rcode).filter(Boolean))] as string[];
    const validated = outcomes.map((o) => o.detail.authenticated).filter((v) => typeof v === "boolean");
    return {
      ...rttStats(outcomes.map((o) => o.rttMs)),
      distinctAnswers: [...values].sort(),
      rcodes,
      // null when the query was not a DNSSEC one; AD would be meaningless.
      authenticated: validated.length ? validated.every(Boolean) : null,
      // A TTL is whatever is left of each resolver's cache entry, so it differs
      // everywhere by design. Reported next to the answers, never part of
      // deciding whether two nodes agree — that would split every group.
      ttl: ttls.length ? { min: Math.min(...ttls), max: Math.max(...ttls) } : null,
    };
  },
};
