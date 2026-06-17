import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { AtlasClient } from "./atlas";
import { aggregate } from "./aggregate";
import { buildDescription, parseDescription } from "./describe";
import { REGION_PRESETS, SUPPORTED_QUERY_TYPES, buildProbeSelection, normalizeQueryType, resolveCountries } from "./regions";
import type { AtlasDnsResult, Env } from "./types";

const app = new Hono<{ Bindings: Env }>();

/** Optional bearer-token gate so strangers can't drain your Atlas credits. */
app.use("*", async (c, next) => {
  const token = c.env.API_TOKEN;
  if (token && c.req.header("Authorization") !== `Bearer ${token}`) {
    throw new HTTPException(401, { message: "unauthorized" });
  }
  await next();
});

app.get("/", (c) =>
  c.json({
    name: "netatlas",
    description: "On-demand multi-region DNS probing over RIPE Atlas",
    endpoints: {
      "POST /probe": "create a measurement, returns { measurementId }",
      "GET /probe/:id": "fetch + aggregate results for a measurement",
      "POST /probe/sync": "create then short-poll (?timeout=ms, max 25000) and return results",
      "GET /presets": "list region presets",
    },
    queryTypes: SUPPORTED_QUERY_TYPES,
  }),
);

app.get("/presets", (c) => c.json(REGION_PRESETS));

/**
 * Binding diagnostics. Reveals NO key characters — only enough to tell whether
 * ATLAS_API_KEY actually reached the running Worker and is well-formed. Safe to
 * leave public; remove once the deployment is confirmed healthy.
 */
app.get("/debug", (c) => {
  const k = c.env.ATLAS_API_KEY ?? "";
  return c.json({
    keyPresent: k.length > 0,
    keyLength: k.length,
    looksLikeUuid: /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(k),
    hasStrayWhitespace: k !== k.trim(),
    apiTokenGate: Boolean(c.env.API_TOKEN),
  });
});

interface ProbeBody {
  domain?: string;
  queryType?: string;
  af?: number;
  regionSet?: string;
  countries?: string[];
  probesPerRegion?: number;
  target?: string;
}

interface CreatedProbe {
  measurementId: number;
  domain: string;
  queryType: string;
  af: 4 | 6;
  requested: Record<string, number>;
}

async function createFromBody(client: AtlasClient, body: ProbeBody): Promise<CreatedProbe> {
  const domain = body.domain?.trim();
  if (!domain) throw new HTTPException(400, { message: "'domain' is required" });

  const queryType = normalizeQueryType(body.queryType);
  const af: 4 | 6 = body.af === 6 ? 6 : 4;
  const countries = resolveCountries(body);
  const { probes, requested } = buildProbeSelection(countries, body.probesPerRegion ?? 3, af);
  const description = buildDescription({ domain, queryType, af, requested });

  const measurementId = await client.createDnsMeasurement({
    domain,
    queryType,
    af,
    probes,
    target: body.target,
    description,
  });
  return { measurementId, domain, queryType, af, requested };
}

app.post("/probe", async (c) => {
  const body = await c.req.json<ProbeBody>().catch(() => ({}) as ProbeBody);
  const client = new AtlasClient(c.env.ATLAS_API_KEY);
  const created = await createFromBody(client, body);
  return c.json({ ...created, resultsUrl: `/probe/${created.measurementId}` }, 201);
});

app.get("/probe/:id", async (c) => {
  const id = Number(c.req.param("id"));
  if (!Number.isInteger(id) || id <= 0) throw new HTTPException(400, { message: "invalid measurement id" });

  const client = new AtlasClient(c.env.ATLAS_API_KEY);
  const [meta, results] = await Promise.all([client.getMeasurement(id), client.getResults(id)]);
  const parsed = parseDescription(meta.description ?? "");

  return c.json(await buildReport(client, id, meta.status?.name ?? "unknown", parsed?.requested ?? {}, results, parsed));
});

app.post("/probe/sync", async (c) => {
  const body = await c.req.json<ProbeBody>().catch(() => ({}) as ProbeBody);
  const client = new AtlasClient(c.env.ATLAS_API_KEY);
  const created = await createFromBody(client, body);

  const timeoutMs = Math.min(Number(c.req.query("timeout")) || 20000, 25000);
  const { results, status } = await pollResults(client, created.measurementId, timeoutMs);

  return c.json(
    await buildReport(client, created.measurementId, status, created.requested, results, {
      domain: created.domain,
      queryType: created.queryType,
    }),
  );
});

async function buildReport(
  client: AtlasClient,
  measurementId: number,
  status: string,
  requested: Record<string, number>,
  results: AtlasDnsResult[],
  parsed: { domain: string; queryType: string } | null,
) {
  const probeIds = [...new Set(results.map((r) => r.prb_id))];
  const probeMeta = await client.getProbes(probeIds);
  return {
    measurementId,
    status,
    domain: parsed?.domain,
    queryType: parsed?.queryType,
    totalRequested: Object.values(requested).reduce((a, b) => a + b, 0),
    totalResponded: results.length,
    byRegion: aggregate(results, probeMeta, requested),
  };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Poll results until the measurement stops or the deadline passes. */
async function pollResults(
  client: AtlasClient,
  id: number,
  timeoutMs: number,
): Promise<{ results: AtlasDnsResult[]; status: string }> {
  const intervalMs = 2500;
  const deadline = Date.now() + timeoutMs;
  let results: AtlasDnsResult[] = [];
  let status = "Ongoing";
  while (true) {
    const meta = await client.getMeasurement(id);
    status = meta.status?.name ?? status;
    results = await client.getResults(id);
    const stopped = (meta.status?.id ?? 0) >= 4; // 4 = Stopped
    if (stopped || Date.now() >= deadline) break;
    await sleep(Math.min(intervalMs, Math.max(0, deadline - Date.now())));
  }
  return { results, status };
}

app.onError((err, c) => {
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: err instanceof Error ? err.message : "internal error" }, 500);
});

export default app;
