import type { BudgetState, DedupeClaim, ReserveResult } from "./budget";
import { QUOTA, sha256Hex, type Tier } from "./quota";
import type { TakeResult } from "./ratelimit";
import type { Env } from "./types";

export interface Caller {
  tier: Tier;
  /** Hashed identity — never the raw IP or key. */
  id: string;
  /** The Atlas key this caller's measurements are billed to. */
  atlasKey: string;
  usingOwnKey: boolean;
}

/**
 * Who is asking, and whose credits pay for it.
 *
 * Bring-your-own-key callers get the looser tier because they are spending
 * their own Atlas credits, not the public pot. We only ever keep a hash of the
 * key — enough to give them a stable bucket, useless to anyone who reads our
 * storage or logs.
 */
export async function identify(request: Request, env: Env): Promise<Caller> {
  const own = request.headers.get("X-Atlas-Key")?.trim();
  if (own) {
    return { tier: "byok", id: `byok:${await sha256Hex(own)}`, atlasKey: own, usingOwnKey: true };
  }
  const ip = request.headers.get("CF-Connecting-IP") ?? "local";
  return { tier: "anon", id: `anon:${await sha256Hex(ip)}`, atlasKey: env.ATLAS_API_KEY, usingOwnKey: false };
}

const limiter = (env: Env, caller: Caller) => env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(caller.id));
export const budget = (env: Env) => env.BUDGET.get(env.BUDGET.idFromName("v1"));

/** Take (or peek at) this caller's token for a measurement of `type`. */
export async function rateCheck(
  env: Env,
  caller: Caller,
  type: string,
  credits: number,
  peek = false,
): Promise<TakeResult> {
  const res = await limiter(env, caller).fetch("https://limiter/take", {
    method: "POST",
    body: JSON.stringify({ tier: caller.tier, type, credits, peek }),
  });
  return res.json<TakeResult>();
}

export async function reserveCredits(env: Env, credits: number): Promise<ReserveResult> {
  const res = await budget(env).fetch(`https://budget/reserve?credits=${credits}`);
  return res.json<ReserveResult>();
}

/**
 * Undo a reservation Atlas refused. Also drops the de-duplication claim, so a
 * request waiting behind this one stops waiting for a measurement that will
 * never exist.
 */
export async function releaseCredits(
  env: Env,
  credits: number,
  ticket: string | undefined,
  key: string,
): Promise<void> {
  const q = new URLSearchParams({ credits: String(credits), key });
  if (ticket) q.set("ticket", ticket);
  await budget(env).fetch(`https://budget/release?${q}`);
}

/** Creation succeeded: name the in-flight slot after the measurement and publish it for de-duplication. */
export async function markCreated(
  env: Env,
  ticket: string | undefined,
  measurementId: number,
  key: string,
): Promise<void> {
  const q = new URLSearchParams({ id: String(measurementId), key });
  if (ticket) q.set("ticket", ticket);
  await budget(env).fetch(`https://budget/created?${q}`);
}

/**
 * Free the in-flight slot of a measurement that has stopped.
 *
 * Idempotent, because the only place we reliably learn a measurement finished
 * is someone loading its results — which may happen any number of times, or
 * never (the TTL sweep is the backstop for that).
 */
export async function settleMeasurement(env: Env, measurementId: number): Promise<void> {
  await budget(env).fetch(`https://budget/settle?id=${measurementId}`);
}

export async function budgetState(env: Env): Promise<BudgetState> {
  const res = await budget(env).fetch("https://budget/state");
  return res.json<BudgetState>();
}

/**
 * Ask for the right to create this exact measurement.
 *
 * Returns the existing measurement if an identical one was created recently,
 * `pending` if another request is creating it right now, or `claimed` if this
 * caller should go ahead. Lookup and claim are one call so that two concurrent
 * identical requests cannot both miss and both spend credits.
 */
export async function dedupeClaim(env: Env, key: string): Promise<DedupeClaim> {
  const res = await budget(env).fetch(`https://budget/dedupe?key=${encodeURIComponent(key)}`);
  return res.json<DedupeClaim>();
}

/** Read-only check, for waiting on whoever holds the claim. */
export async function dedupePeek(env: Env, key: string): Promise<number | null> {
  const res = await budget(env).fetch(`https://budget/dedupe/peek?key=${encodeURIComponent(key)}`);
  return (await res.json<{ measurementId?: number }>()).measurementId ?? null;
}

/** Stable fingerprint of "the same question", so two callers share one answer. */
export const dedupeKey = (
  type: string,
  params: unknown,
  nodes: string[],
  perNode: number,
): Promise<string> => sha256Hex(JSON.stringify([type, params, [...nodes].sort(), perNode]));

const RATE_MESSAGES: Record<string, string> = {
  rate: "太快了，稍后再试",
  "daily-credits": "今日额度已用完（匿名用户每天有限），可在设置里填入自己的 RIPE Atlas Key 解除限制",
};

/**
 * Carries its own response so the Retry-After header and the quota fields
 * survive. Hono's HTTPException loses a custom response once the error handler
 * re-serialises it, and a 429 without Retry-After is useless to a client.
 */
export class QuotaError extends Error {
  constructor(readonly response: Response) {
    super("quota");
    this.name = "QuotaError";
  }
}

export function rejectRate(result: TakeResult, tier: Tier): never {
  throw new QuotaError(
    quotaResponse(429, {
      error: RATE_MESSAGES[result.reason ?? "rate"],
      reason: result.reason,
      retryAfterSec: result.retryAfterSec,
      tokensLeft: result.remaining,
      tokenCapacity: result.capacity,
      creditsUsedToday: result.creditsUsedToday,
      creditsLimit: result.creditsLimit || null,
      tier,
      hint: tier === "anon" ? "带上 X-Atlas-Key 头使用自己的 Atlas 额度" : undefined,
    }, result.retryAfterSec),
  );
}

export function rejectBudget(result: ReserveResult): never {
  const message =
    result.reason === "inflight"
      ? "同时进行的拨测过多，请稍候"
      : "今天的公共额度已经用完了，可在设置里填入自己的 RIPE Atlas Key 继续使用";
  throw new QuotaError(
    quotaResponse(503, {
      error: message,
      reason: result.reason,
      retryAfterSec: result.retryAfterSec,
      creditsRemaining: result.remaining,
      creditsLimit: result.limit,
      hint: "带上 X-Atlas-Key 头使用自己的 Atlas 额度",
    }, result.retryAfterSec),
  );
}

function quotaResponse(status: number, body: unknown, retryAfterSec: number): Response {
  return Response.json(body, {
    status,
    headers: {
      "Retry-After": String(Math.max(1, retryAfterSec)),
      "Cache-Control": "no-store",
    },
  });
}

export { QUOTA };
