# netatlas

On-demand **multi-region DNS probing** over [RIPE Atlas](https://atlas.ripe.net/), deployed as a Cloudflare Worker. Pass a domain → it launches a one-off DNS measurement across probes in several regions → returns per-region resolution results.

## Setup

```bash
npm install

# local dev: copy and fill in your key
cp .dev.vars.example .dev.vars     # set ATLAS_API_KEY
npm run dev

# deploy
npx wrangler secret put ATLAS_API_KEY     # required, account needs credits
npx wrangler secret put API_TOKEN         # optional bearer gate (recommended)
npm run deploy
```

### ⚠️ Setting `ATLAS_API_KEY` correctly (read this)

It **must be a runtime Worker secret**. Two common ways to get this wrong:

- **A plaintext Variable** (dashboard → Variables and Secrets → *Variable*): if you deploy via CI (`wrangler deploy`), it gets **wiped** on the next deploy, because `wrangler.jsonc` declares no `vars` and the config is treated as the source of truth for plaintext vars. (Symptom: a deployment titled "deleted variable: ATLAS_API_KEY".)
- **A Workers Builds *build* variable** (dashboard → Settings → Builds): only available during `npm install` / `wrangler deploy`, **never at runtime** — so `c.env.ATLAS_API_KEY` is always empty and Atlas returns `401 "key does not exist"`.

✅ Correct: a runtime **Secret**. Easiest and CI-safe:

```bash
npx wrangler secret put ATLAS_API_KEY      # writes directly to the Worker
```

Secrets are **preserved across `wrangler deploy`**, so CI rebuilds won't clobber it. (You can also add it as a *Secret* — not Variable, not build var — in the dashboard, then click **Deploy** to publish a version with it.)

## API

### `POST /probe` — create a measurement (async)

```jsonc
{
  "domain": "example.com",
  "queryType": "A",          // A AAAA CNAME NS SOA TXT MX PTR SRV CAA (default A); others → 400
  "af": 4,                    // 4 | 6 (default 4)
  "regionSet": "global",      // preset name (see GET /presets)
  "countries": ["US","JP"],  // OR explicit ISO codes (overrides regionSet)
  "probesPerRegion": 3,       // 1..5, total capped at 50 probes
  "target": "8.8.8.8"         // optional: query this resolver instead of the probe's own
}
```

→ `201 { "measurementId": 12345678, "requested": {"US":3,...}, "resultsUrl": "/probe/12345678" }`

### `GET /probe/:id` — fetch + aggregate results

```jsonc
{
  "measurementId": 12345678,
  "status": "Stopped",
  "totalRequested": 30,
  "totalResponded": 27,
  "byRegion": [
    { "country": "US", "requested": 3, "responded": 3,
      "probes": [{ "probeId": 1001, "asn": 7922, "rttMs": 18.4,
                   "answers": [{ "name": "example.com", "type": "A", "ttl": 300, "data": "93.184.216.34" }] }] },
    { "country": "JP", "requested": 3, "responded": 1, "probes": [/* ... */] }
  ]
}
```

`requested` vs `responded` exposes under-filled regions — don't read a single probe as a regional verdict.

### `POST /probe/sync` — create then short-poll

Same body as `/probe`, plus `?timeout=ms` (default 20000, max 25000). Creates the measurement and polls until it stops or the timeout hits, returning whatever has arrived. Convenience for "instant" use; partial results are expected within the window.

## Notes / caveats

- **Async by nature:** Atlas schedules global probes; full results take ~30s–few min. The two-phase API (`POST` then `GET`) is the reliable path; `/probe/sync` is best-effort within the Worker request window.
- **Credits:** every probe per measurement costs Atlas credits. Probe count is capped (≤5/region, ≤50 total) and `API_TOKEN` gates access — but there is no per-caller rate limiter yet (would need KV or a Durable Object).
- **Probe selection:** picks currently-connected probes per country tagged `system-ipv4-works`/`system-ipv6-works`. Fresh selection each run (not pinned), so the exact vantage points vary between runs.
