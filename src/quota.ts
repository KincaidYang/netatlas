/**
 * Every number that decides "how much of my Atlas account can a stranger
 * spend" lives here. Nothing else in the codebase should hard-code a limit.
 *
 * Sizing, from the real account: it holds ~30M credits and earns ~141k-163k
 * per day from the probes/anchors it hosts. The public budget is deliberately
 * set *below* the daily income, so the service runs on interest and the
 * principal never shrinks. Atlas's own account ceiling is 10M/day, two orders
 * of magnitude above us — we will never approach it.
 *
 * Per-probe credit costs (all verified against real spend):
 *   ping 3 · dns 10 (TCP 20) · sslcert 10 · http 20 · ntp 20 · traceroute 30
 */

export type Tier = "anon" | "byok";

export interface BucketSpec {
  capacity: number;
  /** Seconds to regain one token. */
  refillSeconds: number;
}

export interface TierPolicy {
  /** Every measurement takes a token from here. */
  job: BucketSpec;
  /** Traceroute is 10x the cost of ping, so it gets its own tighter bucket. */
  traceroute: BucketSpec;
  maxNodes: number;
  maxPerNode: number;
  /**
   * Ceiling on nodes x probes for one measurement. Nodes alone do not bound
   * the cost — 50 nodes at three probes each is 150 probes, five times the
   * same 50 nodes at one.
   */
  maxProbes: number;
  /** 0 = unmetered (the caller is spending their own credits). */
  dailyCredits: number;
  countsAgainstGlobalBudget: boolean;
}

export const QUOTA: Record<Tier, TierPolicy> = {
  anon: {
    job: { capacity: 5, refillSeconds: 120 },
    traceroute: { capacity: 2, refillSeconds: 300 },
    // Must be >= the largest shipped preset, or the console's default
    // selection is rejected before it can create anything.
    maxNodes: 50,
    maxPerNode: 2,
    // Level with maxNodes: a full 50-node selection gets one probe each, and
    // fewer nodes buy depth instead. 50 ping probes is 150 credits against a
    // 120,000/day public budget; 50 traceroute probes is 1,500.
    maxProbes: 50,
    dailyCredits: 5000,
    countsAgainstGlobalBudget: true,
  },
  byok: {
    job: { capacity: 20, refillSeconds: 15 },
    traceroute: { capacity: 10, refillSeconds: 30 },
    // A BYOK caller spends their own credits, so we do not ration their
    // breadth: this is the structural ceiling (MAX_NODES), not a tier policy.
    // What remains capped is the work *we* do on their behalf — every extra
    // node is another Atlas lookup and another probe group in one request.
    maxNodes: 50,
    maxPerNode: 3,
    // 50 nodes x 3 probes. They are paying for it.
    maxProbes: 150,
    dailyCredits: 0,
    countsAgainstGlobalBudget: false,
  },
};

/** Shared pot for anonymous callers, per UTC day. Override with PUBLIC_DAILY_CREDITS. */
export const DEFAULT_PUBLIC_DAILY_CREDITS = 120_000;

/**
 * Cap on measurements we have created but not seen finish. Atlas enforces an
 * undocumented per-account concurrency limit; staying well under it means we
 * fail our own callers politely instead of being cut off upstream.
 */
export const MAX_INFLIGHT = 20;

/** Identical requests inside this window reuse the existing measurement. */
export const DEDUPE_WINDOW_SEC = 60;

/** How often to reconcile the local ledger against Atlas's real spend. */
export const RECONCILE_INTERVAL_MS = 10 * 60 * 1000;

export const bucketFor = (tier: Tier, type: string): { name: string; spec: BucketSpec } =>
  type === "traceroute"
    ? { name: "traceroute", spec: QUOTA[tier].traceroute }
    : { name: "job", spec: QUOTA[tier].job };

export const publicDailyCredits = (raw: string | undefined): number => {
  // A declared-but-empty variable arrives as "", and Number("") is 0 — which
  // would silently set the public budget to nothing and 503 every anonymous
  // caller. Only an explicit number counts as an override.
  if (raw === undefined || raw.trim() === "") return DEFAULT_PUBLIC_DAILY_CREDITS;
  const n = Number(raw);
  return Number.isFinite(n) && n >= 0 ? n : DEFAULT_PUBLIC_DAILY_CREDITS;
};

/** UTC day key; budgets and per-caller credit caps both reset on it. */
export const dayKey = (now = Date.now()): string => new Date(now).toISOString().slice(0, 10);

export async function sha256Hex(input: string): Promise<string> {
  const data = new TextEncoder().encode(input);
  const digest = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
