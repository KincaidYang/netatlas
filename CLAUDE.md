# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## What this is

`netatlas` — an **on-demand multi-region network probing platform** ("拨测") built on
[RIPE Atlas](https://atlas.ripe.net/). A caller picks a target and a few
country×operator nodes; the service launches a one-off measurement across real
probes and returns per-node results. Public, no login, no database.

Six measurement types: **ping, dns, traceroute, sslcert, http, ntp**.

## Status

Phases A–F are done: type-plugin core, node catalogue, quota/rate limiting,
`/api/v1` surface with stateless share links, the single-page console, and the
unit tests. Live on `main` via Workers Builds.

## The two constraints everything else follows from

**1. Atlas measurements are asynchronous.** Creating one does not return
results; probes report over ~30s to a few minutes. So:

- `POST /api/v1/probe` → create, return `{ measurementId, shareUrl }` immediately.
- `GET /api/v1/m/:id` → fetch + aggregate whatever has arrived so far.
- `POST /api/v1/probe/sync` short-polls within a bounded window (≤25s) for CLI users.
- The console polls client-side every 3s; the server never blocks.

**2. Credits are real money off a real account.** Per-probe cost, all verified
against actual spend (RIPE documents only the first four):

| ping | dns (UDP) | dns (TCP) | sslcert | http | ntp | traceroute |
|---|---|---|---|---|---|---|
| 3 | 10 | 20 | 10 | **20** | **20** | 30 |

The account holds ~30M credits, earns ~150k/day from self-hosted probes, and
Atlas caps spend at 10M/day. `PUBLIC_DAILY_CREDITS` defaults to 120,000 —
deliberately below daily income, so the public service runs on interest.

## Statelessness: Atlas *is* the database

There is no D1, no KV, no persistence of user data. Everything a result page
needs is public on the Atlas side and readable **without any API key**:

- `GET /measurements/<id>/` → type, target, status
- `GET /measurements/<id>/participation-requests/` → **the original probe
  selection, verbatim** — this is how we know what was *requested* per node
- `GET /measurements/<id>/results/` → the results, kept forever

So a measurement id is the permalink. `/m/<id>` renders for anyone, including
measurements created with a caller's own key. `src/describe.ts` only writes a
human-readable tag into the Atlas `description` (capped at 255 chars) — it is
**not** load-bearing; do not reintroduce a dependency on parsing it.

The only server-side state is operational, in Durable Objects: rate-limit
buckets, the credit ledger, and the node-catalogue cache.

## Node model: country × operator ASN

A node id is `cc-asn` (`cn-4134` = 中国·电信) and is **self-describing**, so
selection never depends on the catalogue — any well-formed pair works.

**Do not use Atlas `{type:"asn"}` selection.** ASN selection is *global*:
AS16509 (AWS) has ~100 connected probes across 25 countries, only 8% in Hong
Kong, so "香港 · AWS" would silently probe from Virginia. `resolveNodes()` in
`src/nodes.ts` resolves nodes to **explicit probe ids** at request time, live
against `status=1`, then emits one `{type:"probes"}` group per node.

- `data/nodes.json` is a **cold-start seed only** (242 nodes / 125 countries,
  62 marked `featured`). Regenerate with `npm run nodes:refresh`.
- At runtime the `CatalogCache` DO re-sweeps Atlas on a 3h TTL. A page load
  *triggers* a refresh but never waits for one — a sweep is 30 requests /
  ~1 MB / ~5s, which is fine every few hours and abusive on every page load.
- Probe counts in the catalogue are a **display and query-planning hint**,
  never truth. Truth is the `available` / `unavailable` fields returned by a
  real request.

**China has very few probes** (~65 connected nationwide; 电信 11, 联通 10,
移动 6). Chinese nodes under-fill often — always surface requested-vs-responded
rather than implying a full result.

## Adding a measurement type

Add one file under `src/measurements/` implementing `MeasurementKind` and
register it in `src/measurements/index.ts`. Nothing else needs to know types
exist. Each kind owns its credit cost, input validation (including target
safety), Atlas definition, row parsing and per-node summary.

Gotchas already paid for:

- **http is anchor-only.** Non-anchor targets are rejected upstream with
  `Only anchors may be targeted`; a case-by-case RIPE exemption exists but this
  account does not have one. `ALLOW_ANY_HTTP_TARGET=1` flips it if that changes.
  The anchor list is full of `is_disabled: true` entries — filter them or Atlas
  answers `This target cannot be resolved`.
- **sslcert needs SNI.** Without `hostname`, shared-hosting and CDN endpoints
  return a fallback certificate that reads as long-expired — a completely wrong
  verdict. It defaults to the target unless the target is an IP literal.
- **ping reports `-1`** for min/avg/max when nothing came back. That is "no
  measurement", not a negative RTT.
- **`resolve_on_probe: true` is not the default.** Without it Atlas resolves
  the target once, centrally, and hands the same address to every probe — so a
  multi-region run measures the path to one IP from everywhere. On `qq.com`
  that meant all 19 probes pinging `203.205.254.157`; with it they reach three
  different addresses. Every kind sets it for hostname targets (`resolveOnProbe()`
  in `src/measurements/kind.ts`), and skips it for IP literals.
- **Atlas's `query_type` enum is narrower than DNS.** Accepted: `A AAAA CNAME
  NS SOA TXT MX PTR SRV NAPTR DS DNSKEY RRSIG NSEC TLSA ANY`. Rejected with
  `"<TYPE>" is not a valid choice`: **CAA**, HTTPS, SVCB, NSEC3, NSEC3PARAM,
  URI, SSHFP, SPF, CDS, CDNSKEY, HINFO, LOC, CERT, DNAME. `SUPPORTED_QUERY_TYPES`
  is that accepted list and nothing else — `src/dns.ts` can *decode* far more
  (SVCB/HTTPS included, which do turn up inside ANY answers), but offering a
  type Atlas will not take just buys a 400.
  To re-check the list without spending credits, POST each candidate with
  `probes: []`: the request always fails, so nothing is billed, but field
  validation still runs and names the bad `query_type`.
- **DNSSEC needs the DO bit, and AD without it is meaningless.** A DS/DNSKEY
  query without `set_do_bit` comes back unsigned and the resolver never sets
  AD, so "did this resolver validate" is invisible. `src/measurements/dnsKind.ts`
  sets it (plus `udp_payload_size: 4096`, or the signed answer is truncated)
  for the DNSSEC record types only.
- **A dns result row does not carry `query_type`.** It is on the measurement,
  not the row, so the only way `parseRow` can know what was asked is the
  question the responder echoes back — `parseDnsMessage().questionType`.
- **No npm deps for parsing.** `src/dns.ts` decodes base64 `abuf` DNS wire
  format and `src/x509.ts` reads DER certificates by hand, both so nothing
  needs `nodejs_compat`. `src/x509.ts` was verified field-by-field against
  `openssl x509` on real RSA and ECC certificates.

## Quotas — read `src/quota.ts` before changing any limit

Every number lives in that one file. Two tiers: anonymous (billed to the
platform key, metered against the global budget) and BYOK (caller sends
`X-Atlas-Key`, spends their own credits, not metered). Only a **hash** of the
key or IP is ever stored — never the value.

`DailyBudget` reconciles against Atlas's own `past_day_credits_spent` every 10
minutes and gates on `max(local ledger, Atlas)`. That way a wrong cost estimate
— or the account being spent elsewhere — cannot quietly drain it.

429/503 responses carry `Retry-After` and the remaining allowance. They are
thrown as `QuotaError` (which carries its own `Response`), because Hono's
`HTTPException` loses a custom response when the error handler re-serialises it.

## File map

```
public/index.html      console: markup + the whole design system (inline CSS)
public/app.js          console behaviour: chips, polling, the two result views
public/fonts/          self-hosted IBM Plex woff2 — no Google Fonts (blocked in CN)
data/nodes.json        generated node catalogue + label tables + policy
scripts/build-nodes.mjs  regenerates data/nodes.json from live Atlas data

src/index.ts           route assembly, error handling, DO exports
src/routes/probe.ts    create + results + the quota chain, in that order
src/routes/meta.ts     nodes / presets / types / anchors / quota
src/measurements/      one file per type + the MeasurementKind contract
src/nodes.ts           catalogue access, node→probe resolution, presets
src/catalog.ts         CatalogCache DO — TTL sweep of live probe counts
src/quota.ts           every limit, in one place
src/gate.ts            identity (anon vs BYOK), quota checks, QuotaError
src/ratelimit.ts       RateLimiter DO — per-caller token buckets
src/budget.ts          DailyBudget DO — credit ledger, in-flight cap, dedupe
src/atlas.ts           Atlas v2 REST client (no official JS SDK exists)
src/aggregate.ts       group results by node, delegate parsing to the kind
src/dns.ts             base64 abuf → records
src/x509.ts            DER → certificate fields
src/describe.ts        the Atlas-side label (cosmetic)

test/                  vitest; fixtures are real captured data, see below
test/fixtures/*.pem    certificates for the DER reader
```

## Tests

`npm test` runs vitest over the pure functions — parsing, validation, quota
arithmetic, aggregation. Nothing there touches the network or a Workers
runtime, so it is safe to run in a loop and costs no credits.

The fixtures are real, not synthesised, because both parsers exist to survive
what the wire actually contains:

- `test/dns.test.ts` embeds DNS responses captured from 8.8.8.8 — genuine
  name-compression pointers, a two-hop CNAME chain, a TXT split at 255 bytes,
  and an HTTPS record the parser has no case for. Expected values were
  cross-checked against `dig` at capture time.
- `test/fixtures/*.pem` are four certificates generated by openssl to pin
  specific DER shapes (RSA vs ECC keys, UTCTime vs GeneralizedTime, v3 vs v1)
  plus one served by example.com. Every expectation came from
  `openssl x509 -noout -subject -issuer -dates -serial -fingerprint`.

Certificate fixtures are frozen bytes, so their expiry is irrelevant —
`parseCertificate` only reads fields. The tests that *do* care about "now"
(expired vs valid) pin the clock with `vi.setSystemTime`.

## Commands

- `npm run dev` — `wrangler dev` (needs `.dev.vars` with `ATLAS_API_KEY`)
- `npm test` — vitest, pure functions only (no Workers pool, no network)
- `npm run typecheck` — `tsc --noEmit`, covers `test/` too
- `npm run nodes:refresh` — regenerate `data/nodes.json`, then commit it
- `npm run deploy` — `wrangler deploy`

Smoke-testing costs real credits. Use ping with one probe per node (3 credits
each) unless the type under test is the point.

## Deployment & the ATLAS_API_KEY secret (hard-won)

Deploys run through **Workers Builds CI** (push to `main` → `wrangler deploy`).
`ATLAS_API_KEY` **must be a runtime Worker secret** — `wrangler secret put
ATLAS_API_KEY`. It is preserved across `wrangler deploy`, so CI rebuilds keep it.

Do **not** provide it as either of these — both produce `401 "key does not
exist"` at runtime, and we burned real time on both:

- **Plaintext Variable** in the dashboard → wiped on the next CI `wrangler
  deploy` (config has no `vars`, so wrangler removes it).
- **Workers Builds *build* variable** → exists only during the build step, so
  `c.env.ATLAS_API_KEY` is always empty at runtime.

Durable Object bindings and the migration live in `wrangler.jsonc` and ship with
CI. `wrangler secret list --name netatlas` and `wrangler deployments list
--name netatlas` confirm what is actually on the Worker.
