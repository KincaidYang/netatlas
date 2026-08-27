import { AtlasClient } from "./atlas";
import { DEDUPE_WINDOW_SEC, MAX_INFLIGHT, RECONCILE_INTERVAL_MS, dayKey, publicDailyCredits } from "./quota";
import type { Env } from "./types";

interface Ledger {
  day: string;
  /** Credits we believe we have spent today. */
  spent: number;
  /** Creation timestamps of measurements still assumed to be running. */
  inflight: number[];
}

/** One-off measurements always finish well inside this; stale entries expire. */
const INFLIGHT_TTL_MS = 10 * 60 * 1000;

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
        return Response.json(await this.release(Number(url.searchParams.get("credits") ?? 0)));
      case "/settle":
        return Response.json(await this.settle());
      case "/state":
        return Response.json(await this.snapshot());
      case "/dedupe":
        return Response.json(await this.dedupe(url.searchParams.get("key") ?? "", url.searchParams.get("id")));
      default:
        return new Response("not found", { status: 404 });
    }
  }

  private async ledger(): Promise<Ledger> {
    const today = dayKey();
    const stored = await this.state.storage.get<Ledger>("ledger");
    const cutoff = Date.now() - INFLIGHT_TTL_MS;
    // Self-expiring rather than explicitly settled: a client that never comes
    // back to read its results must not leak a slot forever.
    const inflight = (stored?.inflight ?? []).filter((t) => t > cutoff);
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

    if (ledger.inflight.length >= MAX_INFLIGHT) {
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

    const next: Ledger = {
      ...ledger,
      spent: ledger.spent + Math.max(credits, 0),
      inflight: [...ledger.inflight, Date.now()],
    };
    await this.state.storage.put("ledger", next);
    return { ok: true, retryAfterSec: 0, remaining: Math.max(0, limit - (spent + credits)), limit };
  }

  /** Give the credits back when Atlas refused to create the measurement. */
  private async release(credits: number): Promise<{ ok: true }> {
    const ledger = await this.ledger();
    await this.state.storage.put("ledger", {
      ...ledger,
      spent: Math.max(0, ledger.spent - Math.max(credits, 0)),
      inflight: ledger.inflight.slice(0, -1),
    });
    return { ok: true };
  }

  private async settle(): Promise<{ ok: true }> {
    const ledger = await this.ledger();
    await this.state.storage.put("ledger", { ...ledger, inflight: ledger.inflight.slice(0, -1) });
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
      inflight: ledger.inflight.length,
      atlasSpent: rec?.atlasSpent ?? null,
      atlasBalance: rec?.balance ?? null,
      reconciledAt: rec ? new Date(rec.checkedAt).toISOString() : null,
    };
  }

  /**
   * Identical request inside the window? Hand back the measurement we already
   * created instead of buying a second copy of the same answer.
   */
  private async dedupe(key: string, id: string | null): Promise<{ measurementId: number | null }> {
    if (!key) return { measurementId: null };
    const storageKey = `dedupe:${key}`;
    if (id) {
      await this.state.storage.put(storageKey, { id: Number(id), at: Date.now() });
      return { measurementId: Number(id) };
    }
    const hit = await this.state.storage.get<{ id: number; at: number }>(storageKey);
    if (!hit || Date.now() - hit.at > DEDUPE_WINDOW_SEC * 1000) {
      if (hit) await this.state.storage.delete(storageKey);
      return { measurementId: null };
    }
    return { measurementId: hit.id };
  }
}
