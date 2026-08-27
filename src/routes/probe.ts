import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { aggregate } from "../aggregate";
import { AtlasClient } from "../atlas";
import { buildDescription } from "../describe";
import {
  QUOTA,
  dedupeClaim,
  dedupeKey,
  identify,
  markCreated,
  rateCheck,
  rejectBudget,
  rejectRate,
  releaseCredits,
  reserveCredits,
  settleMeasurement,
  type Caller,
} from "../gate";
import { kindFor } from "../measurements";
import { NODE_PRESETS, labelFor, nodeKeyFor, requestedFromProbeIds, resolveNodes } from "../nodes";
import type { AtlasParticipationRequest, Env, ProbeMeta } from "../types";

export const probe = new Hono<{ Bindings: Env }>();

interface CreateBody extends Record<string, unknown> {
  type?: string;
  nodes?: string[];
  preset?: string;
  perNode?: number;
}

function selectedNodes(body: CreateBody): string[] {
  if (Array.isArray(body.nodes) && body.nodes.length) return body.nodes.map(String);
  const preset = String(body.preset ?? "global");
  const list = NODE_PRESETS[preset];
  if (!list) {
    throw new HTTPException(400, {
      message: `unknown preset '${preset}'. Known: ${Object.keys(NODE_PRESETS).join(", ")}`,
    });
  }
  return list;
}

/** How long a request will wait behind another one already creating the same measurement. */
const DEDUPE_WAIT_MS = 8000;

/**
 * Either the measurement to reuse, or null meaning "go ahead and create it".
 *
 * A miss claims the key for this caller, so concurrent identical requests
 * queue here instead of each buying its own copy of the same answer. Waiting
 * out the window without a claim is a deliberate fallback: a stalled holder
 * should cost one duplicate measurement, not a stuck request.
 */
async function claimOrReuse(env: Env, key: string): Promise<number | null> {
  const deadline = Date.now() + DEDUPE_WAIT_MS;
  for (;;) {
    const claim = await dedupeClaim(env, key);
    if (claim.measurementId) return claim.measurementId;
    if (claim.claimed || Date.now() >= deadline) return null;
    await sleep(300);
  }
}

/**
 * Create a measurement, subject to the whole quota chain.
 *
 * Order matters and is deliberate:
 *   1. peek at the caller's bucket        — reject the obvious flooder for free
 *   2. de-duplicate                       — an identical recent question costs nothing
 *   3. resolve nodes                      — now we know the true probe count
 *   4. take the token + charge the credits
 *   5. reserve from the global budget     — anonymous callers only
 *   6. create, releasing the reservation if anything after step 2 says no
 */
async function create(env: Env, caller: Caller, body: CreateBody) {
  const kind = kindFor(body.type ?? "ping");
  const params = kind.validate(body, env);
  const af = (params as { af?: 4 | 6 }).af ?? 4;
  const policy = QUOTA[caller.tier];

  const nodeIds = selectedNodes(body);
  if (nodeIds.length > policy.maxNodes) {
    throw new HTTPException(400, {
      message:
        `选了 ${nodeIds.length} 个节点，当前身份最多 ${policy.maxNodes} 个` +
        (caller.tier === "anon" ? "（填入自己的 Atlas Key 可放宽）" : ""),
    });
  }
  const perNode = Math.min(Math.max(Number(body.perNode ?? 2) || 1, 1), policy.maxPerNode);

  const peek = await rateCheck(env, caller, kind.type, 0, true);
  if (!peek.ok) rejectRate(peek, caller.tier);

  const key = await dedupeKey(kind.type, params, nodeIds, perNode);
  const existing = await claimOrReuse(env, key);
  if (existing) return { measurementId: existing, type: kind.type, deduped: true as const };

  // From here on we hold the claim, so every exit has to hand it back.
  const metered = policy.countsAgainstGlobalBudget;
  let ticket: string | undefined;
  let credits = 0;
  let measurementId: number;
  let selection: Awaited<ReturnType<typeof resolveNodes>>;
  let take: Awaited<ReturnType<typeof rateCheck>>;
  try {
    // Reads are public, so node resolution always uses the platform key.
    selection = await resolveNodes(new AtlasClient(env.ATLAS_API_KEY), nodeIds, perNode, af);
    const totalProbes = Object.values(selection.requested).reduce((a, b) => a + b, 0);
    credits = kind.creditsPerProbe(params) * totalProbes;

    take = await rateCheck(env, caller, kind.type, credits);
    if (!take.ok) rejectRate(take, caller.tier);

    if (metered) {
      const reserved = await reserveCredits(env, credits);
      if (!reserved.ok) rejectBudget(reserved);
      ticket = reserved.ticket;
    }

    const definition = kind.buildDefinition(params, buildDescription(kind.type, String(body.target ?? "")));
    measurementId = await new AtlasClient(caller.atlasKey).createMeasurement(definition, selection.probes);
  } catch (err) {
    // Only give credits back if they were actually reserved — a ticket is
    // proof of that; without one this just hands the claim back.
    await releaseCredits(env, ticket ? credits : 0, ticket, key);
    throw err;
  }

  // Names the in-flight slot after the measurement and publishes it for de-duplication.
  await markCreated(env, ticket, measurementId, key);
  return {
    measurementId,
    type: kind.type,
    requested: selection.requested,
    available: selection.available,
    unavailable: selection.unavailable,
    estimatedCredits: credits,
    billedTo: caller.usingOwnKey ? "your-key" : "public",
    tokensLeft: take.remaining,
  };
}

const shareUrl = (req: Request, id: number): string => `${new URL(req.url).origin}/m/${id}`;

probe.post("/probe", async (c) => {
  const body = await c.req.json<CreateBody>().catch(() => ({}) as CreateBody);
  const caller = await identify(c.req.raw, c.env);
  const created = await create(c.env, caller, body);
  return c.json(
    {
      ...created,
      resultsUrl: `/api/v1/m/${created.measurementId}`,
      shareUrl: shareUrl(c.req.raw, created.measurementId),
    },
    created.deduped ? 200 : 201,
  );
});

probe.post("/probe/sync", async (c) => {
  const body = await c.req.json<CreateBody>().catch(() => ({}) as CreateBody);
  const caller = await identify(c.req.raw, c.env);
  const created = await create(c.env, caller, body);
  const client = new AtlasClient(c.env.ATLAS_API_KEY);
  await poll(client, created.measurementId, Math.min(Number(c.req.query("timeout")) || 20000, 25000));
  const summary = await report(client, created.measurementId);
  if (summary.status === "Stopped") await settleMeasurement(c.env, created.measurementId);
  return c.json({
    ...summary,
    unavailable: created.unavailable ?? [],
    shareUrl: shareUrl(c.req.raw, created.measurementId),
  });
});

/**
 * Results for any measurement, by id. Needs no key and no local state: Atlas
 * serves the metadata, the original probe selection and the results publicly,
 * so a shared link renders for anyone — including measurements a caller
 * created with their own key.
 */
probe.get("/m/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) throw new HTTPException(400, { message: "invalid measurement id" });

  const cache = caches.default;
  const cacheKey = new Request(new URL(c.req.url).toString(), { method: "GET" });
  const hit = await cache.match(cacheKey);
  if (hit) return hit;

  const body = await report(new AtlasClient(c.env.ATLAS_API_KEY), id);
  const settled = body.status === "Stopped";
  // Loading results is the only reliable signal that a measurement finished,
  // so this is where its in-flight slot goes back to the pool.
  if (settled) c.executionCtx.waitUntil(settleMeasurement(c.env, id));

  // A stopped one-off never changes again, so a shared link can be served from
  // cache forever instead of re-querying Atlas on every view. An unfinished
  // one changes every few seconds, and `no-store` says so in the only way a
  // zone-level Browser Cache TTL cannot quietly rewrite: anything that keeps
  // a partial result turns the console's 3s polling into a page that never
  // updates, which is far worse than one extra round trip to Atlas.
  const res = Response.json(body, {
    headers: { "Cache-Control": settled ? "public, max-age=86400" : "no-store" },
  });
  if (settled) c.executionCtx.waitUntil(cache.put(cacheKey, res.clone()));
  return res;
});

const probeIdsOf = (prs: AtlasParticipationRequest[]): number[] =>
  prs
    .filter((p) => p.type === "probes")
    .flatMap((p) => p.value.split(",").map(Number).filter(Number.isInteger));

/** Pre-node-catalogue measurements selected whole countries; keep their links working. */
const requestedByCountry = (prs: AtlasParticipationRequest[]): Record<string, number> => {
  const out: Record<string, number> = {};
  for (const pr of prs) {
    if (pr.type !== "country") continue;
    const key = pr.value.toLowerCase();
    out[key] = (out[key] ?? 0) + pr.requested;
  }
  return out;
};

export async function report(client: AtlasClient, id: number) {
  const [meta, participation, results] = await Promise.all([
    client.getMeasurement(id),
    client.getParticipationRequests(id),
    client.getResults(id),
  ]);
  const kind = kindFor(meta.type);

  const requestedIds = probeIdsOf(participation);
  const probeMeta: Map<number, ProbeMeta> = await client.getProbes([
    ...new Set([...requestedIds, ...results.map((r) => r.prb_id)]),
  ]);

  const byCountry = requestedIds.length === 0;
  const requested = byCountry
    ? requestedByCountry(participation)
    : requestedFromProbeIds([{ ids: requestedIds }], probeMeta);
  const keyOf = byCountry
    ? (m: ProbeMeta | undefined) => (m?.country_code ?? "??").toLowerCase()
    : nodeKeyFor;

  const groups = await aggregate(kind, results, probeMeta, requested, keyOf);

  return {
    measurementId: id,
    type: meta.type,
    target: meta.target ?? meta.query_argument,
    // Which record was asked for; a shared dns link is meaningless without it.
    queryType: meta.query_type,
    status: meta.status?.name ?? "unknown",
    totalRequested: Object.values(requested).reduce((a, b) => a + b, 0),
    totalResponded: results.length,
    groups: groups.map((g) => ({ ...g, label: labelFor(g.key) })),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll until the measurement stops or the deadline passes — never unbounded. */
async function poll(client: AtlasClient, id: number, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const meta = await client.getMeasurement(id);
    if ((meta.status?.id ?? 0) >= 4) return; // 4 = Stopped
    await sleep(Math.min(2500, Math.max(0, deadline - Date.now())));
  }
}
