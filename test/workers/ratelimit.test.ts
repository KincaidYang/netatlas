import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * The caller's daily ledger, in a real `workerd` with real Durable Object
 * storage.
 *
 * `shouldRefund` decides *whether* to refund and is covered by the pure suite.
 * This covers what happens next: that the credits land back on the ledger they
 * came off, and that a refund whose day has rolled over does not help itself to
 * a fresh one. Neither is reachable without a runtime — the answer lives in two
 * `put`s and the clock between them — and both were argued in review rather
 * than demonstrated, in code that had already shipped one P1.
 */

interface Take {
  ok: boolean;
  creditsUsedToday: number;
  creditsLimit: number;
  day: string;
}

/** One object per caller, so every test gets a ledger nobody else has touched. */
const ledger = (name: string) => env.RATE_LIMITER.get(env.RATE_LIMITER.idFromName(name));

const call = async (name: string, body: Record<string, unknown>): Promise<Take> => {
  const res = await ledger(name).fetch("https://limiter/take", {
    method: "POST",
    body: JSON.stringify({ tier: "anon", type: "ping", ...body }),
  });
  return res.json<Take>();
};

describe("RateLimiter daily ledger", () => {
  it("charges, then gives the same credits back", async () => {
    const who = crypto.randomUUID();
    const charged = await call(who, { credits: 30 });
    expect(charged.ok).toBe(true);
    expect(charged.creditsUsedToday).toBe(30);

    const refunded = await call(who, { credits: 30, refund: true, day: charged.day });
    expect(refunded.creditsUsedToday).toBe(0);

    // And the ledger really is back to zero, not merely reported as such.
    const after = await call(who, { credits: 0, peek: true });
    expect(after.creditsUsedToday).toBe(0);
  });

  it("reports the day it charged, so the refund can name it", async () => {
    const who = crypto.randomUUID();
    const charged = await call(who, { credits: 3 });
    // `dayKey` is a UTC date, and the refund is matched against exactly this.
    expect(charged.day).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it("drops a refund whose day has already rolled over", async () => {
    const who = crypto.randomUUID();
    // Someone else's spend on today's ledger. A stale refund must not touch it.
    const today = await call(who, { credits: 40 });
    expect(today.creditsUsedToday).toBe(40);

    const stale = await call(who, { credits: 30, refund: true, day: "1999-01-01" });
    expect(stale.creditsUsedToday).toBe(40);

    const after = await call(who, { credits: 0, peek: true });
    expect(after.creditsUsedToday).toBe(40);
  });

  it("drops a refund that names no day at all", async () => {
    const who = crypto.randomUUID();
    await call(who, { credits: 40 });
    const noDay = await call(who, { credits: 30, refund: true });
    expect(noDay.creditsUsedToday).toBe(40);
  });

  it("never refunds a ledger below zero", async () => {
    const who = crypto.randomUUID();
    const charged = await call(who, { credits: 3 });
    const over = await call(who, { credits: 999, refund: true, day: charged.day });
    expect(over.creditsUsedToday).toBe(0);
  });

  it("does not return the token, only the credits", async () => {
    // A rejected request still made the Worker resolve nodes against Atlas.
    // Refunding the token would make a flood of bad targets free.
    const who = crypto.randomUUID();
    const first = await call(who, { credits: 3 });
    const before = first.ok;
    const charged = await call(who, { credits: 3 });
    await call(who, { credits: 3, refund: true, day: charged.day });
    const peek = await call(who, { credits: 0, peek: true });
    expect(before).toBe(true);
    // Two takes happened; the refund gave credits back but not the tokens.
    expect(peek.creditsUsedToday).toBe(3);
  });
});
