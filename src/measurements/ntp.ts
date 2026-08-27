import type { AtlasResultRow, Env } from "../types";
import { assertPublicTarget, asString, af, ms, rttStats, stringifyError } from "./kind";
import type { MeasurementKind, NodeSummary, ProbeOutcome } from "./kind";

export interface NtpParams {
  target: string;
  af: 4 | 6;
}

/** 20 credits per probe — measured against a real account, RIPE does not document it. */
export const ntp: MeasurementKind<NtpParams> = {
  type: "ntp",
  label: "NTP (时间同步)",
  creditsPerProbe: () => 20,

  validate(input: Record<string, unknown>, _env: Env): NtpParams {
    return { target: assertPublicTarget(asString(input, "target")), af: af(input) };
  },

  buildDefinition(p, description) {
    return { type: "ntp", af: p.af, target: p.target, description, is_oneoff: true };
  },

  parseRow(row: AtlasResultRow): ProbeOutcome {
    if (row.error) return { ok: false, rttMs: null, error: stringifyError(row.error), detail: {} };
    const replies = Array.isArray(row.result) ? (row.result as Array<Record<string, unknown>>) : [];
    const answered = replies.filter((r) => typeof r.rtt === "number");
    const rtts = answered.map((r) => ms(r.rtt)).filter((v): v is number => v !== null);
    const offsets = answered.map((r) => ms(r.offset)).filter((v): v is number => v !== null);
    const avg = (xs: number[]) => (xs.length ? Math.round((xs.reduce((a, b) => a + b, 0) / xs.length) * 1000) / 1000 : null);

    return {
      ok: answered.length > 0,
      rttMs: avg(rtts),
      error: answered.length === 0 ? "no NTP reply" : undefined,
      detail: {
        stratum: typeof row.stratum === "number" ? row.stratum : null,
        version: typeof row.version === "number" ? row.version : null,
        mode: typeof row.mode === "string" ? row.mode : null,
        leapIndicator: typeof row.li === "string" ? row.li : null,
        refId: typeof row["ref-id"] === "string" ? row["ref-id"] : null,
        rootDelay: ms(row["root-delay"]),
        rootDispersion: ms(row["root-dispersion"]),
        offsetMs: avg(offsets),
        dstAddr: typeof row.dst_addr === "string" ? row.dst_addr : null,
      },
    };
  },

  summarize(outcomes: ProbeOutcome[]): NodeSummary {
    const offsets = outcomes
      .map((o) => o.detail.offsetMs)
      .filter((v): v is number => typeof v === "number");
    const strata = outcomes
      .map((o) => o.detail.stratum)
      .filter((v): v is number => typeof v === "number");
    return {
      ...rttStats(outcomes.map((o) => o.rttMs)),
      offsetMs: offsets.length
        ? Math.round((offsets.reduce((a, b) => a + b, 0) / offsets.length) * 1000) / 1000
        : null,
      stratum: strata.length ? Math.max(...strata) : null,
    };
  },
};
