import { QUOTA, bucketFor, dayKey, type Tier } from "./quota";

interface Bucket {
  tokens: number;
  /** ms timestamp of the last refill. */
  at: number;
}

export interface TakeRequest {
  tier: Tier;
  type: string;
  credits: number;
  /** Check only — used by GET /quota so a status peek costs nothing. */
  peek?: boolean;
}

export interface TakeResult {
  ok: boolean;
  reason?: "rate" | "daily-credits";
  retryAfterSec: number;
  /** Tokens left in the bucket this measurement type draws from. */
  remaining: number;
  capacity: number;
  creditsUsedToday: number;
  creditsLimit: number;
}

/**
 * Per-caller token buckets, one Durable Object per identity (hashed IP, or
 * hashed API key for BYOK). Durable Objects give exact counting; KV or the
 * Cache API would let a burst slip through in the eventual-consistency window,
 * and every slipped request is real money off the Atlas account.
 */
export class RateLimiter implements DurableObject {
  constructor(
    private readonly state: DurableObjectState,
    private readonly env: unknown,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const req = (await request.json()) as TakeRequest;
    const policy = QUOTA[req.tier] ?? QUOTA.anon;
    const { name, spec } = bucketFor(req.tier, req.type);
    const now = Date.now();

    const stored = await this.state.storage.get<Bucket>(`bucket:${name}`);
    const bucket = refill(stored ?? { tokens: spec.capacity, at: now }, spec, now);

    const today = dayKey(now);
    const spentRecord = await this.state.storage.get<{ day: string; credits: number }>("spent");
    const spent = spentRecord?.day === today ? spentRecord.credits : 0;

    const overDaily =
      policy.dailyCredits > 0 && spent + Math.max(req.credits, 0) > policy.dailyCredits;
    const noTokens = bucket.tokens < 1;

    const result: TakeResult = {
      ok: !noTokens && !overDaily,
      retryAfterSec: 0,
      remaining: Math.floor(bucket.tokens),
      capacity: spec.capacity,
      creditsUsedToday: spent,
      creditsLimit: policy.dailyCredits,
    };

    if (noTokens) {
      result.reason = "rate";
      result.retryAfterSec = Math.ceil((1 - bucket.tokens) * spec.refillSeconds);
    } else if (overDaily) {
      result.reason = "daily-credits";
      // Everything resets at the UTC day boundary.
      result.retryAfterSec = Math.ceil((Date.parse(`${today}T23:59:59Z`) - now) / 1000) + 1;
    }

    if (result.ok && !req.peek) {
      bucket.tokens -= 1;
      result.remaining = Math.floor(bucket.tokens);
      await this.state.storage.put({
        [`bucket:${name}`]: bucket,
        spent: { day: today, credits: spent + Math.max(req.credits, 0) },
      });
      result.creditsUsedToday = spent + Math.max(req.credits, 0);
    } else if (!req.peek) {
      // Persist the refill so the clock keeps advancing even on rejection.
      await this.state.storage.put(`bucket:${name}`, bucket);
    }

    return Response.json(result);
  }
}

function refill(bucket: Bucket, spec: { capacity: number; refillSeconds: number }, now: number): Bucket {
  const elapsedSec = Math.max(0, (now - bucket.at) / 1000);
  const gained = elapsedSec / spec.refillSeconds;
  return { tokens: Math.min(spec.capacity, bucket.tokens + gained), at: now };
}
