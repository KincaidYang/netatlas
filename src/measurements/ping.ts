import type { AtlasResultRow, Env } from "../types";
import { assertPublicTarget, asString, af, ms, resolveOnProbe, rttStats, stringifyError } from "./kind";
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
        ttl: typeof row.ttl === "number" ? row.ttl : null,
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
