import type { AtlasResultRow, Env } from "../types";
import { assertPublicTarget, asString, af, ms, resolveMs, resolveOnProbe, rttStats, stringifyError } from "./kind";
import type { MeasurementKind, NodeSummary, ProbeOutcome } from "./kind";

export interface TracerouteParams {
  target: string;
  af: 4 | 6;
  protocol: "ICMP" | "UDP" | "TCP";
}

interface Hop {
  hop: number;
  from: string | null;
  /** Fastest reply, which is the one that best reflects the path. */
  rttMs: number | null;
  /** Spread across the replies that came back; null when only one did. */
  rttMinMs: number | null;
  rttMaxMs: number | null;
  /** Atlas probes each hop several times; say how many answered. */
  sent: number;
  received: number;
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
      ...resolveOnProbe(p.target),
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
      // Every hop is probed several times. Reporting only the first reply made
      // a hop that answered once out of three look as solid as one that
      // answered three times out of three — the same thing the node-level
      // requested/responded counts exist to prevent, one level down.
      const answered = replies.filter((r) => typeof r.from === "string");
      const rtts = answered.map((r) => ms(r.rtt)).filter((v): v is number => v !== null);
      hops.push({
        hop: Number(h.hop ?? hops.length + 1),
        from: answered.length ? (answered[0].from as string) : null,
        rttMs: rtts.length ? Math.min(...rtts) : null,
        rttMinMs: rtts.length ? Math.min(...rtts) : null,
        rttMaxMs: rtts.length ? Math.max(...rtts) : null,
        sent: replies.length,
        received: answered.length,
        timeout: answered.length === 0,
      });
    }

    const dst = typeof row.dst_addr === "string" ? row.dst_addr : null;
    const last = [...hops].reverse().find((h) => h.from !== null) ?? null;
    // Atlas states this itself; inferring it from "the last responder equals
    // the destination" gets it wrong when the destination answers earlier.
    const reached =
      typeof row.destination_ip_responded === "boolean"
        ? row.destination_ip_responded
        : last !== null && dst !== null && last.from === dst;

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
        // Hops that answered some but not all of their probes.
        lossyHops: hops.filter((h) => h.received > 0 && h.received < h.sent).length,
        resolveMs: resolveMs(row),
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
