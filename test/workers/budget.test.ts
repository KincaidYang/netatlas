import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";

/**
 * The platform's own ledger, in a real `workerd`.
 *
 * This is the other half of the `catch` that the caller's refund lives in, and
 * the half `d8e21f7` had to stop swallowing the other. Its reservations are
 * real money against a real account, so "did the release actually return it"
 * deserves better than reading the method.
 */

interface Reserve {
  ok: boolean;
  reason?: string;
  ticket?: string;
  remaining: number;
  limit: number;
}
interface State {
  spent: number;
  remaining: number;
  limit: number;
  inflight: number;
}

/** A fresh object per test, so one test's spend is not another's baseline. */
const budget = (name: string) => env.BUDGET.get(env.BUDGET.idFromName(name));

const get = async <T>(name: string, path: string): Promise<T> =>
  (await budget(name).fetch(`https://budget${path}`)).json<T>();

describe("DailyBudget", () => {
  it("reserves against the daily limit and reports what is left", async () => {
    const who = crypto.randomUUID();
    const before = await get<State>(who, "/state");
    const res = await get<Reserve>(who, "/reserve?credits=300");
    expect(res.ok).toBe(true);
    expect(res.ticket).toBeTruthy();

    const after = await get<State>(who, "/state");
    expect(after.spent).toBe(before.spent + 300);
    expect(after.remaining).toBe(before.remaining - 300);
    expect(after.inflight).toBe(1);
  });

  it("gives a reservation back, ledger and in-flight slot both", async () => {
    // The path `releaseCredits` takes when Atlas refuses the create. Leaving
    // either behind is a slow leak: the credits never come back, and the
    // in-flight cap fills with measurements that do not exist.
    const who = crypto.randomUUID();
    const res = await get<Reserve>(who, "/reserve?credits=300");
    const held = await get<State>(who, "/state");
    expect(held.inflight).toBe(1);

    await get(who, `/release?credits=300&ticket=${res.ticket}`);
    const after = await get<State>(who, "/state");
    expect(after.spent).toBe(0);
    expect(after.inflight).toBe(0);
  });

  it("never releases the ledger below zero", async () => {
    const who = crypto.randomUUID();
    const res = await get<Reserve>(who, "/reserve?credits=30");
    await get(who, `/release?credits=99999&ticket=${res.ticket}`);
    expect((await get<State>(who, "/state")).spent).toBe(0);
  });

  it("keeps the spend when a reservation becomes a measurement", async () => {
    // `markCreated` renames the in-flight slot after the measurement; the
    // credits stay spent, because by then they are.
    const who = crypto.randomUUID();
    const res = await get<Reserve>(who, "/reserve?credits=300");
    await get(who, `/created?ticket=${res.ticket}&id=12345&key=k`);
    const after = await get<State>(who, "/state");
    expect(after.spent).toBe(300);
    expect(after.inflight).toBe(1);

    await get(who, "/settle?id=12345");
    const settled = await get<State>(who, "/state");
    expect(settled.spent).toBe(300);
    expect(settled.inflight).toBe(0);
  });

  it("refuses a reservation that would cross the daily limit", async () => {
    const who = crypto.randomUUID();
    const limit = (await get<State>(who, "/state")).limit;
    const res = await get<Reserve>(who, `/reserve?credits=${limit + 1}`);
    expect(res.ok).toBe(false);
    expect((await get<State>(who, "/state")).spent).toBe(0);
  });

  it("hands one claim to one caller, so a duplicate waits instead of creating", async () => {
    // The second caller is told to wait, not refused: `pending` is what sends
    // it to `dedupePeek` for the id the first one is about to publish. My first
    // version of this test asserted `claimed: false` and failed — the shape was
    // mine to get wrong, not the code's.
    const who = crypto.randomUUID();
    type Claim = { claimed?: boolean; pending?: boolean; measurementId?: number };
    const first = await get<Claim>(who, "/dedupe?key=same");
    const second = await get<Claim>(who, "/dedupe?key=same");
    expect(first.claimed).toBe(true);
    expect(second.claimed).toBeUndefined();
    expect(second.pending).toBe(true);
  });

  it("publishes the measurement to whoever was waiting on the claim", async () => {
    const who = crypto.randomUUID();
    const res = await get<Reserve>(who, "/reserve?credits=30");
    await get(who, "/dedupe?key=shared");
    await get(who, `/created?ticket=${res.ticket}&id=777&key=shared`);
    // A later caller asking the same question gets the answer, not a new run.
    const again = await get<{ measurementId?: number }>(who, "/dedupe?key=shared");
    expect(again.measurementId).toBe(777);
  });
});
