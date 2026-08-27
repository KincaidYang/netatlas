import type { AtlasResultRow, Env } from "../types";
import { assertPublicTarget, asString, af, ms, rttStats, stringifyError } from "./kind";
import type { MeasurementKind, NodeSummary, ProbeOutcome } from "./kind";

export interface TracerouteParams {
  target: string;
  af: 4 | 6;
  protocol: "ICMP" | "UDP" | "TCP";
}

interface Hop {
  hop: number;
  from: string | null;
  rttMs: number | null;
  timeout: boolean;
}

const PROTOCOLS = new Set(["ICMP", "UDP", "TCP"]);

/** 30 credits per probe — 10x ping. Rate-limited in its own bucket. */
export const traceroute: MeasurementKind<TracerouteParams> = {
  type: "traceroute",
  label: "Traceroute (路由路径)",
  creditsPerProbe: () => 30,

  validate(input: Record<string, unknown>, _env: Env): TracerouteParams {
    const raw = String(input.protocol ?? "ICMP").toUpperCase();
    return {
      target: assertPublicTarget(asString(input, "target")),
      af: af(input),
      protocol: (PROTOCOLS.has(raw) ? raw : "ICMP") as TracerouteParams["protocol"],
    };
  },

  buildDefinition(p, description) {
    return {
      type: "traceroute",
      af: p.af,
      target: p.target,
      protocol: p.protocol,
      paris: 1,
      description,
      is_oneoff: true,
    };
  },

  parseRow(row: AtlasResultRow): ProbeOutcome {
    if (row.error) return { ok: false, rttMs: null, error: stringifyError(row.error), detail: {} };

    const raw = Array.isArray(row.result) ? (row.result as Array<Record<string, unknown>>) : [];
    const hops: Hop[] = [];
    for (const h of raw) {
      const replies = Array.isArray(h.result) ? (h.result as Array<Record<string, unknown>>) : [];
      // Each hop is probed several times; take the first reply that answered.
      const answered = replies.find((r) => typeof r.from === "string");
      hops.push({
        hop: Number(h.hop ?? hops.length + 1),
        from: answered ? (answered.from as string) : null,
        rttMs: answered ? ms(answered.rtt) : null,
        timeout: !answered,
      });
    }

    const dst = typeof row.dst_addr === "string" ? row.dst_addr : null;
    const last = [...hops].reverse().find((h) => h.from !== null) ?? null;
    const reached = last !== null && dst !== null && last.from === dst;

    return {
      ok: reached,
      rttMs: reached ? last!.rttMs : null,
      error: reached ? undefined : "target not reached",
      detail: {
        dstAddr: dst,
        hops,
        hopCount: hops.length,
        reached,
        lastResponding: last ? last.from : null,
        timeouts: hops.filter((h) => h.timeout).length,
      },
    };
  },

  summarize(outcomes: ProbeOutcome[]): NodeSummary {
    return {
      ...rttStats(outcomes.map((o) => o.rttMs)),
      reached: outcomes.filter((o) => o.ok).length,
      hopsAvg: outcomes.length
        ? Math.round(outcomes.reduce((a, o) => a + Number(o.detail.hopCount ?? 0), 0) / outcomes.length)
        : null,
    };
  },
};
