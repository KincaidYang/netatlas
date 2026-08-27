import { HTTPException } from "hono/http-exception";
import type { AtlasResultRow, Env } from "../types";

/** Normalised per-probe outcome. `detail` carries the type-specific payload. */
export interface ProbeOutcome {
  ok: boolean;
  /** Primary latency metric in ms, or null when there is none/it failed. */
  rttMs: number | null;
  error?: string;
  detail: Record<string, unknown>;
}

/** Whatever a measurement type wants to say about one node's probes. */
export type NodeSummary = Record<string, unknown>;

/**
 * A measurement type plugin. Adding a type to netatlas means adding one of
 * these and registering it in ./index.ts — nothing else in the codebase
 * should need to know which types exist.
 */
export interface MeasurementKind<P = unknown> {
  type: string;
  /** Human label for /api/v1/types. */
  label: string;
  /** Credits Atlas charges per probe per run. Empirically verified — see CLAUDE.md. */
  creditsPerProbe(params: P): number;
  /** Validate + normalise caller input. Throws HTTPException(400). */
  validate(input: Record<string, unknown>, env: Env): P;
  /** Build the Atlas `definitions[0]` object. */
  buildDefinition(params: P, description: string): Record<string, unknown>;
  /** Decode one result row. May be async (sslcert hashes with WebCrypto). */
  parseRow(row: AtlasResultRow): ProbeOutcome | Promise<ProbeOutcome>;
  /** Roll up one node's probe outcomes. */
  summarize(outcomes: ProbeOutcome[]): NodeSummary;
}

export const bad = (message: string): never => {
  throw new HTTPException(400, { message });
};

export function asString(input: Record<string, unknown>, key: string): string {
  const v = input[key];
  if (typeof v !== "string" || !v.trim()) bad(`'${key}' is required`);
  return (v as string).trim();
}

export function af(input: Record<string, unknown>): 4 | 6 {
  return input.af === 6 || input.af === "6" ? 6 : 4;
}

/** Round to 3 decimals; Atlas RTTs carry silly precision. */
export const ms = (n: unknown): number | null =>
  typeof n === "number" && Number.isFinite(n) ? Math.round(n * 1000) / 1000 : null;

export function stringifyError(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object") {
    const rec = e as Record<string, unknown>;
    for (const k of ["error", "err", "detail", "message", "reason"]) {
      if (typeof rec[k] === "string") return rec[k] as string;
    }
    try {
      return JSON.stringify(e);
    } catch {
      /* fall through */
    }
  }
  return "error";
}

/** min / avg / max over the non-null values, or null when there are none. */
export function rttStats(values: Array<number | null>): NodeSummary {
  const xs = values.filter((v): v is number => v !== null);
  if (xs.length === 0) return { rttMs: null };
  const sum = xs.reduce((a, b) => a + b, 0);
  return {
    rttMs: {
      min: Math.round(Math.min(...xs) * 1000) / 1000,
      avg: Math.round((sum / xs.length) * 1000) / 1000,
      max: Math.round(Math.max(...xs) * 1000) / 1000,
    },
  };
}

const RESERVED_V4: Array<[string, number]> = [
  ["0.0.0.0", 8],
  ["10.0.0.0", 8],
  ["100.64.0.0", 10],
  ["127.0.0.0", 8],
  ["169.254.0.0", 16],
  ["172.16.0.0", 12],
  ["192.0.0.0", 24],
  ["192.0.2.0", 24],
  ["192.168.0.0", 16],
  ["198.18.0.0", 15],
  ["224.0.0.0", 4],
  ["240.0.0.0", 4],
];

const v4ToInt = (ip: string): number | null => {
  const parts = ip.split(".");
  if (parts.length !== 4) return null;
  let n = 0;
  for (const p of parts) {
    if (!/^\d{1,3}$/.test(p)) return null;
    const b = Number(p);
    if (b > 255) return null;
    n = (n << 8) | b;
  }
  return n >>> 0;
};

/**
 * Reject targets that would point probes at private/reserved space. Atlas
 * rejects some of these itself, but not all — and a public endpoint that lets
 * strangers aim thousands of probes is exactly where this must be enforced.
 */
export function assertPublicTarget(target: string): string {
  const t = target.trim().toLowerCase();
  if (!t) bad("'target' is required");
  if (t.length > 253) bad("'target' is too long");
  if (/[\s/\\?#@]/.test(t)) bad("'target' must be a hostname or IP address, not a URL");

  const v4 = v4ToInt(t);
  if (v4 !== null) {
    for (const [base, bits] of RESERVED_V4) {
      const mask = bits === 0 ? 0 : (0xffffffff << (32 - bits)) >>> 0;
      if ((v4 & mask) === ((v4ToInt(base) as number) & mask)) {
        bad(`'${target}' is in reserved address space and cannot be probed`);
      }
    }
    return t;
  }

  if (t.includes(":")) {
    // IPv6 literal: block loopback, unspecified, unique-local and link-local.
    if (t === "::1" || t === "::") bad(`'${target}' is in reserved address space and cannot be probed`);
    if (/^f[cd][0-9a-f]{2}:/.test(t) || /^fe[89ab][0-9a-f]:/.test(t)) {
      bad(`'${target}' is in reserved address space and cannot be probed`);
    }
    return t;
  }

  if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?(\.[a-z0-9]([a-z0-9-]*[a-z0-9])?)+$/.test(t)) {
    bad(`'${target}' is not a valid hostname`);
  }
  if (t === "localhost" || t.endsWith(".localhost") || t.endsWith(".local") || t.endsWith(".internal")) {
    bad(`'${target}' is not publicly resolvable`);
  }
  return t;
}
