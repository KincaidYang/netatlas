# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Status

Phase 1 scaffold exists (TypeScript + Hono on Cloudflare Workers). The two-phase API, probe-selection, DNS-abuf parsing, and result aggregation are implemented. No persistence, no rate limiter, no tests yet.

## What this is

`netatlas` — an **on-demand multi-region DNS probing API** built on top of [RIPE Atlas](https://atlas.ripe.net/). A caller passes a domain; the service launches a one-off DNS measurement across probes in several regions and returns the per-region resolution results.

Phase 1 scope (deliberately small):
- Input: a domain (+ optional query type and region list).
- Trigger a **one-off** RIPE Atlas DNS measurement (no recurring/scheduled monitoring).
- Collect and return per-region results. **No database** — results live on the Atlas side; this service is stateless.

## The single most important constraint: Atlas measurements are asynchronous

Creating a one-off measurement does **not** return DNS results. RIPE schedules global probes to execute it; first results arrive in seconds, but a region set typically takes ~30s to a few minutes to fill in. Design everything around this:

- Do **not** try to create-and-return-results in one blocking call as the primary path.
- Two-phase API is the core pattern:
  - `POST /probe` → create measurement, return `{ measurementId }` immediately.
  - `GET /probe/:id` → fetch + aggregate current results from Atlas.
- A convenience `POST /probe/sync` may create then short-poll within a bounded window (~20s) and return whatever has arrived. It must never block unbounded — this is also what keeps it within Cloudflare Workers CPU/time limits.

## Stack & why

- **TypeScript + [Hono](https://hono.dev/) on Cloudflare Workers.** Workers-only — no local/Node deployment target. Entry point `src/index.ts` exports the Hono `app` as the Worker fetch handler.
- **No RIPE Atlas SDK.** The official SDKs (cousteau/sagan) are Python only. Talk to the Atlas v2 REST API directly with `fetch` (`src/atlas.ts`).
- **No npm deps for DNS parsing.** Atlas returns answers as base64 `abuf` (raw DNS wire format); `src/dns.ts` decodes it by hand (incl. name-compression pointers) so nothing depends on Node `Buffer`/`nodejs_compat`.

## Atlas integration notes (the non-obvious parts)

- **Auth:** `Authorization: Key <ATLAS_API_KEY>` header. The key is a secret — local: `.dev.vars`/`.env` (never commit); Workers: `wrangler secret put ATLAS_API_KEY`.
- **Credits burn per probe per measurement.** A public endpoint WILL drain the account fast. Enforce a max probe count per request and per-caller rate limiting from day one.
- **Create one-off DNS measurement:** `POST https://atlas.ripe.net/api/v2/measurements/` with top-level `is_oneoff: true`, a `definitions[]` array, and a `probes[]` array.
- **Multi-region = multiple probe-selection groups**, e.g. `probes: [{type:"country",value:"US",requested:3},{type:"country",value:"JP",requested:3}, ...]`. Keep a configurable default region set (e.g. US/DE/JP/SG/BR).
- **DNS definition semantics to expose in the API:**
  - `use_probe_resolver: true` → query each probe's local recursive resolver (reveals real geo/CDN scheduling — the usual choice).
  - vs. explicit `target` → query a specific authoritative/recursive server.
  - Plus `query_type` (A/AAAA/CNAME/TXT/SOA…), `query_class: "IN"`, `af` (4/6).
- **Fetch results:** `GET https://atlas.ripe.net/api/v2/measurements/<id>/results/`. Aggregate by probe country; extract resolved IPs, RTT, and error states (timeout/NXDOMAIN).

## File map

```
src/index.ts      Hono app: auth gate, routes (/probe, /probe/:id, /probe/sync, /presets), polling
src/atlas.ts      AtlasClient — REST wrapper (create/get measurement, get results, get probes)
src/regions.ts    REGION_PRESETS + buildProbeSelection (country groups, cost caps, AF tags)
src/dns.ts        parseDnsAnswers — decode base64 abuf → records
src/aggregate.ts  group results by probe country; requested-vs-responded fill rates
src/describe.ts   encode/parse the requested-region map into the Atlas measurement description
src/types.ts      Env + Atlas response shapes
```

**Statelessness trick:** there is no DB, so `GET /probe/:id` recovers what was *requested* per region by parsing it back out of the measurement `description` (written by `buildDescription` at create time). If you add persistence, this is the thing to replace.

## Commands

- `npm run dev` — `wrangler dev` (needs `.dev.vars` with `ATLAS_API_KEY`)
- `npm run typecheck` — `tsc --noEmit`
- `npm run deploy` — `wrangler deploy` (set secrets first: `wrangler secret put ATLAS_API_KEY`)
- Tests: none yet. When adding, `parseDnsAnswers` (feed it captured base64 abufs) and `aggregate` are the pure, high-value units to cover.
