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

**A node id carries one ASN, and it is the v4 one.** For an `af: 6` request on
a node the catalogue never saw, `resolveNodes` does *not* assume the v6 ASN
matches: it queries by the v4 ASN and keeps the probes on the **dominant** v6
ASN among them — the same rule the catalogue applies when it records a group's
`asnV6`. Assuming they matched made every asymmetric operator look empty over
IPv6: `de-8899` reported 0 probes where it has 37. Taking *all* v6-capable
probes instead would be worse — a probe can reach IPv6 through a tunnel broker
on an unrelated AS, and that measures Hurricane Electric's path while claiming
the operator's.

**Do not use Atlas `{type:"asn"}` selection.** ASN selection is *global*:
AS16509 (AWS) has ~100 connected probes across 25 countries, only 8% in Hong
Kong, so "香港 · AWS" would silently probe from Virginia. `resolveNodes()` in
`src/nodes.ts` resolves nodes to **explicit probe ids** at request time, live
against `status=1`, then emits one `{type:"probes"}` group per node.

- `data/nodes.json` is a **cold-start seed only** (242 nodes / 126 countries,
  62 marked `featured`). Regenerate with `npm run nodes:refresh`.
- **The catalogue is a curated view, not the universe.** Atlas has connected
  probes in ~5,000 country×operator pairs; the catalogue offers ~240 of them.
  The rest are reachable through `GET /nodes?q=<query>`, which searches every
  stored pair — by id, bare ASN, country name or code, or operator name. This
  works only because a node id is self-describing: a hit is measurable even
  though the catalogue never listed it.
- **Two thirds of those pairs have exactly one probe.** They are offered and
  marked (dimmed chip, red count), never hidden — a single probe can go offline
  between the sweep and the measurement, and `0/1` is a fact the reader can act
  on where a missing node is not.
- Most of the 4,398 ASNs have **no resolved holder name** — `resolveNames`
  looks up 25 new ones per sweep — so they read as `AS12345` and only the ASN
  or country will find them. The console says so on an empty result; do not
  "fix" this by naming thousands of ASNs on every sweep.
- The full pair set does not fit one Durable Object value (~130 KB against a
  128 KiB limit), so `CatalogCache` stores it in `groups:<n>` **shards**. The
  resolved ASN names are sharded the same way and, more importantly, **pruned
  to the ASNs the current groups reference**: 25 new holders per sweep with
  nothing ever removed crosses the same limit somewhere past 5,000 entries —
  about a month after deploy — and that `put` throwing before `refreshedAt`
  advances leaves the catalogue permanently stale, so every page load fires
  another 30-request sweep at Atlas. Writing names is also wrapped in its own
  try/catch for the same reason: a name is cosmetic, a stuck refresh is not.
  A pre-sharding deployment's single `counts` / `names` keys are still read as
  a fallback and deliberately left in place, so a rollback degrades instead of
  falling back to the committed seed.
- The continent for a country lives in **one table**, in
  `scripts/build-nodes.mjs`, baked into `data/nodes.json` as `continents`. The
  runtime needs it because a sweep finds pairs the build never saw; without the
  baked map they rendered under `??`. It covers all 249 ISO codes on purpose —
  a continent with no nodes simply does not render.
- **The sweep does not filter `is_public`, and must not start doing so.** `findProbes`
  — the path that actually selects probes for a measurement — does not filter
  on it, so a catalogue that did would describe a different population from the
  one it plans against. 1,099 of Atlas's 14,650 connected probes are private
  and every one can answer a measurement; filtering them out hid 181
  country×operator pairs from search and 16 nodes from the catalogue, and
  understated the console's headline by 7.5%.
- At runtime the `CatalogCache` DO re-sweeps Atlas on a 3h TTL, and on a
  **Durable Object alarm** that reschedules itself. The lazy trigger alone put
  the cost on the wrong visitor: the first one past the TTL starts the sweep,
  does not wait, and is the only person served the stale answer. The first
  alarm is armed from `refreshedAt + TTL`, not from now, or an object deployed
  with a nearly-expired snapshot would sit stale for another full interval.
  Both paths go through one memoised promise — a cold object arms an alarm that
  is already due, so without it the alarm and the lazy trigger each run a full
  30-request pass to produce one answer. **An hourly cron trigger pokes the
  object**, because the first alarm is armed inside `fetch()`: an object that
  predates alarms arms nothing until something reaches it, so a deploy followed
  by no traffic would leave the sweep asleep — the dependency on passing
  traffic surviving inside the alarm's own initialisation. A page load never *waits* for a sweep
  either way: it is 30 requests / ~1 MB / ~5s, fine every few hours and abusive
  on every page load.
- Probe counts in the catalogue are a **display and query-planning hint**,
  never truth. Truth is the `available` / `unavailable` fields returned by a
  real request, and `available` is the *complete* live pool — the lookup pages
  to the end rather than stopping once it has enough, because a number
  documented as a pool size must not quietly become a lower bound.
- **Plan the lookups from live counts.** `resolveNodes` takes a `sizes` map
  (`liveSizes()` in `src/routes/probe.ts` reads it from the `CatalogCache` DO)
  and uses it only to decide how many nodes go in one Atlas query. Guessing 50
  probes for an uncatalogued node was fine until search made them selectable in
  bulk: `de-3209` really has 190, so a batch nominally inside the 400 budget
  matched past Atlas's 500-per-page cap, and the overflow silently dropped
  whichever nodes sorted last — they came back `unavailable` moments after
  search had reported their probes. Pagination still backs it up, but with real
  sizes it rarely fires. If the DO is unreachable the guess returns and the
  paging catches the overflow.
- **Reads page until Atlas returns a short page**, never to a page budget. The
  first version of this capped at four pages, which repeated the mistake it was
  fixing: returning the first 2,000 of a larger pool while calling `available`
  complete. `MAX_PAGES` is a runaway guard against a misbehaving API, not a
  budget — the largest country×operator group in Atlas holds 309 probes, so a
  single node has never needed a second page.
- **A group is keyed by the probe's v4 ASN, never falling back to its v6 one.**
  188 connected probes are IPv6-only, and keying those by their v6 ASN invented
  61 groups that resolve to nothing (search offered them; selecting one always
  returned `unavailable`) and credited 80 real nodes with IPv4 probes that have
  no IPv4 — KPN uses 1136 for both families, so `nl-1136` counted them, and
  `de-3320` advertised 316 where it has 310. Those probes stay reachable for
  `af: 6` on a catalogued node, which queries by v6 ASN and never reads these
  counts. Both sweeps do this, and they no longer each say so: the rule is
  `groupProbes()` in **`src/probe-grouping.ts`**, which `src/catalog.ts` and
  `scripts/build-nodes.mjs` both import. Node runs the `.ts` from the `.mjs`
  directly (native type stripping — no loader, no build step), so keep that
  module erasable-syntax-only: no `enum`, no `namespace`, no parameter
  properties. Stripping is unflagged only from **Node 22.18**, which
  `package.json` now declares in `engines`: on Node 20 both `nodes:refresh`
  and `cities:refresh` die with `ERR_UNKNOWN_FILE_EXTENSION`, and the import
  fails before any code in the script can explain why.
- **A batch that fails mid-pagination is retried from page one**, so probes
  already collected arrive a second time. Pools are deduplicated before they
  are counted or sampled — otherwise `available` inflates (600 reported as
  1,100) and `shuffle().slice()` can hand Atlas the same probe id twice inside
  one group.

## Where the city name comes from

A node is one country and one operator, not one place: `resolveNodes()` picks
randomly from the live pool, so two runs of 中国·电信 can answer from Beijing
and Guangzhou — most of the RTT spread a reader would otherwise blame on the
network. Results therefore show each probe's city. It is **display only**; the
selection unit is still `cc-asn` and there is no `cn-4134@beijing`.

**Atlas does not have city names.** A probe object is exactly `address_v4/v6,
asn_v4/v6, country_code, description, firmware_version, first/last_connected,
geometry, id, is_anchor, is_public, prefix_v4/v6, status, total_uptime, tags`.
`?city=` is not a filter, and — like every unknown filter — Atlas **silently
ignores it and returns all 60k probes**, so asking is worse than not asking.
Only *anchors* carry `city`, and there are none in China outside Hong Kong.

So `data/cities.json` is ours, baked by `npm run cities:refresh`:

- **China is hand-written**, in `scripts/build-cities.mjs`, in git, reviewable
  line by line. GeoNames rows for `CN/HK/MO/TW` are dropped at build time — no
  third-party gazetteer contributes a Chinese place name. Four county-level
  probe sites are folded into their prefecture city (淅川→南阳, 石柱→重庆,
  宁海→宁波, 恒春→屏东) because the county name tells a reader nothing.
- **Everywhere else is GeoNames**, from which only `name` + coordinates are
  taken. Its country column is a tie-break key and is **never displayed**; the
  country/region label always comes from `CN_NAMES` in `scripts/build-nodes.mjs`.
  Do not "simplify" that into using the data source's own country.
- `cityFor()` in `src/geo.ts` answers with the nearest entry **within 50 km**
  and null beyond it. The longitude search widens towards the poles, because a
  degree of longitude is 111 km at the equator and 39 km at Tromsø — a fixed
  one-bucket reach silently breaks the 50 km promise in the north.
- **Use `cityOfProbe()`, not `cityOf()`, on anything derived from a real
  probe.** It is the one that honours `system-auto-geoip-country`, Atlas's own
  admission that it placed the probe no better than its country. That tag is not
  a formality: **all 16 of China's country-tagged probes sit on `113.72, 34.77`,
  the point GeoIP returns for "somewhere in China", which lands beside
  Zhengzhou.** Read their coordinates and you report a 16-probe cluster in 郑州
  that does not exist — this catalogue's second largest, and entirely fictional.
  The exception is `SINGLE_METRO` (HK/MO/SG): a territory smaller than the match
  radius is one metro, so the fallback point is still the right answer, and 12
  of Hong Kong's 61 probes need it.
- Two build-time rules were paid for with real data, don't undo them:
  `MIN_POP` is **30,000**, because at 150k the table missed Ashburn (43k) —
  the densest probe cluster in the US, 80 of them, called 阿灵顿 38 km away;
  and entries are **swallowed by a neighbour in the same country ≥5× their size
  within 35 km**, because cities15000 lists Tokyo's 台東 and London's Islington
  as cities, so without it a Tokyo probe answers 目黒. The same-country half of
  that test is load-bearing: Kehl (DE, 35k) is 5 km from Strasbourg (FR, 274k),
  and merging across the border makes a German probe report a French city.
  Coverage is 96.7% of nameable probes, 100% in China.
- The coverage report in the build script runs **the runtime rule itself** —
  `nearestCity()` in **`src/geo-math.ts`**, imported by both `src/geo.ts` and
  `scripts/build-cities.mjs`, along with the match radius, the longitude reach
  and the `SINGLE_METRO` exception. It used to be a second copy that "mirrors"
  it, and the copies had already drifted: on a tie the script moved to any row
  in the probe's country, where the runtime moves only when the incumbent is
  not already in it. Narrow, but it meant the coverage number described a
  lookup that did not ship. Same erasable-syntax-only constraint as
  `src/probe-grouping.ts`.
- **The GeoNames credit is a licence obligation, not decoration.** cities15000
  is CC BY 4.0 and `data/cities.json` redistributes a derived copy, so the
  attribution travels in the file itself and appears in the console footer. It
  goes when the GeoNames half goes, and not before.
- Do not take Chinese names from the `alternatenames` column of
  `cities15000.txt` — it is not language-tagged, and it yields 宝安 for 深圳,
  古龍 for 科隆, ソウル特別市 for 首尔. Real `zh` names need the 203 MB
  `alternateNamesV2`, which is not worth it; the ~250 metros worth naming are
  in a hand-written override table instead.

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
- **`ttr` (the probe's own DNS resolve time) only exists with
  `resolve_on_probe`,** and it is in **milliseconds on every type, ntp
  included** — the one field in an ntp row that is not seconds. It is worth
  surfacing: real runs show probes in China and the US spending ~5000 ms on
  DNS, time a reader would otherwise attribute to the network.
- **ntp reports seconds, everything else reports milliseconds.** `rtt`,
  `offset`, `root-delay`, `root-dispersion` and every `*-ts` in an ntp row are
  seconds. Proof from the row itself: `ref-ts` − 2208988800 (the NTP epoch)
  equals that row's own unix `timestamp`, and `rtt` is
  (final-ts − origin-ts) − (transmit-ts − receive-ts) over the same fields.
  Convert with `secToMs` in `src/measurements/ntp.ts`, and convert *before*
  rounding — three decimals first turns 0.023669 s into 24 ms, not 23.669.
- **ping reports `-1`** for min/avg/max when nothing came back. That is "no
  measurement", not a negative RTT.
- **A popular target can be refused outright.** Atlas caps concurrent
  measurements *per target* across the whole platform: creating a ping to
  `1.1.1.1` came back `400 code 102` — "We do not allow more than 25 concurrent
  measurements to the same target: 1.1.1.1". Nothing about the account or the
  request is wrong, and no documentation mentions it; the same request against
  a quieter hostname succeeds. Worth recognising before debugging the selection
  that produced it.
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
  type Atlas will not take just buys a 400. The docs do not enumerate this
  anywhere, which is how CAA stayed broken from Phase A until someone tried it.
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

**`maxProbes` is the limit that binds, not `maxNodes`.** Nodes alone do not
bound cost: 50 nodes at two probes each is 100 probes. Anonymous callers get
`maxNodes: 50` and `maxProbes: 50`, so a full-width selection runs at one probe
per node and fewer nodes buy depth instead; the console's `probesPerNode()`
does that arithmetic client-side rather than letting the server reject the
request. BYOK gets the same breadth — `maxNodes` is the structural rail
`MAX_NODES`, not a pricing lever, because they spend their own credits — and
three times the depth. `MAX_NODES × MAX_PROBES_PER_NODE` equals
`MAX_TOTAL_PROBES` by construction, so the hard rail can never be crossed on
its own; it exists to bound the work one request makes the Worker do.

429/503 responses carry `Retry-After` and the remaining allowance. They are
thrown as `QuotaError` (which carries its own `Response`), because Hono's
`HTTPException` loses a custom response when the error handler re-serialises it.

## The console shows the exception first

`public/app.js` renders results. Three rules, each paid for:

- **Order by what is wrong, in the console, not in `src/aggregate.ts`.** Nothing
  returned → failures and loss → answers in the minority → a node with a probe
  far from its peers → slowest to fastest. It used to sort by node id, so
  `cn-4134` came before `hk-4760` for no reason a reader has, while
  `latencyView`'s own comment said comparing is the entire job. The API keeps
  its stable order: that order is part of what a shared `/m/<id>` returns.
- **An outlier may reorder and highlight, never hide.** A node far from its
  peers moves up and its number turns red — far meaning **3x the baseline and
  100 ms above it**, both conditions, per probe as well as per group. The ratio
  alone reddens a probe 30 ms from its peers; the gap alone reddens every slow
  but consistent node. `test/console.test.ts` holds these numbers against the
  code, along with the others stated here — an hour of clock staleness and
  fourteen days of certificate — because three times on this branch a comment
  of mine described behaviour the code did not have. Folding "unremarkable" cards was
  tried and removed: the rule for what counts as unremarkable was invented
  here, and a bad sort costs an awkward order while a bad fold costs the thing
  the reader came to find. Length is solved by the table view instead, where
  the reader picks the density — cards up to twelve nodes, table beyond, and an
  explicit choice sticks. That threshold decides which view opens, never what
  exists in it.
- **Fold the answer, never the probe.** When every probe in a node returns the
  same records, print them once — six nodes were repeating the same three
  Cloudflare addresses thirty-six times. Each probe keeps its own line with its
  city and its query time, because HKT returned *identical* records 12 ms and
  156 ms apart and folding by answer would have deleted exactly that. TTL is
  not part of "same": it is each resolver's cache remainder, `dnsKind.ts`
  refuses to let it decide agreement, and including it split one node over 77
  versus 120 seconds on identical addresses.

Two display details that look like bugs and are not:

- **`耗时` and `解析耗时` are different numbers.** The first is the measurement's
  own round trip — for a dns run that *is* the time to resolve the target. The
  second is `ttr`, the probe resolving the target's name before a ping or an
  HTTP fetch, and it never appears in a dns run. DNS timing was measured,
  summarised and returned by the API for a long time while the page showed
  none of it, because dns is not in `LATENCY_TYPES` and the answer view
  replaces the chart those types get.
- **The table's result column is per type.** ntp shows clock offset and
  stratum, sslcert the subject and days left, http the status, traceroute the
  hop count — not the destination address for everything. A table showing only
  round-trip time reports a server hours adrift as healthy, because `ok` stays
  true and the chart above plots RTT. `outcome()` is the single source for this
  and the Markdown export uses it too.

## File map

```
public/index.html      console: markup + the whole design system (inline CSS)
public/app.js          console: chips, search, polling, card + table result views
public/fonts/          self-hosted IBM Plex woff2 — no Google Fonts (blocked in CN)
data/nodes.json        generated node catalogue + label tables + policy
data/cities.json       generated coordinate → city-name table
scripts/build-nodes.mjs  regenerates data/nodes.json from live Atlas data
scripts/build-cities.mjs regenerates data/cities.json (China by hand, rest GeoNames)
                         both import the shared rules below, so a build cannot
                         describe a different population from the runtime

src/index.ts           route assembly, error handling, DO exports, cron
src/routes/probe.ts    create + results + the quota chain, in that order
src/routes/meta.ts     nodes / presets / types / anchors / quota
src/measurements/      one file per type + the MeasurementKind contract
src/nodes.ts           catalogue access, node→probe resolution, presets, search
src/catalog.ts         CatalogCache DO — TTL sweep of live probe counts
src/quota.ts           every limit, in one place
src/gate.ts            identity (anon vs BYOK), quota checks, QuotaError
src/ratelimit.ts       RateLimiter DO — per-caller token buckets
src/budget.ts          DailyBudget DO — credit ledger, in-flight cap, dedupe
src/atlas.ts           Atlas v2 REST client (no official JS SDK exists)
src/aggregate.ts       group results by node, delegate parsing to the kind
src/dns.ts             base64 abuf → records
src/x509.ts            DER → certificate fields
src/geo.ts             probe coordinates → city name
src/geo-math.ts        the nearest-city rule — shared with build-cities.mjs
src/probe-grouping.ts  probes → cc-asn groups — shared with build-nodes.mjs
src/describe.ts        the Atlas-side label (cosmetic)

test/                  vitest; fixtures are real captured data, see below
test/fixtures/*.pem    certificates for the DER reader
```

## Tests

`npm test` runs vitest over the pure functions — parsing, validation, quota
arithmetic, aggregation. Nothing there touches the network or a Workers
runtime, so it is safe to run in a loop and costs no credits.

**A ledger is not a pure function, and pretending otherwise cost a P1.**
Whether a refund lands on the day it was charged is a question about two
`put`s and the clock between them; it cannot be lifted out and called. That
behaviour was argued in review three times and demonstrated none, and the
bug that shipped was in exactly the untested half. `npm run test:workers`
runs `RateLimiter` and `DailyBudget` in a real `workerd` with the real
bindings — the refund landing on the right day, a stale refund being dropped
rather than helping itself to a fresh ledger, a release returning both the
credits and the in-flight slot, and one de-duplication claim going to one
caller. It stays a separate command so the pure suite keeps the property
that makes it worth running constantly.

`test/workers/env.d.ts` points `Cloudflare.Env` at the Worker's own `Env`
instead of restating the bindings, so a binding renamed in `wrangler.jsonc`
fails to compile rather than arriving as `undefined` mid-test.

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

## Ask the API, not the docs

The REST API is Django REST Framework, so it will describe its own schema:

```bash
curl -s -X OPTIONS https://atlas.ripe.net/api/v2/measurements/ \
  -H "Authorization: Key $ATLAS_API_KEY" | jq '.actions.POST'
```

Every enum field comes back with its exact `choices`. This is the canonical
answer to "what will Atlas accept", and it is free and instant:

```
definitions/…/type       ping traceroute dns sslcert http ntp wifi
definitions/…/query_type A AAAA ANY CNAME DNSKEY DS MX NS NSEC PTR
                         RRSIG SOA TXT SRV NAPTR TLSA
definitions/…/protocol   UDP TCP
definitions/…/method     GET POST HEAD
definitions/…/query_class IN CHAOS
probes/…/type            area country probes asn prefix msm region countries
```

Reach for this before guessing, before reading the docs (which do not
enumerate most of these), and before probing the API by trial and error. If a
create call is rejected with `"X" is not a valid choice`, OPTIONS already knew.

Two things it reveals that this codebase deliberately does not use: the `wifi`
measurement type (needs specific probe firmware, useless for public probing)
and `POST` for http (which can only target anchors anyway).

## Commands

- `npm run dev` — `wrangler dev` (needs `.dev.vars` with `ATLAS_API_KEY`)
- `npm test` — vitest, pure functions only (no Workers pool, no network)
- `npm run test:workers` — the Durable Object ledgers in a real `workerd`, via
  `@cloudflare/vitest-pool-workers`, reading the bindings from `wrangler.jsonc`.
  Local, offline, no credits. Kept out of `npm test` because it boots a runtime
- `npm run test:e2e` — browser regression for the console, against a real
  Chromium. Stubbed by default (no Atlas key, no credits); pass a base URL and
  a **still-running** measurement id to run the same assertions against live
  data. Needs `npx playwright install chromium` once. Kept out of `npm test` so
  that stays pure and loopable
- `npm run typecheck` — `tsc --noEmit`, covers `test/` too
- `npm run nodes:refresh` — regenerate `data/nodes.json`, then commit it
- `npm run cities:refresh` — regenerate `data/cities.json`, then commit it. Prints
  a coverage report (how many live probes the table can name) to stderr
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
