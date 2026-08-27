import type { AtlasResultRow, Env } from "../types";
import { assertPublicTarget, asString, af, ms, resolveMs, resolveOnProbe, rttStats, stringifyError } from "./kind";
import type { MeasurementKind, NodeSummary, ProbeOutcome } from "./kind";

export interface PingParams {
  target: string;
  af: 4 | 6;
  packets: number;
}

/** Atlas charges 3 credits per ping result regardless of packet count. */
export const ping: MeasurementKind<PingParams> = {
  type: "ping",
  label: "Ping (丢包 / 延迟)",
  creditsPerProbe: () => 3,

  validate(input: Record<string, unknown>, _env: Env): PingParams {
    const packets = Number(input.packets ?? 3);
    return {
      target: assertPublicTarget(asString(input, "target")),
      af: af(input),
      packets: Math.min(Math.max(Number.isFinite(packets) ? Math.floor(packets) : 3, 1), 6),
    };
  },

  buildDefinition(p, description) {
    return {
      type: "ping",
      af: p.af,
      target: p.target,
      packets: p.packets,
      ...resolveOnProbe(p.target),
      description,
      is_oneoff: true,
    };
  },

  parseRow(row: AtlasResultRow): ProbeOutcome {
    if (row.error) return { ok: false, rttMs: null, error: stringifyError(row.error), detail: {} };
    const sent = Number(row.sent ?? 0);
    const rcvd = Number(row.rcvd ?? 0);
    // Atlas reports -1 for min/avg/max when nothing came back; that is "no
    // measurement", not a negative round-trip time.
    const stat = (v: unknown) => (rcvd > 0 ? ms(v) : null);
    const avg = stat(row.avg);
    // Which packet was lost, not just how many. With three packets a single
    // lost first packet reads as 33% loss, and a lost *first* packet is
    // usually the cost of resolving a neighbour or opening firewall state
    // rather than anything wrong with the path.
    const packets = (Array.isArray(row.result) ? (row.result as Array<Record<string, unknown>>) : []).map(
      (p) => ms(p.rtt),
    );
    return {
      ok: rcvd > 0,
      rttMs: avg,
      error: rcvd === 0 ? "all packets lost" : undefined,
      detail: {
        sent,
        rcvd,
        lossPct: sent > 0 ? Math.round(((sent - rcvd) / sent) * 1000) / 10 : null,
        min: stat(row.min),
        avg,
        max: stat(row.max),
        packets,
        // Duplicate replies mean something is answering twice: a routing loop,
        // a broken NAT, a middlebox. Rare, so it is only worth showing when
        // it is not zero.
        dup: typeof row.dup === "number" && row.dup > 0 ? row.dup : null,
        ttl: typeof row.ttl === "number" ? row.ttl : null,
        resolveMs: resolveMs(row),
        dstAddr: typeof row.dst_addr === "string" ? row.dst_addr : null,
      },
    };
  },

  summarize(outcomes: ProbeOutcome[]): NodeSummary {
    let sent = 0;
    let rcvd = 0;
    for (const o of outcomes) {
      sent += Number(o.detail.sent ?? 0);
      rcvd += Number(o.detail.rcvd ?? 0);
    }
    return {
      ...rttStats(outcomes.map((o) => o.rttMs)),
      lossPct: sent > 0 ? Math.round(((sent - rcvd) / sent) * 1000) / 10 : null,
    };
  },
};
