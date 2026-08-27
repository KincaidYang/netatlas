import type { AtlasResultRow, Env } from "../types";
import { assertPublicTarget, asString, af, resolveOnProbe, rttStats, stringifyError } from "./kind";
import type { MeasurementKind, NodeSummary, ProbeOutcome } from "./kind";

export interface NtpParams {
  target: string;
  af: 4 | 6;
}

/**
 * NTP reports **seconds**; ping, traceroute and http report milliseconds.
 *
 * Proven from a result row rather than assumed: `ref-ts` minus the NTP epoch
 * (2208988800) equals that row's own unix `timestamp` to the second, and `rtt`
 * equals (final-ts − origin-ts) − (transmit-ts − receive-ts) computed from
 * those same fields. A median rtt across public measurements is 0.027, which
 * is 27 ms of network and could not be 27 µs.
 *
 * Rounded to microseconds, not to `ms()`'s three decimals — rounding first and
 * scaling second turned 0.023669 s into 24 ms instead of 23.669 ms.
 */
const secToMs = (v: unknown): number | null =>
  typeof v === "number" && Number.isFinite(v) ? Math.round(v * 1_000_000) / 1000 : null;

/** 20 credits per probe — measured against a real account, RIPE does not document it. */
export const ntp: MeasurementKind<NtpParams> = {
  type: "ntp",
  label: "NTP (时间同步)",
  creditsPerProbe: () => 20,

  validate(input: Record<string, unknown>, _env: Env): NtpParams {
    return { target: assertPublicTarget(asString(input, "target")), af: af(input) };
  },

  buildDefinition(p, description) {
    return { type: "ntp", af: p.af, target: p.target, ...resolveOnProbe(p.target), description, is_oneoff: true };
  },

  parseRow(row: AtlasResultRow): ProbeOutcome {
    if (row.error) return { ok: false, rttMs: null, error: stringifyError(row.error), detail: {} };
    const replies = Array.isArray(row.result) ? (row.result as Array<Record<string, unknown>>) : [];
    const answered = replies.filter((r) => typeof r.rtt === "number");
    const rtts = answered.map((r) => secToMs(r.rtt)).filter((v): v is number => v !== null);
    const offsets = answered.map((r) => secToMs(r.offset)).filter((v): v is number => v !== null);
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
        rootDelay: secToMs(row["root-delay"]),
        rootDispersion: secToMs(row["root-dispersion"]),
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
