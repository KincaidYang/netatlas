import { HTTPException } from "hono/http-exception";
import type { MeasurementKind } from "./kind";
import { dns } from "./dnsKind";
import { ping } from "./ping";
import { traceroute } from "./traceroute";
import { sslcert } from "./sslcert";
import { http } from "./http";
import { ntp } from "./ntp";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
const ALL = [ping, dns, traceroute, sslcert, http, ntp] as unknown as Array<MeasurementKind<any>>;

export const KINDS = new Map(ALL.map((k) => [k.type, k]));
export const KIND_TYPES = ALL.map((k) => k.type);

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export function kindFor(type: unknown): MeasurementKind<any> {
  const key = String(type ?? "").toLowerCase();
  const kind = KINDS.get(key);
  if (!kind) {
    throw new HTTPException(400, {
      message: `unknown measurement type '${key || "(none)"}'. Supported: ${KIND_TYPES.join(", ")}`,
    });
  }
  return kind;
}

export type { MeasurementKind, ProbeOutcome, NodeSummary } from "./kind";
export { SUPPORTED_QUERY_TYPES } from "./dnsKind";
export { ANCHOR_SUFFIX } from "./http";
