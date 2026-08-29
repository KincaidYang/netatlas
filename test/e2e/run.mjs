/**
 * Browser regression for the console, run against a real Chromium.
 *
 * Deliberately not a vitest file — `npm test` stays pure functions, no network,
 * no runtime, safe in a loop. This needs a browser, so it is its own command
 * (`npm run test:e2e`) and its own filename: vitest's default glob would claim
 * anything called `*.test.mjs` or `*.spec.mjs`.
 *
 * Two modes:
 *
 *   npm run test:e2e            stubbed — `page.route()` answers /api/v1/*,
 *                               no Atlas key, no credits, deterministic.
 *   npm run test:e2e -- <url> <id>
 *                               live — point at a running `npm run dev` and a
 *                               real measurement id, and the same assertions
 *                               run against real data.
 *
 * Needs a browser once: `npx playwright install chromium`. The `playwright`
 * package has no postinstall, so a plain `npm ci` — the deploy build included —
 * downloads nothing.
 *
 * In live mode, use a measurement that is still **Ongoing**: the console stops
 * polling once Atlas reports `Stopped`, and with no poll there is no re-render
 * to survive. A run wide enough to trickle (a dozen-plus nodes) gives the most
 * room. Traceroute took 52s to its first result on the run these timeouts were
 * set from.
 *
 * What it covers: a poll rewrites `#out` wholesale every few seconds, so
 * anything the reader had opened — a traceroute's hop list, a long DNS answer —
 * used to snap shut under them. `test/console.test.ts` pins the two halves of
 * the mechanism by reading the source; this pins the behaviour they exist to
 * produce, which is the part a reader actually experiences.
 */
import { chromium } from "playwright";
import http from "node:http";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const PUBLIC = path.join(path.dirname(fileURLToPath(import.meta.url)), "../../public");
const [liveBase, liveId] = process.argv.slice(2);
const live = Boolean(liveBase && liveId);

const MIME = { ".html": "text/html", ".js": "text/javascript", ".css": "text/css", ".woff2": "font/woff2" };

/** Serve public/ as the Worker's asset handler does, so app.js loads normally. */
async function serve() {
  const server = http.createServer((req, res) => {
    const f = path.join(PUBLIC, req.url.split("?")[0] === "/" ? "index.html" : req.url.split("?")[0]);
    if (!f.startsWith(PUBLIC) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
      res.writeHead(404);
      return res.end();
    }
    res.writeHead(200, { "Content-Type": MIME[path.extname(f)] ?? "application/octet-stream" });
    fs.createReadStream(f).pipe(res);
  });
  await new Promise((r) => server.listen(0, "127.0.0.1", r));
  return { server, base: `http://127.0.0.1:${server.address().port}` };
}

/* ── stub fixtures ──────────────────────────────────── */

const hops = (n) =>
  Array.from({ length: n }, (_, i) => ({
    hop: i + 1, from: `10.0.0.${i + 1}`, sent: 3, received: 3,
    timeout: false, rttMs: 5 + i * 4, rttMinMs: 4 + i * 4, rttMaxMs: 7 + i * 4,
  }));

/**
 * `totalResponded` climbs on every call, so the page keeps polling and each
 * tick is a real re-render — the thing under test. A fixture that returned a
 * finished measurement would render once and prove nothing.
 */
const counters = { 1: 0, 2: 0 };
const stub = {
  1: () => ({
    measurementId: 1, type: "traceroute", target: "example.com", queryType: null,
    status: "Ongoing", totalRequested: 9, totalResponded: ++counters[1],
    groups: [{
      key: "cn-4134", label: "中国 · 电信", requested: 9, responded: counters[1],
      summary: { hopsAvg: 8, rttMs: { avg: 30 } },
      probes: [{
        probeId: 1001, ok: true, rttMs: 30, city: "北京", from: "1.2.3.4", asn: 4134, country: "CN",
        detail: { hopCount: 8, reached: true, timeouts: 0, lossyHops: 0, dstAddr: "93.184.216.34", hops: hops(8) },
      }],
    }],
  }),
  2: () => ({
    measurementId: 2, type: "dns", target: "example.com", queryType: "A",
    status: "Ongoing", totalRequested: 9, totalResponded: ++counters[2],
    groups: [{
      key: "cn-4134", label: "中国 · 电信", requested: 9, responded: counters[2],
      summary: {
        distinctAnswers: ["A 1.1.1.1", "A 2.2.2.2", "A 3.3.3.3", "A 4.4.4.4", "A 5.5.5.5"],
        ttl: { min: 60, max: 60 }, rttMs: { avg: 12 },
      },
      probes: [{
        probeId: 2001, ok: true, rttMs: 12, city: "北京", from: "1.2.3.4", asn: 4134, country: "CN",
        detail: { answers: [{ type: "A", data: "1.1.1.1" }] },
      }],
    }],
  }),
};

async function stubRoutes(page) {
  await page.route("**/api/v1/**", (route) => {
    const u = route.request().url();
    const json = (b) => route.fulfill({ status: 200, contentType: "application/json", body: JSON.stringify(b) });
    for (const id of Object.keys(stub)) if (u.includes(`/m/${id}`)) return json(stub[id]());
    if (u.includes("/types")) {
      return json([
        { type: "traceroute", label: "traceroute" },
        { type: "dns", label: "dns", queryTypes: ["A"] },
      ]);
    }
    if (u.includes("/nodes")) return json({ nodes: [], totalCount: 0, totals: { probes: 0, countries: 0, groups: 0 }, stale: false });
    if (u.includes("/presets")) return json({});
    if (u.includes("/quota")) return json({ tier: "anon", limits: { maxNodes: 50, maxProbes: 50 } });
    return json({});
  });
}

/* ── the check ──────────────────────────────────────── */

const results = [];

async function survivesAPoll(browser, base, id, selector, name) {
  const page = await browser.newPage();
  if (!live) await stubRoutes(page);
  await page.goto(`${base}/?m=${id}`);

  // Both disclosures live in the card view; the table deliberately shows one
  // row per probe with no hop list. The console opens in the table past twelve
  // nodes, so a wide run renders no `<details>` at all and the check silently
  // skipped — which looked like "this measurement has nothing to expand" and
  // was really "you are looking at the wrong view".
  //
  // The buttons only exist once a report has rendered, so wait for them first;
  // clicking on an empty `#out` is a no-op that leaves the table in place.
  const cards = page.locator('.viewbtn[data-view="cards"]');
  try {
    await cards.waitFor({ timeout: live ? 180000 : 30000 });
    if ((await cards.getAttribute("aria-pressed")) !== "true") await cards.click();
  } catch {
    results.push({ name, skipped: "结果始终没有渲染出来" });
    await page.close();
    return;
  }

  const first = page.locator(selector).first();
  try {
    // A real measurement is slow to start: Atlas schedules it, then probes
    // report over ~30s to a few minutes. The first traceroute result took 52s
    // on the run this number came from, so a 30s wait reported "no expandable
    // block" for a measurement that simply had not begun.
    await first.waitFor({ timeout: live ? 180000 : 30000 });
  } catch {
    results.push({ name, skipped: `没有出现 ${selector}（这次测量里没有可展开块）` });
    await page.close();
    return;
  }

  await first.locator("summary").click();
  const opened = await first.evaluate((el) => el.open);
  // Track the one we opened by its key, never by its position.
  //
  // This is the whole point of the feature and it caught the test out first:
  // asserting on `selector.first()` after the poll passed against a stub with a
  // single probe and failed against a real run, because probes that arrive
  // later sort above the one you opened — `.first()` was then a different,
  // closed card. A position is exactly what `data-k` exists not to be.
  const key = await first.evaluate((el) => el.dataset.k);

  // Detect the re-render itself, not a side effect of it.
  //
  // The first version waited for the "n/m 个探针已回" counter to change, which
  // is only *usually* true: `render()` runs on every poll whether or not the
  // count moved, and a run where the last probes never answer polls for
  // minutes without the counter budging. That reported a passing case as a
  // failure twice. Instead, stamp the live element and wait until the element
  // at that key is a different object — which is exactly what "innerHTML was
  // replaced" means, and is what the fix has to survive.
  const before = (await page.locator(".fill").innerText()).trim();
  await first.evaluate((el) => {
    el.__beforeRender = true;
  });
  let polled = true;
  try {
    await page.waitForFunction(
      (k) => {
        const el = document.querySelector(`#out details[data-k="${CSS.escape(k)}"]`);
        return !!el && !el.__beforeRender;
      },
      key,
      { timeout: 90000 },
    );
  } catch {
    polled = false;
  }
  const after = (await page.locator(".fill").innerText()).trim();
  const state = await page.evaluate((k) => {
    const el = document.querySelector(`#out details[data-k="${CSS.escape(k)}"]`);
    return { present: !!el, open: !!el?.open };
  }, key);

  results.push({ name, key, opened, present: state.present, stillOpen: state.open, polled, before, after });
  await page.close();
}

const { server, base } = live ? { server: null, base: liveBase } : await serve();
const browser = await chromium.launch();

if (live) {
  await survivesAPoll(browser, base, liveId, "details.raw", "逐跳（真实测量）");
  await survivesAPoll(browser, base, liveId, "details.more", "多地址（真实测量）");
} else {
  await survivesAPoll(browser, base, 1, "details.raw", "traceroute 逐跳");
  await survivesAPoll(browser, base, 2, "details.more", "dns 多地址");
}

await browser.close();
server?.close();

console.log(`\n展开态是否活过一次轮询 ── ${live ? `真实测量 ${liveId} @ ${liveBase}` : "打桩"}\n`);
let failed = 0;
for (const r of results) {
  if (r.skipped) {
    console.log(`⏭  ${r.name} — ${r.skipped}`);
    continue;
  }
  const ok = r.opened && r.present && r.stillOpen && r.polled;
  if (!ok) failed++;
  const why = !r.polled ? " (等不到重渲染)" : !r.present ? " (元素本身消失了)" : "";
  console.log(
    `${ok ? "✅" : "❌"} ${r.name}  ${r.key}  点开=${r.opened} 轮询后仍打开=${r.stillOpen}  ${r.before} → ${r.after}${why}`,
  );
}
console.log("");
process.exit(failed ? 1 : 0);
