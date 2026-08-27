import type { AtlasResultRow, Env } from "../types";
import { assertPublicTarget, asString, af, bad, ms, resolveOnProbe, rttStats, stringifyError } from "./kind";
import type { MeasurementKind, NodeSummary, ProbeOutcome } from "./kind";

export interface HttpParams {
  target: string;
  af: 4 | 6;
  method: "GET" | "HEAD";
  path: string;
}

export const ANCHOR_SUFFIX = ".anchors.atlas.ripe.net";

/**
 * RIPE restricts http measurements to RIPE Atlas anchors — a non-anchor target
 * is rejected upstream with `Only anchors may be targeted`. We enforce it here
 * so we never spend a round-trip (or look like we're probing arbitrary sites).
 * Accounts granted a case-by-case exemption by RIPE can set
 * ALLOW_ANY_HTTP_TARGET=1; the rest of the plugin is unchanged either way.
 */
export const http: MeasurementKind<HttpParams> = {
  type: "http",
  label: "HTTP (仅限 RIPE anchor)",
  creditsPerProbe: () => 20,

  validate(input: Record<string, unknown>, env: Env): HttpParams {
    const target = asString(input, "target").toLowerCase();
    if (env.ALLOW_ANY_HTTP_TARGET === "1") {
      assertPublicTarget(target);
    } else if (!target.endsWith(ANCHOR_SUFFIX)) {
      bad(
        `http measurements may only target RIPE Atlas anchors (*${ANCHOR_SUFFIX}). ` +
          `Pick one from /api/v1/anchors.`,
      );
    }
    const method = String(input.method ?? "GET").toUpperCase();
    const path = String(input.path ?? "/");
    if (!path.startsWith("/")) bad("'path' must start with '/'");
    return {
      target,
      af: af(input),
      method: (method === "HEAD" ? "HEAD" : "GET") as HttpParams["method"],
      path: path.slice(0, 128),
    };
  },

  buildDefinition(p, description) {
    return {
      type: "http",
      af: p.af,
      target: p.target,
      method: p.method,
      path: p.path,
      ...resolveOnProbe(p.target),
      description,
      is_oneoff: true,
    };
  },

  parseRow(row: AtlasResultRow): ProbeOutcome {
    if (row.error) return { ok: false, rttMs: null, error: stringifyError(row.error), detail: {} };
    const results = Array.isArray(row.result) ? (row.result as Array<Record<string, unknown>>) : [];
    const first = results[0];
    if (!first) return { ok: false, rttMs: null, error: "no response", detail: {} };
    if (first.err) {
      return { ok: false, rttMs: null, error: stringifyError(first.err), detail: {} };
    }
    const status = typeof first.res === "number" ? first.res : null;
    return {
      ok: status !== null && status < 400,
      rttMs: ms(first.rt),
      error: status !== null && status >= 400 ? `HTTP ${status}` : undefined,
      detail: {
        status,
        httpVersion: typeof first.ver === "string" ? first.ver : null,
        headerBytes: typeof first.hsize === "number" ? first.hsize : null,
        bodyBytes: typeof first.bsize === "number" ? first.bsize : null,
        dstAddr: typeof first.dst_addr === "string" ? first.dst_addr : null,
        uri: typeof row.uri === "string" ? row.uri : null,
      },
    };
  },

  summarize(outcomes: ProbeOutcome[]): NodeSummary {
    const codes = [...new Set(outcomes.map((o) => o.detail.status).filter((v) => v !== null))];
    return { ...rttStats(outcomes.map((o) => o.rttMs)), statusCodes: codes };
  },
};
