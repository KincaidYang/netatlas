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
  /** Give `credits` back to this caller's daily ledger; the token is not returned. */
  refund?: boolean;
  /**
   * The UTC day the charge landed on, echoed back from the `TakeResult` that
   * charged it. A refund is only valid against that ledger.
   */
  day?: string;
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
  /** The UTC day this charge was recorded against — pass back to refund it. */
  day: string;
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

    /**
     * Creation failed after the credits were charged: give them back.
     *
     * The global budget already had this — `releaseCredits` returns the
     * reservation — while the caller's own daily allowance did not, so a
     * measurement Atlas refused was billed to the person who asked for it and
     * to nobody else. Five unresolvable targets put 15 credits on an anonymous
     * caller's 5,000 for measurements that never existed.
     *
     * The token is deliberately not returned. A rejected request still made us
     * resolve nodes against Atlas, and refunding it would make a flood of bad
     * targets free.
     */
    if (req.refund) {
      const rec = await this.state.storage.get<{ day: string; credits: number }>("spent");
      // Only against the ledger that was actually charged.
      //
      // The first version refunded whatever day it happened to be called on. A
      // create charged at 23:59:59 and rejected at 00:00:01 then subtracted its
      // credits from the *new* day — and if the caller had already spent on
      // that day, the refund handed back allowance nobody had paid for. The
      // charged day now rides on the TakeResult and comes back here; a refund
      // whose day has already rolled over is simply dropped, because the ledger
      // it belonged to is gone and reset to zero anyway.
      const stale = !req.day || rec?.day !== req.day;
      const credits = stale ? (rec?.credits ?? 0) : Math.max(0, rec!.credits - Math.max(req.credits, 0));
      if (!stale) await this.state.storage.put("spent", { day: req.day, credits });
      return Response.json({
        ok: true,
        retryAfterSec: 0,
        remaining: 0,
        capacity: 0,
        creditsUsedToday: credits,
        creditsLimit: 0,
        day: rec?.day ?? dayKey(Date.now()),
      });
    }

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
      day: today,
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
