/** Cloudflare Worker bindings. */
export interface Env {
  /** RIPE Atlas API key with credits. Set via `wrangler secret put ATLAS_API_KEY`. */
  ATLAS_API_KEY: string;
  /** Optional token guarding admin-only routes. */
  ADMIN_TOKEN?: string;
  /** Global public credit budget per day. Defaults to QUOTA.publicDailyCredits. */
  PUBLIC_DAILY_CREDITS?: string;
  /** Set to "1" only if RIPE has whitelisted this account for non-anchor HTTP. */
  ALLOW_ANY_HTTP_TARGET?: string;
  /** Durable Object keeping the node catalogue fresh. */
  CATALOG: DurableObjectNamespace;
  /** Per-caller token buckets, one instance per hashed identity. */
  RATE_LIMITER: DurableObjectNamespace;
  /** Single global instance: credit budget, in-flight cap, de-duplication. */
  BUDGET: DurableObjectNamespace;
}

/** `GET /measurements/<id>/` — the fields we actually read. */
export interface AtlasMeasurement {
  id: number;
  type?: string;
  target?: string;
  description?: string;
  af?: number;
  is_public?: boolean;
  query_argument?: string;
  query_type?: string;
  status?: { id: number; name: string };
}

/**
 * `GET /measurements/<id>/participation-requests/` — Atlas hands back the
 * original probe selection verbatim. Readable without auth, which is what
 * lets this service stay stateless: it *is* our record of what was requested.
 */
export interface AtlasParticipationRequest {
  action: string;
  /** "probes" | "asn" | "country" | "area" | "prefix" | "msm" */
  type: string;
  value: string;
  requested: number;
  tags_include: string[] | null;
  tags_exclude: string[] | null;
}

/** `GET /probes/?id__in=…` — probe metadata used to attribute results to nodes. */
export interface ProbeMeta {
  id: number;
  country_code?: string | null;
  asn_v4?: number | null;
  asn_v6?: number | null;
  status?: number;
}

/** One row of `GET /measurements/<id>/results/`. Shape varies per type. */
export interface AtlasResultRow {
  prb_id: number;
  from?: string;
  msm_id?: number;
  timestamp?: number;
  /** Top-level failure for this probe (measurement never ran). */
  error?: unknown;
  [key: string]: unknown;
}

/** `GET /anchors/` — targets for the (anchor-only) http measurement type. */
export interface AtlasAnchor {
  id: number;
  fqdn: string;
  city?: string;
  country?: string;
  ip_v4?: string | null;
  ip_v6?: string | null;
  is_disabled: boolean;
}

/** `GET /credits/` — used to reconcile the budget against real spend. */
export interface AtlasCredits {
  current_balance: number;
  max_daily_credits: number;
  estimated_daily_income: number;
  past_day_credits_spent: number;
  past_day_measurement_results: number;
}
