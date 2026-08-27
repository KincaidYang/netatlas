import { AtlasClient } from "./atlas";
import { DEDUPE_WINDOW_SEC, MAX_INFLIGHT, RECONCILE_INTERVAL_MS, dayKey, publicDailyCredits } from "./quota";
import type { Env } from "./types";

interface Ledger {
  day: string;
  /** Credits we believe we have spent today. */
  spent: number;
  /**
   * Measurements still assumed to be running, as slot → reservation time.
   * Keyed `t:<ticket>` between reserving credits and knowing the measurement
   * id, then `m:<id>` afterwards, so releasing a finished measurement is
   * idempotent no matter how many times its result page is loaded.
   */
  inflight: Record<string, number>;
}

/** Backstop for slots nobody ever released; one-off measurements finish long before. */
const INFLIGHT_TTL_MS = 10 * 60 * 1000;
/** How long one caller may hold an unfinished de-duplication claim. */
const CLAIM_TTL_MS = 20 * 1000;

interface Reconciliation {
  /** Atlas's own `past_day_credits_spent`, the authority. */
  atlasSpent: number;
  checkedAt: number;
  balance: number;
}

export interface BudgetState {
  day: string;
  limit: number;
  spent: number;
  remaining: number;
  inflight: number;
  atlasSpent: number | null;
  atlasBalance: number | null;
  reconciledAt: string | null;
}

export interface ReserveResult {
  ok: boolean;
  reason?: "budget" | "inflight";
  retryAfterSec: number;
  remaining: number;
  limit: number;
  /** Identifies this reservation until the measurement id is known. */
  ticket?: string;
}

export interface DedupeClaim {
  /** An identical request finished recently; reuse its measurement. */
  measurementId?: number;
  /** Another request is creating this exact measurement right now. */
  pending?: boolean;
  /** This caller owns the claim and should go ahead and create. */
  claimed?: boolean;
}

/**
 * The global spend gate: one instance for the whole service.
 *
 * It keeps a local ledger for speed, but the authority is Atlas itself —
 * `past_day_credits_spent` is reconciled every few minutes and the *larger* of
 * the two is what counts. That way a wrong per-probe cost estimate (or someone
 * spending the same account elsewhere) can never quietly drain the account:
 * the breaker trips on real spend, not on our arithmetic.
 *
 * It also owns request de-duplication and the in-flight cap, because both need
 * the same single, global view.
 */
export class DailyBudget implements DurableObject {
  private reconciling: Promise<void> | null = null;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: Env,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    switch (url.pathname) {
      case "/reserve":
        return Response.json(await this.reserve(Number(url.searchParams.get("credits") ?? 0)));
      case "/release":
        return Response.json(
          await this.release(
            Number(url.searchParams.get("credits") ?? 0),
            url.searchParams.get("ticket"),
            url.searchParams.get("key"),
          ),
        );
      case "/created":
        return Response.json(
          await this.created(
            url.searchParams.get("ticket"),
            Number(url.searchParams.get("id") ?? 0),
            url.searchParams.get("key") ?? "",
          ),
        );
      case "/settle":
        return Response.json(await this.settle(Number(url.searchParams.get("id") ?? 0)));
      case "/state":
        return Response.json(await this.snapshot());
      case "/dedupe":
        return Response.json(await this.claim(url.searchParams.get("key") ?? ""));
      case "/dedupe/peek":
        return Response.json(await this.peek(url.searchParams.get("key") ?? ""));
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private async ledger(): Promise<Ledger> {
    const today = dayKey();
    const stored = await this.state.storage.get<Ledger>("ledger");
    const cutoff = Date.now() - INFLIGHT_TTL_MS;
    // Slots are released explicitly when a measurement is seen to stop; this
    // only sweeps up after callers who never came back to read their results.
    const inflight = Object.fromEntries(
      Object.entries(stored?.inflight ?? {}).filter(([, at]) => at > cutoff),
    );
    if (stored?.day === today) return { ...stored, inflight };
    return { day: today, spent: 0, inflight };
  }

  private limit(): number {
    return publicDailyCredits(this.env.PUBLIC_DAILY_CREDITS);
  }

  /** Effective spend = the worse of what we counted and what Atlas billed. */
  private async effectiveSpent(ledger: Ledger): Promise<number> {
    const rec = await this.state.storage.get<Reconciliation>("reconciliation");
    this.maybeReconcile(rec);
    return Math.max(ledger.spent, rec?.atlasSpent ?? 0);
  }

  private maybeReconcile(rec: Reconciliation | undefined): void {
    if (this.reconciling) return;
    if (rec && Date.now() - rec.checkedAt < RECONCILE_INTERVAL_MS) return;
    if (!this.env.ATLAS_API_KEY) return;
    this.reconciling = this.reconcile().finally(() => {
      this.reconciling = null;
    });
    this.state.waitUntil(this.reconciling);
  }

  private async reconcile(): Promise<void> {
    try {
      const credits = await new AtlasClient(this.env.ATLAS_API_KEY).getCredits();
      await this.state.storage.put("reconciliation", {
        atlasSpent: credits.past_day_credits_spent ?? 0,
        balance: credits.current_balance ?? 0,
        checkedAt: Date.now(),
      } satisfies Reconciliation);
    } catch {
      // Keep serving on the local ledger; we retry on the next request.
    }
  }

  private async reserve(credits: number): Promise<ReserveResult> {
    const ledger = await this.ledger();
    const limit = this.limit();
    const spent = await this.effectiveSpent(ledger);

    if (Object.keys(ledger.inflight).length >= MAX_INFLIGHT) {
      return { ok: false, reason: "inflight", retryAfterSec: 30, remaining: Math.max(0, limit - spent), limit };
    }
    if (credits > 0 && spent + credits > limit) {
      const reset = Date.parse(`${ledger.day}T23:59:59Z`) - Date.now();
      return {
        ok: false,
        reason: "budget",
        retryAfterSec: Math.max(1, Math.ceil(reset / 1000)),
        remaining: Math.max(0, limit - spent),
        limit,
      };
    }

    const ticket = crypto.randomUUID();
    const next: Ledger = {
      ...ledger,
      spent: ledger.spent + Math.max(credits, 0),
      inflight: { ...ledger.inflight, [`t:${ticket}`]: Date.now() },
    };
    await this.state.storage.put("ledger", next);
    return { ok: true, ticket, retryAfterSec: 0, remaining: Math.max(0, limit - (spent + credits)), limit };
  }

  /** Give the credits back when Atlas refused to create the measurement. */
  private async release(credits: number, ticket: string | null, key: string | null): Promise<{ ok: true }> {
    const ledger = await this.ledger();
    const inflight = { ...ledger.inflight };
    if (ticket) delete inflight[`t:${ticket}`];
    await this.state.storage.put("ledger", {
      ...ledger,
      spent: Math.max(0, ledger.spent - Math.max(credits, 0)),
      inflight,
    });
    // Do not leave anyone waiting on a claim that will never be fulfilled.
    if (key) await this.state.storage.delete(`claim:${key}`);
    return { ok: true };
  }

  /** Creation succeeded: name the in-flight slot and publish the dedupe entry. */
  private async created(ticket: string | null, id: number, key: string): Promise<{ ok: true }> {
    const ledger = await this.ledger();
    const inflight = { ...ledger.inflight };
    if (ticket) delete inflight[`t:${ticket}`];
    if (id) inflight[`m:${id}`] = Date.now();
    await this.state.storage.put("ledger", { ...ledger, inflight });
    if (key && id) {
      await this.state.storage.put(`done:${key}`, { id, at: Date.now() });
      await this.state.storage.delete(`claim:${key}`);
    }
    return { ok: true };
  }

  /** Idempotent: the result page may be loaded any number of times. */
  private async settle(id: number): Promise<{ ok: true }> {
    if (!id) return { ok: true };
    const ledger = await this.ledger();
    if (!(`m:${id}` in ledger.inflight)) return { ok: true };
    const inflight = { ...ledger.inflight };
    delete inflight[`m:${id}`];
    await this.state.storage.put("ledger", { ...ledger, inflight });
    return { ok: true };
  }

  private async snapshot(): Promise<BudgetState> {
    const ledger = await this.ledger();
    const rec = await this.state.storage.get<Reconciliation>("reconciliation");
    this.maybeReconcile(rec);
    const limit = this.limit();
    const spent = Math.max(ledger.spent, rec?.atlasSpent ?? 0);
    return {
      day: ledger.day,
      limit,
      spent,
      remaining: Math.max(0, limit - spent),
      inflight: Object.keys(ledger.inflight).length,
      atlasSpent: rec?.atlasSpent ?? null,
      atlasBalance: rec?.balance ?? null,
      reconciledAt: rec ? new Date(rec.checkedAt).toISOString() : null,
    };
  }

  /**
   * Identical request inside the window? Hand back the measurement we already
   * created instead of buying a second copy of the same answer.
   *
   * Looking up and claiming happen in one call because creation takes seconds:
   * a plain read-then-write would let two concurrent identical requests both
   * miss and both spend credits — exactly the burst de-duplication exists for.
   * Durable Objects are single-threaded, so this claim is atomic.
   */
  private async claim(key: string): Promise<DedupeClaim> {
    if (!key) return {};
    const done = await this.peek(key);
    if (done.measurementId) return done;

    const held = await this.state.storage.get<number>(`claim:${key}`);
    if (held && Date.now() - held < CLAIM_TTL_MS) return { pending: true };

    await this.state.storage.put(`claim:${key}`, Date.now());
    return { claimed: true };
  }

  private async peek(key: string): Promise<{ measurementId?: number }> {
    if (!key) return {};
    const hit = await this.state.storage.get<{ id: number; at: number }>(`done:${key}`);
    if (!hit) return {};
    if (Date.now() - hit.at > DEDUPE_WINDOW_SEC * 1000) {
      await this.state.storage.delete(`done:${key}`);
      return {};
    }
    return { measurementId: hit.id };
  }
}
