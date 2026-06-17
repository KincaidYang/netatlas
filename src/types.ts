export interface Env {
  /** RIPE Atlas API key with credits. Set via `wrangler secret put ATLAS_API_KEY`. */
  ATLAS_API_KEY: string;
  /** Optional bearer token guarding the API. If set, callers must send it. */
  API_TOKEN?: string;
}

/** A single result row from `GET /measurements/<id>/results/` for a DNS measurement. */
export interface AtlasDnsResult {
  prb_id: number;
  from?: string;
  /** Present when the probe queried a single resolver. */
  result?: AtlasDnsAnswerBlock;
  /** Present when the probe queried multiple local resolvers (use_probe_resolver). */
  resultset?: Array<{
    dst_addr?: string;
    result?: AtlasDnsAnswerBlock;
    error?: unknown;
  }>;
  /** Top-level error (e.g. the whole measurement failed on this probe). */
  error?: unknown;
}

export interface AtlasDnsAnswerBlock {
  /** Round-trip time in ms. */
  rt?: number;
  /** Base64-encoded raw DNS response message. */
  abuf?: string;
}

export interface AtlasMeasurement {
  id: number;
  description?: string;
  status?: { id: number; name: string };
}

export interface ProbeMeta {
  country_code?: string;
  asn_v4?: number | null;
  asn_v6?: number | null;
}
