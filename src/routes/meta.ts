import { Hono } from "hono";
import { AtlasClient } from "../atlas";
import type { CatalogSnapshot } from "../catalog";
import { QUOTA, budgetState, identify, rateCheck } from "../gate";
import { KINDS, SUPPORTED_QUERY_TYPES } from "../measurements";
import { NODE_PRESETS, SEED_NODES } from "../nodes";
import type { Env } from "../types";

export const meta = new Hono<{ Bindings: Env }>();

/**
 * The catalogue lives in a Durable Object that re-sweeps Atlas on a TTL.
 * Hitting this endpoint *triggers* a refresh but never waits for one, so the
 * response is instant and Atlas sees one sweep per TTL, not one per visitor.
 */
meta.get("/nodes", async (c) => {
  const url = new URL(c.req.url);
  const force =
    url.searchParams.get("force") === "1" &&
    !!c.env.ADMIN_TOKEN &&
    c.req.header("X-Admin-Token") === c.env.ADMIN_TOKEN;

  // This is the slowest request the console makes — a Durable Object round
  // trip on every page load — and the catalogue behind it only moves on a 3h
  // TTL. A short edge cache costs nothing in freshness and takes it off the
  // critical path. Probe counts here are a display hint anyway; the truth is
  // the `available` / `unavailable` a real request comes back with.
  const cache = caches.default;
  const cacheKey = new Request(url.toString(), { method: "GET" });
  if (!force) {
    const hit = await cache.match(cacheKey);
    if (hit) return hit;
  }

  // `q` searches every country×operator pair Atlas has a probe in (~5,000),
  // not the ~240 the catalogue curates. A node id is self-describing, so a hit
  // here is selectable even though the catalogue never listed it.
  const query = url.searchParams.get("q")?.trim() ?? "";
  const stub = c.env.CATALOG.get(c.env.CATALOG.idFromName("v1"));
  const params = new URLSearchParams();
  if (force) params.set("force", "1");
  if (query) params.set("q", query);
  const snapshot = await (
    await stub.fetch(`https://catalog/nodes${params.size ? `?${params}` : ""}`)
  ).json<CatalogSnapshot>();

  if (query) {
    // Search results are per-query and cheap to recompute; caching them at the
    // edge would fill the cache with one entry per thing anyone ever typed.
    const res = Response.json(
      { ...snapshot, tier: "search", query },
      { headers: { "Cache-Control": "no-store" } },
    );
    return res;
  }

  // Default to the short list: 240-odd chips is paralysing when all you want
  // is "is my site reachable from Japan". `?all=1` returns everything.
  const all = url.searchParams.get("all") === "1";
  const nodes = all ? snapshot.nodes : snapshot.nodes.filter((n) => n.featured);
  const res = Response.json(
    {
      ...snapshot,
      tier: all ? "all" : "featured",
      count: nodes.length,
      totalCount: snapshot.nodes.length,
      nodes,
    },
    { headers: { "Cache-Control": force ? "no-store" : "public, max-age=60" } },
  );
  if (!force) c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});

meta.get("/presets", (c) => c.json(NODE_PRESETS));

meta.get("/types", (c) =>
  c.json(
    [...KINDS.values()].map((k) => ({
      type: k.type,
      label: k.label,
      creditsPerProbe: k.creditsPerProbe({ protocol: "UDP" }),
      ...(k.type === "dns" ? { queryTypes: SUPPORTED_QUERY_TYPES } : {}),
    })),
  ),
);

/**
 * Valid targets for http measurements. RIPE only allows anchors, and the
 * anchor list is full of decommissioned entries — offering one of those gets
 * "This target cannot be resolved" back from Atlas.
 */
meta.get("/anchors", async (c) => {
  const anchors = await new AtlasClient(c.env.ATLAS_API_KEY).getAnchors();
  const af6 = c.req.query("af") === "6";
  const usable = anchors
    .filter((a) => (af6 ? a.ip_v6 : a.ip_v4))
    .map((a) => ({ fqdn: a.fqdn, city: a.city ?? null, country: a.country ?? null }))
    .sort((a, b) => (a.country ?? "").localeCompare(b.country ?? "") || a.fqdn.localeCompare(b.fqdn));
  return c.json({ count: usable.length, anchors: usable });
});

meta.get("/quota", async (c) => {
  const caller = await identify(c.req.raw, c.env);
  const [rate, budget] = await Promise.all([
    rateCheck(c.env, caller, "ping", 0, true),
    budgetState(c.env),
  ]);
  const policy = QUOTA[caller.tier];
  return c.json({
    tier: caller.tier,
    tokensLeft: rate.remaining,
    tokenCapacity: rate.capacity,
    creditsUsedToday: rate.creditsUsedToday,
    creditsLimit: rate.creditsLimit || null,
    maxNodes: policy.maxNodes,
    maxPerNode: policy.maxPerNode,
    publicBudget: { remaining: budget.remaining, limit: budget.limit },
  });
});

meta.get("/", (c) =>
  c.json({
    name: "netatlas",
    description: "On-demand multi-region network probing over RIPE Atlas",
    endpoints: {
      "POST /api/v1/probe": "create a measurement, returns { measurementId, shareUrl }",
      "GET /api/v1/m/:id": "aggregated results for a measurement (public, no key needed)",
      "POST /api/v1/probe/sync": "create then short-poll (?timeout=ms, max 25000)",
      "GET /api/v1/types": "measurement types and their credit cost",
      "GET /api/v1/nodes": `node catalogue; ?all=1 for all ${SEED_NODES.length}+`,
      "GET /api/v1/presets": "named node selections",
      "GET /api/v1/anchors": "valid targets for http measurements",
      "GET /api/v1/quota": "your remaining rate-limit and credit allowance",
    },
    types: [...KINDS.keys()],
  }),
);
