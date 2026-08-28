import { Hono } from "hono";
import { HTTPException } from "hono/http-exception";
import { trimTrailingSlash } from "hono/trailing-slash";
import { DailyBudget } from "./budget";
import { CatalogCache } from "./catalog";
import { QuotaError, budgetState } from "./gate";
import { RateLimiter } from "./ratelimit";
import { meta } from "./routes/meta";
import { probe } from "./routes/probe";
import type { Env } from "./types";

export { CatalogCache, RateLimiter, DailyBudget };

const app = new Hono<{ Bindings: Env }>();

// `/api/v1/` and `/api/v1` should be the same thing.
app.use(trimTrailingSlash());

/** Admin-only surface; everything else is public and governed by quotas. */
app.use("/api/v1/admin/*", async (c, next) => {
  const token = c.env.ADMIN_TOKEN;
  if (!token || c.req.header("X-Admin-Token") !== token) {
    throw new HTTPException(401, { message: "unauthorized" });
  }
  await next();
});

app.get("/api/v1/admin/budget", async (c) => c.json(await budgetState(c.env)));

app.route("/api/v1", meta);
app.route("/api/v1", probe);

/**
 * A measurement id is the permalink: everything needed to render a result page
 * is public on the Atlas side, so /m/<id> needs no database and no session.
 * The page itself is served by the static asset handler; this only matters for
 * API clients that follow the shareUrl.
 */
app.get("/m/:id", (c) => {
  const id = c.req.param("id");
  if (c.req.header("Accept")?.includes("text/html")) return c.redirect(`/?m=${id}`, 302);
  return c.redirect(`/api/v1/m/${id}`, 302);
});

app.onError((err, c) => {
  // Quota rejections ship their own response: the Retry-After header and the
  // remaining-allowance fields are the useful part of a 429/503.
  if (err instanceof QuotaError) return err.response;
  if (err instanceof HTTPException) return c.json({ error: err.message }, err.status);
  console.error(err);
  return c.json({ error: err instanceof Error ? err.message : "internal error" }, 500);
});

app.notFound((c) => c.json({ error: "not found" }, 404));

/**
 * Hourly cron, and the only thing that can start the catalogue from nothing.
 *
 * `CatalogCache` keeps itself refreshed with an alarm that reschedules after
 * every sweep, but the first alarm is armed inside `fetch()`. An object that
 * predates alarms — every deployed one, the first time that shipped — arms
 * nothing until something reaches it, so a deploy with no traffic afterwards
 * would leave the sweep asleep and hand the next visitor a stale catalogue.
 * That is the exact dependency on passing traffic the alarm was added to end,
 * surviving in the alarm's own initialisation.
 *
 * One request to the object per hour. It arms the alarm if unarmed and sweeps
 * only when the snapshot is past its TTL, so the usual outcome is nothing.
 */
export default {
  fetch: app.fetch,
  async scheduled(_event: ScheduledEvent, env: Env, ctx: ExecutionContext): Promise<void> {
    const stub = env.CATALOG.get(env.CATALOG.idFromName("v1"));
    ctx.waitUntil(stub.fetch("https://catalog/nodes"));
  },
};
