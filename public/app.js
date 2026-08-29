"use strict";

/* netatlas console — no build step, no framework. */

const API = "/api/v1";
/** Probes per node when the selection is small enough to afford them. */
const PER_NODE = 2;

/**
 * What to assume before /quota answers, and whenever the answer is in doubt.
 * Too small only trims a selection; too large invites a 400 the caller cannot
 * see coming, or a bill twice the one displayed.
 */
const CAUTIOUS_LIMITS = { maxNodes: 8, maxPerNode: 2, maxProbes: 16 };
const POLL_MS = 3000;
/** Ceiling once results stop arriving; see load(). */
const POLL_MAX_MS = 20000;
const POLL_LIMIT_MS = 5 * 60 * 1000;

/** Types whose story is "how long did it take"; the rest are "what came back". */
const LATENCY_TYPES = new Set(["ping", "traceroute", "http", "ntp"]);

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ms = (v) => (v == null ? "—" : v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`);

/** NTP clock precision arrives in seconds and is usually nanoseconds' worth. */
const precision = (sec) => {
  if (sec == null) return null;
  const ns = sec * 1e9;
  if (ns < 1000) return `${Math.round(ns)} ns`;
  if (ns < 1e6) return `${(ns / 1000).toFixed(1)} µs`;
  return `${(ns / 1e6).toFixed(1)} ms`;
};

const age = (sec) => {
  if (sec < 60) return `${Math.round(sec)} 秒`;
  if (sec < 3600) return `${Math.round(sec / 60)} 分钟`;
  return `${(sec / 3600).toFixed(1)} 小时`;
};

const state = {
  types: [],
  nodes: [],
  known: new Map(),
  presets: {},
  /** The result currently on screen, if any. */
  report: null,
  /** Whether the result on screen is still being refreshed. */
  polling: false,
  limits: { ...CAUTIOUS_LIMITS },
  /**
   * "cards" | "table", or null until a run decides. Density is the reader's
   * call; this only picks which view opens first, and both show everything.
   */
  view: localStorage.getItem("view") || null,
  /** Row order held steady across polls: { id, keys }. */
  order: null,
  selected: new Set(),
  showingAll: false,
  timer: null,
  startedAt: 0,
};

const apiKey = () => $("apikey").value.trim();

async function api(path, options = {}) {
  const headers = { ...(options.headers || {}) };
  const key = apiKey();
  if (key) headers["X-Atlas-Key"] = key;
  if (options.body) headers["Content-Type"] = "application/json";
  const res = await fetch(API + path, { ...options, headers });
  const body = await res.json().catch(() => ({ error: `HTTP ${res.status}` }));
  if (!res.ok) throw Object.assign(new Error(body.error || `HTTP ${res.status}`), { body, status: res.status });
  return body;
}

/* ── setup ──────────────────────────────────────────── */

async function init() {
  // A shared link exists to show one result, so ask for it before anything
  // else. Queuing it behind the node catalogue (which is the slowest request
  // on the page) left the result area blank for over a second.
  const shared = Number(new URLSearchParams(location.search).get("m")) || null;
  if (shared) load(shared);

  $("apikey").value = localStorage.getItem("atlasKey") || "";
  $("apikey").addEventListener("change", () => {
    localStorage.setItem("atlasKey", apiKey());
    // Drop to the conservative floor *now*. Until /quota answers we do not know
    // which tier this key buys, and holding the old tier's allowance would let
    // the console promise something the server is about to refuse.
    state.limits = { ...CAUTIOUS_LIMITS };
    refreshQuota();
  });

  const [types, nodes, presets] = await Promise.all([
    api("/types"),
    api("/nodes"),
    api("/presets"),
  ]);
  state.types = types;
  state.nodes = nodes.nodes;
  remember(nodes.nodes);
  state.totalNodes = nodes.totalCount;
  state.presets = presets;

  $("type").innerHTML = types.map((t) => `<option value="${t.type}">${esc(t.label)}</option>`).join("");
  // The API takes ten DNS record types and /types advertises them; without a
  // selector the console could only ever ask for A, i.e. only ever see IPs.
  const qtypes = types.find((t) => t.type === "dns")?.queryTypes ?? [];
  $("qtype").innerHTML = qtypes.map((q) => `<option value="${esc(q)}">${esc(q)}</option>`).join("");
  // The result may already be on screen; the type select only exists now.
  syncFormTo(state.report);
  $("more").textContent = `展开全部 ${nodes.totalCount} 个节点`;
  renderScale(nodes.totals);
  // Not polled. The catalogue behind these numbers only moves when the sweep
  // runs, every three hours, so a timer would spend hundreds of requests
  // redrawing the same figure. The one moment it does change is this one: a
  // stale catalogue means *this* page load just triggered a sweep and did not
  // wait for it, so the visitor who paid for it would otherwise be the only
  // one to see the old number. Come back once, after the edge cache expires.
  if (nodes.stale) setTimeout(refreshScale, 65_000);
  renderRegions();
  renderPresets();
  wireSearch();
  await refreshQuota();
  applyPreset("global");
  document.querySelector('[data-preset="global"]')?.setAttribute("aria-pressed", "true");
  syncTypeHint();

  $("type").addEventListener("change", () => {
    updateCost();
    syncTypeHint();
  });
  $("more").addEventListener("click", toggleAll);
  $("clear").addEventListener("click", () => {
    state.selected.clear();
    syncChips();
  });
  $("q").addEventListener("submit", submit);
}

/**
 * Make the controls agree with whatever result is on screen, so "run it
 * again" does the same thing. Called both when a report arrives and when the
 * type select is finally populated — either can happen first.
 */
function syncFormTo(report) {
  if (!report) return;
  const select = $("type");
  if (select.options.length > 0 && select.value !== report.type) {
    select.value = report.type;
    syncTypeHint();
  }
  // A shared link should say which record was asked for, not silently sit on A.
  const qtype = $("qtype");
  if (report.queryType && qtype.options.length > 0) qtype.value = report.queryType;
  if (!$("target").value) $("target").value = String(report.target ?? "").replace(/\.$/, "");
}

/**
 * One selectable node. A node with a single probe is dimmed and its count
 * reddened rather than hidden: search reaches every country×operator pair
 * Atlas has a probe in, and about two thirds of those have exactly one. It can
 * still answer, and when it does not the result says 0/1 — which is a fact the
 * reader can act on. Hiding them would make "全部在线节点" a lie.
 */
/**
 * Every node the console has seen, by id — from the featured list, the full
 * catalogue, a preset, or a search hit. `state.nodes` is only ever the page
 * currently rendered, so without this a node selected from search results
 * would vanish from the "已选" summary the moment the search box was cleared.
 */
function remember(nodes) {
  for (const n of nodes ?? []) state.known.set(n.id, n);
}

function nodeChip(n) {
  const thin = n.probes === 1;
  const hint = n.probes === 0 ? "当前无在线探针" : thin ? "只有 1 个在线探针，可能不出结果" : `${n.probes} 个在线探针`;
  return (
    `<button type="button" class="chip${thin ? " thin" : ""}" data-node="${esc(n.id)}" aria-pressed="false"` +
    `${n.probes === 0 ? " disabled" : ""} title="${esc(n.id)} · ${esc(hint)}">` +
    `${esc(n.label)}<span class="n">${n.probes}</span></button>`
  );
}

/**
 * What Atlas holds right now, next to what the picker shows.
 *
 * The catalogue curates ~240 country×operator pairs out of about five
 * thousand, and the search box exists because of that gap — saying so is more
 * honest than a picker that quietly implies it is the whole world. Hidden
 * until the numbers are real: the cold-start seed has no live totals, and an
 * invented figure would be worse than none.
 */
async function refreshScale() {
  try {
    const data = await api(state.showingAll ? "/nodes?all=1" : "/nodes");
    // Only the headline figure: repainting the picker under someone who is
    // mid-selection would be a worse trade than a slightly old number.
    renderScale(data.totals);
  } catch {
    /* the number on screen is still true, just older */
  }
}

function renderScale(totals) {
  const el = $("scale");
  if (!totals?.probes) {
    el.hidden = true;
    return;
  }
  const n = (v) => `<b>${v.toLocaleString("en-US")}</b>`;
  // Not "此刻": the sweep is up to three hours old. And "组合" rather than
  // "运营商", because a group is one operator *in one country* — AS3320 in
  // Germany and in the Netherlands are two of these, not one.
  el.innerHTML =
    `RIPE Atlas 在线探针 ${n(totals.probes)} 个` +
    `<span class="sep">·</span>覆盖 ${n(totals.countries)} 个国家和地区` +
    `<span class="sep">·</span>${n(totals.groups)} 个 地区×运营商 组合全部可搜索`;
  el.hidden = false;
}

function renderRegions() {
  const byRegion = new Map();
  for (const n of state.nodes) {
    if (!byRegion.has(n.continent)) byRegion.set(n.continent, []);
    byRegion.get(n.continent).push(n);
  }
  $("regions").innerHTML = [...byRegion.entries()]
    .map(
      ([region, list]) =>
        `<div class="region"><h2>${esc(region)}</h2><div class="chips">${list.map(nodeChip).join("")}</div></div>`,
    )
    .join("");

  bindChips();
}

function bindChips() {
  for (const chip of document.querySelectorAll("[data-node]")) {
    chip.addEventListener("click", () => {
      const id = chip.dataset.node;
      if (state.selected.has(id)) {
        state.selected.delete(id);
      } else if (state.selected.size >= state.limits.maxNodes) {
        return notice(
          `当前身份一次最多选 ${state.limits.maxNodes} 个节点。填入自己的 Atlas Key 可以放宽。`,
          "info",
        );
      } else {
        state.selected.add(id);
      }
      syncChips();
    });
  }
  syncChips();
}

/**
 * Search across every country×operator pair Atlas has a connected probe in —
 * about 5,000, against the ~240 the catalogue curates. The catalogue exists
 * because 5,000 chips is not a picker; this is how the rest stay reachable.
 *
 * Selection needs nothing from the catalogue: a node id is `cc-asn` and
 * self-describing, so a pair found here is measurable even though no chip for
 * it was ever rendered.
 */
let searchSeq = 0;
let searchTimer = null;

function wireSearch() {
  const input = $("nodesearch");
  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    // A keystroke is not a query. 250 ms is under the threshold where typing
    // feels laggy and well over the rate at which people type.
    searchTimer = setTimeout(() => runSearch(input.value), 250);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
      input.value = "";
      runSearch("");
    }
  });
}

async function runSearch(query) {
  const q = query.trim();
  const seq = ++searchSeq;
  if (!q) {
    $("searchnote").textContent = "";
    return renderRegions();
  }
  $("searchnote").textContent = "搜索中…";
  try {
    const data = await api(`/nodes?q=${encodeURIComponent(q)}`);
    // A slower earlier request must not overwrite a newer one's results.
    if (seq !== searchSeq) return;
    renderSearch(data);
  } catch (err) {
    if (seq === searchSeq) $("searchnote").textContent = `搜索失败：${err.message}`;
  }
}

function renderSearch(data) {
  const nodes = data.nodes ?? [];
  if (nodes.length === 0) {
    $("regions").innerHTML = "";
    // Most of those ASNs have no resolved holder — the catalogue names a
    // handful per sweep — so they read as "AS12345" and an operator name will
    // never find them. Saying so beats letting the reader conclude the node
    // does not exist.
    $("searchnote").textContent =
      `没有匹配的节点（已搜索 ${data.searched ?? 0} 个国家×运营商组合）。` +
      `多数运营商没有名称、只显示 ASN，可以改用 ASN 或国家名搜索`;
    return;
  }
  remember(nodes);
  const thin = nodes.filter((n) => n.probes === 1).length;
  $("regions").innerHTML =
    `<div class="region"><h2>搜索结果</h2><div class="chips">${nodes.map(nodeChip).join("")}</div></div>`;
  const shown = data.matched > nodes.length ? `显示前 ${nodes.length} / ${data.matched} 个匹配` : `${nodes.length} 个匹配`;
  $("searchnote").textContent =
    `${shown}，来自 RIPE 全部 ${data.searched ?? 0} 个国家×运营商组合` +
    (thin ? `。其中 ${thin} 个只有 1 个在线探针，可能不出结果` : "");
  bindChips();
}

function renderPresets() {
  $("presets").innerHTML = Object.keys(state.presets)
    .map((name) => `<button type="button" class="chip" data-preset="${esc(name)}">${esc(presetLabel(name))}</button>`)
    .join("");
  for (const btn of document.querySelectorAll("[data-preset]")) {
    btn.addEventListener("click", () => {
      applyPreset(btn.dataset.preset);
      for (const other of document.querySelectorAll("[data-preset]")) {
        other.setAttribute("aria-pressed", other === btn ? "true" : "false");
      }
    });
  }
}

/**
 * One per continent, plus 全球 and 中国 — the same regions the chip sections
 * below use, so the two rows cannot disagree about what a region is. A preset
 * the catalogue has no nodes for simply does not render.
 */
const PRESET_LABELS = {
  global: "全球",
  china: "中国",
  asia: "亚洲",
  europe: "欧洲",
  north_america: "北美",
  south_america: "南美",
  africa: "非洲",
  oceania: "大洋洲",
  antarctica: "南极洲",
};
const presetLabel = (name) => PRESET_LABELS[name] || name;

/**
 * Apply a preset.
 *
 * The selection happens **synchronously**, before anything is fetched: a click
 * must be in effect by the time it returns, or submitting straight afterwards
 * measures the previous preset, and a second click can be overtaken by the
 * first one's late response.
 *
 * Only the labels are hydrated asynchronously — a preset may name nodes
 * outside the short featured list (中国 reaches for Hong Kong and Taiwan
 * carriers that are not in it), and those would otherwise read as bare ids.
 * That request is guarded by a sequence token so a slow one cannot repaint a
 * newer preset's summary.
 */
let presetSeq = 0;

function applyPreset(name) {
  const ids = state.presets[name];
  if (!ids) return;
  // Only drop what we know is empty. An unknown id is still measurable — the
  // server resolves `cc-asn` against live Atlas, not against this catalogue.
  const usable = ids.filter((id) => (state.known.get(id)?.probes ?? 1) > 0);
  // Presets are shared with API callers and can be larger than this caller's
  // tier allows; trim rather than let the server reject the default flow.
  state.selected = new Set(usable.slice(0, state.limits.maxNodes));
  syncChips();

  const seq = ++presetSeq;
  if (ids.some((id) => !state.known.has(id))) {
    api("/nodes?all=1")
      .then((data) => {
        if (seq !== presetSeq) return;
        remember(data.nodes);
        syncChosen();
      })
      .catch(() => {
        /* labels degrade to the id; selection already happened and still works */
      });
  }
}

async function toggleAll() {
  state.showingAll = !state.showingAll;
  const data = await api(state.showingAll ? "/nodes?all=1" : "/nodes");
  state.nodes = data.nodes;
  remember(data.nodes);
  renderScale(data.totals);
  $("more").textContent = state.showingAll ? "只看常用节点" : `展开全部 ${data.totalCount} 个节点`;
  renderRegions();
}

function syncChips() {
  for (const chip of document.querySelectorAll("[data-node]")) {
    chip.setAttribute("aria-pressed", state.selected.has(chip.dataset.node) ? "true" : "false");
  }
  syncChosen();
  updateCost();
}

/** The collapsed picker still has to say what is selected, by name. */
function syncChosen() {
  // Keep catalogue order (grouped by continent) so the summary reads like a
  // route, then append anything picked from search, which has no place in it.
  const inOrder = state.nodes.filter((n) => state.selected.has(n.id)).map((n) => n.id);
  const offCatalogue = [...state.selected].filter((id) => !inOrder.includes(id));
  const labels = [...inOrder, ...offCatalogue].map((id) => state.known.get(id)?.label ?? id);
  const shown = labels.slice(0, 4).join("、");
  const rest = labels.length > 4 ? ` +${labels.length - 4}` : "";
  $("chosen").innerHTML = labels.length
    ? `已选 <b>${labels.length}</b> 个节点：${esc(shown)}${esc(rest)}`
    : "未选节点";
}

/**
 * Probes per node for the current selection.
 *
 * The server caps nodes x probes, not nodes alone — two probes each across 50
 * nodes is 100, over the anonymous ceiling of 50. Asking for more than fits
 * would be rejected outright, so a wide selection trades depth for breadth
 * instead of failing. Never below one: that is what makes the node a node.
 */
function probesPerNode(n) {
  const cap = state.limits.maxProbes ?? 50;
  const want = Math.min(PER_NODE, state.limits.maxPerNode ?? PER_NODE);
  return n > 0 ? Math.max(1, Math.min(want, Math.floor(cap / n))) : want;
}

function updateCost() {
  const type = state.types.find((t) => t.type === $("type").value);
  const n = state.selected.size;
  if (!type || n === 0) {
    $("cost").textContent = "选择节点后估算消耗";
    return;
  }
  const per = probesPerNode(n);
  const credits = type.creditsPerProbe * n * per;
  const note = per < Math.min(PER_NODE, state.limits.maxPerNode ?? PER_NODE)
    ? `（节点多，每节点降到 ${per} 个探针以内不超上限）`
    : "";
  $("cost").innerHTML = `<b>${n}</b> 个节点 × ${per} 探针 · 预估 <b>${credits}</b> credits${esc(note)}`;
}

function syncTypeHint() {
  const type = $("type").value;
  $("qtype").hidden = type !== "dns";
  const hint = {
    http: "HTTP 只能打 RIPE anchor，测的是到 anchor 的链路，不是你自己网站的可用性",
    traceroute: "traceroute 单价是 ping 的 10 倍，限额更紧",
    dns: "查询每个探针本地的递归解析器，能看出 CDN 的真实调度",
  }[type];
  $("typehint").textContent = hint || "";
  $("target").placeholder =
    type === "http" ? "xx-xxx.anchors.atlas.ripe.net" : type === "ntp" ? "pool.ntp.org" : "example.com · 1.1.1.1";
}

/**
 * The in-flight quota refresh, so a submit can wait for it.
 *
 * Limits decide `probesPerNode()`, and that number is both shown to the user
 * and sent to the server. Submitting against limits that are about to change
 * means one of two failures: a 400 for a selection the console just allowed,
 * or — worse, because it is silent — spending twice the credits displayed.
 */
let quotaPending = null;
let quotaSeq = 0;

function refreshQuota() {
  // Awaiting the newest promise is not enough on its own: two key changes in
  // quick succession leave two requests in flight, and the older one still
  // writes when it lands. Going BYOK → anonymous that way restores the BYOK
  // allowance after the anonymous answer, which is exactly the state that
  // spends twice what the cost line shows.
  const seq = ++quotaSeq;
  quotaPending = (async () => {
    try {
      const q = await api("/quota");
      if (seq !== quotaSeq) return;
      state.limits = { maxNodes: q.maxNodes, maxPerNode: q.maxPerNode, maxProbes: q.maxProbes };
      if (state.selected.size > q.maxNodes) {
        state.selected = new Set([...state.selected].slice(0, q.maxNodes));
      }
      // The ceiling belongs to the tier, so it is read from /quota rather than
      // written into the copy. A number in two places is a number that will
      // disagree with itself — and until it arrives the sentence simply reads
      // without one, the same rule the scale line follows.
      $("ledecap").textContent = `（一次最多 ${q.maxNodes} 个）`;
      const daily = q.creditsLimit ? ` · 今日已用 ${q.creditsUsedToday}/${q.creditsLimit}` : "";
      $("quota").innerHTML =
        q.tier === "byok"
          ? `使用你自己的 Key · 可选 <b>${q.maxNodes}</b> 个节点`
          : `匿名额度 <b>${q.tokensLeft}</b>/${q.tokenCapacity} 次${daily}`;
    } catch {
      if (seq === quotaSeq) $("quota").textContent = "";
    } finally {
      // Unconditionally, not only when the selection had to be trimmed: the
      // probe budget moves with the tier, so 30 nodes can go from one probe
      // each to two without the selection changing at all.
      if (seq === quotaSeq) syncChips();
    }
  })();
  return quotaPending;
}

/* ── running ────────────────────────────────────────── */

async function submit(event) {
  event.preventDefault();
  const target = $("target").value.trim();
  if (!target) return $("target").focus();
  if (state.selected.size === 0) return notice("先选至少一个节点。", "info");

  stopPolling();
  $("go").disabled = true;
  $("out").innerHTML = `<p class="hint">正在向 ${esc(target)} 发起拨测…</p>`;

  // A key typed a moment ago may still be in flight. Submitting first would
  // send the previous tier's perNode against the new tier's ceiling.
  await quotaPending;

  try {
    const created = await api("/probe", {
      method: "POST",
      body: JSON.stringify({
        type: $("type").value,
        target,
        nodes: [...state.selected],
        perNode: probesPerNode(state.selected.size),
        ...($("type").value === "dns" ? { queryType: $("qtype").value } : {}),
      }),
    });
    history.replaceState(null, "", `?m=${created.measurementId}`);
    if (created.unavailable?.length) {
      notice(`这些节点当前没有在线探针，已跳过：${created.unavailable.join("、")}`, "info");
    }
    load(created.measurementId);
  } catch (err) {
    showError(err);
  } finally {
    $("go").disabled = false;
    refreshQuota();
  }
}

/**
 * Poll until the measurement settles, backing off when nothing is happening.
 *
 * A node that under-fills is normal, not a reason to keep asking: China has
 * ~65 connected probes nationwide, so "19/20 responded" is often the final
 * answer and the twentieth is never coming. Every three seconds for minutes
 * on end is then pure waste — three Atlas round trips a poll, none of them
 * cacheable while the measurement is unfinished.
 *
 * So the interval stays at 3s while results are still arriving and grows to
 * 20s once the count stops moving. Atlas flips a one-off to Stopped a few
 * minutes in, which is what actually ends the loop.
 */
function load(id) {
  stopPolling();
  state.startedAt = Date.now();
  state.polling = true;
  let delay = POLL_MS;
  let lastResponded = -1;

  const tick = async () => {
    try {
      const report = await api(`/m/${id}`);
      delay = report.totalResponded === lastResponded ? Math.min(delay * 1.6, POLL_MAX_MS) : POLL_MS;
      lastResponded = report.totalResponded;

      const done =
        report.status === "Stopped" ||
        report.totalResponded >= report.totalRequested ||
        Date.now() - state.startedAt > POLL_LIMIT_MS;
      // Set before rendering: the header says whether we are still waiting.
      state.polling = !done;
      render(report, id);
      if (!done) state.timer = setTimeout(tick, delay);
    } catch (err) {
      stopPolling();
      showError(err);
    }
  };
  tick();
}

function stopPolling() {
  if (state.timer) clearTimeout(state.timer);
  state.timer = null;
  state.polling = false;
}

/* ── rendering ──────────────────────────────────────── */

function render(report, id) {
  state.report = report;
  syncFormTo(report);

  const partial = report.totalResponded < report.totalRequested;
  const running = state.polling && partial;
  const target = String(report.target ?? "").replace(/\.$/, "");
  // Say why the number stopped moving, rather than leaving "等待中" on screen
  // for something that is never going to arrive.
  const note = running
    ? " · 等待中"
    : !partial
      ? ""
      : report.status === "Stopped"
        ? " · 测量已结束"
        : " · 已停止刷新";
  // Each probe resolves the target itself, so the addresses they actually
  // reached are part of the answer: one everywhere means anycast or a single
  // origin, several means DNS is steering by region.
  const ips = [
    ...new Set(report.groups.flatMap((g) => g.probes.map((p) => p.detail?.dstAddr)).filter(Boolean)),
  ];
  const resolved =
    ips.length === 1
      ? `<span class="resolved">解析到 ${esc(ips[0])}</span>`
      : ips.length > 1
        ? `<span class="resolved" title="${esc(ips.join(" · "))}">解析到 <b>${ips.length}</b> 个不同 IP</span>`
        : "";

  // One order for both blocks, or the chart and the cards disagree about what
  // comes first.
  //
  // Frozen while the run is still going. Ranks depend on results, and results
  // arrive over minutes — re-sorting every three seconds moves rows out from
  // under whoever is reading them. The order is taken once and kept, with
  // newcomers appended in rank order, until the run stops updating — `running`
  // above, which is polling *and* still short of a full response.
  const ranked = ordered(report);
  const groups = running && state.order?.id === id ? hold(state.order.keys, ranked) : ranked;
  state.order = { id, keys: groups.map((g) => g.key) };
  // Cards read better for a handful of nodes and become a wall past a dozen,
  // so that is where the first view flips. A weak judgement on purpose: it
  // decides what opens, never what exists, and one click overrides it for good.
  const view = state.view ?? (groups.length > 12 ? "table" : "cards");

  const head =
    `<div class="runhead">` +
    `<span class="kind">${esc(report.type)}</span>` +
    `${report.queryType ? `<span class="qt">${esc(report.queryType)}</span>` : ""}` +
    `<span class="what">${esc(target)}</span>` +
    resolved +
    `<span class="fill${partial && !running ? " partial" : ""}">` +
    `${report.totalResponded}/${report.totalRequested} 个探针已回${note}</span>` +
    `<span class="views">` +
    `<button type="button" class="viewbtn" data-view="cards"${view === "cards" ? ' aria-pressed="true"' : ""}>卡片</button>` +
    `<button type="button" class="viewbtn" data-view="table"${view === "table" ? ' aria-pressed="true"' : ""}>表格</button>` +
    `</span>` +
    `<button type="button" id="md">复制 Markdown</button>` +
    `<button type="button" id="share">复制链接</button></div>`;

  // A poll rewrites this whole block every three seconds, so anything the
  // reader had opened — a traceroute's hop list, a long DNS answer — snapped
  // shut under them. That is the same complaint `state.order` above answers
  // for row order: results arrive over minutes, and the reader is mid-sentence.
  //
  // Read before anything is rebuilt: `answerView` replaces `state.answers`, and
  // what the reader had open is described by the previous one.
  //
  // Only within one measurement, the way `state.order` scopes itself. Across
  // runs these keys are not evidence of anything the reader did: repeating a
  // measurement reuses probes, so the same hop list reappears, and a repeat of
  // the same query returns the same addresses — both would spring open on a
  // result nobody had touched.
  const sameRun = state.shown === id;
  const opened = new Set(
    sameRun ? [...$("out").querySelectorAll("details[data-k][open]")].map((d) => d.dataset.k) : [],
  );
  const openedSets = [...opened]
    .map((k) => ({ key: k, records: state.answers?.get(k) }))
    .filter((e) => e.records);

  const body = LATENCY_TYPES.has(report.type) ? latencyView(report, groups) : answerView(report);
  const detail = view === "table" ? tableView(groups, report.type) : groups.map(sheet).join("");
  $("out").innerHTML = head + body + detail + cliHint(report, id);
  state.shown = id;
  if (opened.size) {
    const blocks = [...$("out").querySelectorAll("details[data-k]")];
    const taken = new Set();

    // A probe id is already an identity and never changes, and an answer that
    // did not grow still matches its own key. Both are exact, so they go first
    // and take their block out of the running.
    for (const d of blocks) {
      if (opened.has(d.dataset.k)) {
        d.open = true;
        taken.add(d);
      }
    }

    // What is left is an answer that grew. Containment finds it — but one
    // disclosure the reader opened must reopen exactly one, and the predicate
    // alone does not say that: with one node still on `[A,B,C,D]` and another
    // grown to `[A,B,C,D,E]`, both contain what was open and both sprang open.
    // I had called that over-restore harmless twice; it puts a node's answer on
    // screen expanded that the reader never touched. The smallest superset is
    // the successor — anything larger contains it too, and would be claimed by
    // its own predecessor if it had one.
    for (const was of openedSets) {
      if (opened.has(was.key) && blocks.some((d) => d.dataset.k === was.key)) continue;
      let best = null;
      let bestSize = Infinity;
      for (const d of blocks) {
        if (taken.has(d)) continue;
        const recs = state.answers?.get(d.dataset.k);
        if (!recs || recs.length >= bestSize) continue;
        if (was.records.every((r) => recs.includes(r))) {
          best = d;
          bestSize = recs.length;
        }
      }
      if (best) {
        best.open = true;
        taken.add(best);
      }
    }
  }

  for (const btn of document.querySelectorAll("[data-view]")) {
    btn.addEventListener("click", () => {
      state.view = btn.dataset.view;
      localStorage.setItem("view", state.view);
      render(report, id);
    });
  }
  $("md").addEventListener("click", async () => {
    await navigator.clipboard.writeText(markdown(report, id));
    $("md").textContent = "已复制";
    setTimeout(() => ($("md").textContent = "复制 Markdown"), 1500);
  });

  $("share").addEventListener("click", async () => {
    await navigator.clipboard.writeText(`${location.origin}/m/${id}`);
    $("share").textContent = "已复制";
    setTimeout(() => ($("share").textContent = "复制链接"), 1500);
  });
}

/**
 * Every node measured against one shared scale, drawn as a rule with common
 * ticks. Comparing is the entire job, so the comparison is the picture.
 */
function latencyView(report, groups) {
  const rows = groups.map((g) => ({
    label: g.label,
    rtt: g.summary?.rttMs?.avg ?? null,
    loss: g.summary?.lossPct ?? null,
    responded: g.responded,
  }));
  const values = rows.map((r) => r.rtt).filter((v) => v != null);
  if (values.length === 0) return "";
  const max = Math.max(...values);
  const scale = niceMax(max);

  const ticks = [0.25, 0.5, 0.75, 1]
    .map((f) => `<i class="tick" style="left:${f * 100}%"><span>${Math.round(scale * f)}</span></i>`)
    .join("");

  const bars = rows
    .map((r) => {
      if (r.responded === 0) {
        return `<div class="bar pending"><span class="who" title="${esc(r.label)}">${esc(r.label)}</span>` +
          `<span class="track"></span><span class="val">等待中</span></div>`;
      }
      if (r.rtt == null) {
        return `<div class="bar down"><span class="who" title="${esc(r.label)}">${esc(r.label)}</span>` +
          `<span class="track"><i class="fillbar" style="width:100%"></i></span>` +
          `<span class="val">不可达</span></div>`;
      }
      const pct = Math.max(1, (r.rtt / scale) * 100);
      const lossy = r.loss > 0;
      return (
        `<div class="bar${lossy ? " down" : ""}"><span class="who" title="${esc(r.label)}">${esc(r.label)}</span>` +
        `<span class="track"><i class="fillbar" style="width:${pct}%"></i>` +
        `<i class="cap" style="left:calc(${pct}% - 1px)"></i></span>` +
        `<span class="val">${ms(r.rtt)}${lossy ? ` ⌁${r.loss}%` : ""}</span></div>`
      );
    })
    .join("");

  return `<div class="rule"><div class="axis">${ticks}</div>${bars}</div>`;
}

const niceMax = (v) => {
  const steps = [10, 25, 50, 100, 150, 200, 300, 500, 750, 1000, 1500, 2000, 3000, 5000];
  return steps.find((s) => s >= v) ?? Math.ceil(v / 1000) * 1000;
};

/** For DNS and TLS the headline is disagreement: who saw something different. */
function answerView(report) {
  // Rebuilt every render; `render()` holds the previous one long enough to ask
  // what the reader had open.
  state.answers = new Map();
  const buckets = new Map();
  for (const g of report.groups) {
    if (g.responded === 0) continue;
    const key = signature(report.type, g);
    if (!key) continue;
    let b = buckets.get(key);
    if (!b) {
      // The records themselves, not the joined string. Splitting the display
      // form back apart on ", " turns one TXT record containing ", " — an SPF
      // policy, say — into several fake ones, and then counts and folds them
      // as if the answer were large.
      buckets.set(key, (b = { who: [], ttlMin: null, ttlMax: null, records: recordsOf(report.type, g) }));
    }
    b.who.push(g.label);
    // TTL is each resolver's cache remainder, so it varies everywhere by
    // design — reported as a range, never used to decide who agrees.
    const t = g.summary?.ttl;
    if (t) {
      b.ttlMin = b.ttlMin === null ? t.min : Math.min(b.ttlMin, t.min);
      b.ttlMax = b.ttlMax === null ? t.max : Math.max(b.ttlMax, t.max);
    }
  }
  if (buckets.size === 0) return "";

  const split = buckets.size > 1;
  // Smallest group first when the answers disagree. The finding is who is the
  // odd one out, not who is normal — naming the eight nodes that agree buries
  // the one that does not, and at 50 selectable nodes it buries it under a
  // paragraph. DNS keeps largest-first: several answers across regions is
  // ordinary GeoDNS, where no group is the exception.
  const sorted = [...buckets.entries()].sort((a, b) =>
    report.type === "dns" || !split
      ? b[1].who.length - a[1].who.length
      : a[1].who.length - b[1].who.length,
  );
  const verdict =
    report.type === "dns"
      ? `<p class="verdict">${split ? `各地返回 ${sorted.length} 组结果` : "各地结果一致"}</p>`
      : split
        ? `<p class="verdict split">各地证书不一致 · ${sorted.length} 种</p>`
        : `<p class="verdict">各地证书一致</p>`;

  // Naming every node stops being information somewhere around four, and
  // truncating the list is the wrong lever — the labels are "国家 · 运营商",
  // so a roll-call repeats the country once per operator. Past four, collapse
  // to countries: "香港×3、台湾×3" is a fifth of the width of naming six
  // carriers and answers the question people are actually scanning for, which
  // is which places saw this. The full list stays on the element's title.
  const NAMED = 4;
  const who = (names) => {
    if (names.length <= NAMED) return names.join("、");
    const byCountry = new Map();
    for (const n of names) {
      const country = n.split(" · ")[0];
      byCountry.set(country, (byCountry.get(country) ?? 0) + 1);
    }
    const ranked = [...byCountry.entries()].sort((a, b) => b[1] - a[1]);
    // Collapsing to countries only helps when several operators share a few of
    // them. Fifty selectable nodes can span fifty countries, and then the list
    // is just as long in a different unit — so it is capped too.
    const CAP = 4;
    const head = ranked
      .slice(0, CAP)
      .map(([country, n]) => (n > 1 ? `${country}×${n}` : country))
      .join("、");
    const rest = ranked.length - CAP;
    return rest > 0 ? `${head} +${rest} 个地区` : head;
  };

  // "A 104.26.14.87, A 104.26.15.87" says A twice for a query that was A, and
  // the record type is already in the header. Dropped only when every record
  // in the group shares one type — an ANY query genuinely needs it on each.
  // Dropped only when the header already names the record type. An ANY query
  // that happens to return one type still needs it on every line: the header
  // says ANY, so without the prefix there is no way to tell whether the value
  // is an MX, a TXT or an HINFO.
  const strip = (records) => {
    const types = new Set(records.map((r) => r.slice(0, r.indexOf(" "))));
    const named = report.type === "dns" && report.queryType && report.queryType !== "ANY";
    return named && types.size === 1 && types.has(report.queryType)
      ? records.map((r) => r.slice(r.indexOf(" ") + 1))
      : records;
  };

  /**
   * Three addresses is a line; thirty is a wall. A large site can answer with
   * dozens of A records, and this block sits above the results — so past a
   * handful it states the count and puts the list one click away, the same
   * shape the traceroute hop list uses. Nothing is hidden, and the block stops
   * growing with the size of the answer.
   */
  const INLINE = 3;
  /**
   * The key names the exact answer; `render()` matches it by containment.
   *
   * Deriving identity from the content directly does not work, in either of
   * the two forms tried. The whole answer changes the moment a late probe adds
   * an address, which is what closed the block the first time. The first record
   * alone survives an append but not a record that sorts ahead of it — a
   * `1.1.1.1` arriving after a `2.2.2.2` moves it just the same, and a fixture
   * that only ever appends higher addresses cannot show that.
   *
   * So identity is not derived here at all. The set each block is showing is
   * published alongside its key, and the restore reopens the block whose set
   * contains what the reader was already reading. Growth in any direction keeps
   * the place; a genuinely different answer does not inherit it.
   */
  const display = (records) => {
    const parts = strip(records);
    if (parts.length <= INLINE) return esc(parts.join(", "));
    const k = `ans:${JSON.stringify(records)}`;
    state.answers.set(k, records);
    return (
      `<details class="more" data-k="${esc(k)}">` +
      `<summary>${parts.length} 个地址 · ${esc(parts[0])} …</summary>` +
      `${esc(parts.join(", "))}</details>`
    );
  };

  return (
    verdict +
    sorted
      .map(([, b], i) => {
        const ttl =
          b.ttlMin === null
            ? ""
            : ` · TTL ${b.ttlMin}${b.ttlMax !== b.ttlMin ? `–${b.ttlMax}` : ""}`;
        // The majority in a split needs no roll-call: it is everyone else.
        const label =
          split && i === sorted.length - 1 && b.who.length > NAMED
            ? `其余 ${b.who.length} 个节点`
            : `${b.who.length} 个节点 · ${who(b.who)}`;
        return (
          `<div class="answer${i > 0 ? " alt" : ""}"><div class="val">${display(b.records)}</div>` +
          `<div class="who" title="${esc(b.who.join("、"))}">${esc(label)}${esc(ttl)}</div></div>`
        );
      })
      .join("")
  );
}

/**
 * A group's answer as a list, which is what the display needs. `signature()`
 * flattens the same thing into one string to use as a bucket key; that string
 * must never be taken apart again.
 */
function recordsOf(type, group) {
  if (type === "dns") return group.summary?.distinctAnswers ?? [];
  const fp = group.summary?.fingerprint;
  return fp ? [`SHA-256 ${fp.slice(0, 16)}…`] : [];
}

/**
 * A bucket key, and only a key — never taken apart again, and never ambiguous.
 *
 * `distinctAnswers.join(", ")` had the same flaw `sharedAnswer` did: a record
 * whose data contains the delimiter collides with a different set of records
 * that happens to serialise the same way, and two nodes that disagree get
 * bucketed as agreeing. Codex found it in `sharedAnswer`; it was here too.
 */
function signature(type, group) {
  if (type === "dns") {
    const answers = group.summary?.distinctAnswers ?? [];
    return answers.length ? JSON.stringify([...answers].sort()) : null;
  }
  const fp = group.summary?.fingerprint;
  return fp ? `SHA-256 ${fp.slice(0, 16)}…` : null;
}

/**
 * Which probes in this node are far from their peers.
 *
 * Two conditions, not one. A ratio alone flags 0.8 ms against 14 ms — a
 * resolver cache hit next to a miss, seventeen times apart and thirteen
 * milliseconds of difference nobody can act on. An absolute gap alone flags
 * every slow-but-consistent node. Together they catch what this run actually
 * contains: HKT 12 → 156 ms and TANet 22 → 190 ms, same answers from the same
 * operator, one probe taking an order of magnitude longer.
 */
const OUTLIER_RATIO = 3;
const OUTLIER_GAP_MS = 100;

function outliers(probes) {
  const times = probes.map((p) => p.rttMs).filter((v) => v != null);
  if (times.length < 2) return new Set();
  const min = Math.min(...times);
  const max = Math.max(...times);
  if (max < min * OUTLIER_RATIO || max - min < OUTLIER_GAP_MS) return new Set();
  // Both conditions again, per probe. The group gate only says *someone* is far
  // out; applying the ratio alone here then reddens everyone above 3x the
  // baseline, including a probe 30 ms away that the documented 100 ms rule
  // would never have called an outlier. 10 / 40 / 150 ms should mark the 150.
  return new Set(
    probes
      .filter((p) => p.rttMs != null && p.rttMs >= min * OUTLIER_RATIO && p.rttMs - min >= OUTLIER_GAP_MS)
      .map((p) => p.probeId),
  );
}

/**
 * How interesting a node is, lowest first — the order the page uses.
 *
 * Sorted in the console rather than in `src/aggregate.ts` on purpose: the API's
 * order is part of what a shared `/m/<id>` returns and callers can depend on
 * it, while how to present it is this page's business. Ranking here also lets
 * the bar chart and the cards agree without the server knowing about either.
 */
function rank(group, minority) {
  if (group.responded === 0 || group.responded < group.requested) return 0;
  if (group.probes.some((p) => !p.ok) || group.summary?.lossPct > 0) return 1;
  if (minority.has(group.key)) return 2;
  if (outliers(group.probes).size > 0) return 3;
  return 4;
}

/**
 * Node keys whose answer disagrees with the majority. Empty unless the answers
 * actually split — when everyone agrees there is no minority to promote.
 */
function minorityKeys(report) {
  const buckets = new Map();
  for (const g of report.groups) {
    if (g.responded === 0) continue;
    const key = signature(report.type, g);
    if (!key) continue;
    buckets.set(key, [...(buckets.get(key) ?? []), g.key]);
  }
  if (buckets.size < 2) return new Set();
  const biggest = Math.max(...[...buckets.values()].map((v) => v.length));
  return new Set([...buckets.values()].filter((v) => v.length < biggest).flat());
}

/** Keep the established order; anything new goes after it, already ranked. */
function hold(keys, ranked) {
  const seen = new Map(ranked.map((g) => [g.key, g]));
  const kept = keys.map((k) => seen.get(k)).filter(Boolean);
  const fresh = ranked.filter((g) => !keys.includes(g.key));
  return [...kept, ...fresh];
}

/** Problem first, then slowest to fastest. */
function ordered(report) {
  const minority = minorityKeys(report);
  return [...report.groups]
    .map((g) => ({ g, r: rank(g, minority), t: g.summary?.rttMs?.avg ?? -1 }))
    .sort((a, b) => a.r - b.r || b.t - a.t || a.g.key.localeCompare(b.g.key))
    .map((x) => x.g);
}

function sheet(group) {
  if (group.responded === 0) {
    return (
      `<article class="sheet wait"><header><span class="node">${esc(group.label)}</span>` +
      `<span class="stamp">等待中 0/${group.requested}</span></header></article>`
    );
  }
  const failed = group.probes.every((p) => !p.ok);
  const partial = group.responded < group.requested;
  const asn = group.probes[0]?.asn;
  const spread = citySpread(group.probes);
  // Types that get the answer view have no bar chart, so this header is the
  // only place two nodes can be compared on speed at a glance.
  const r = group.summary?.rttMs;
  const took =
    r && !LATENCY_TYPES.has(state.report?.type)
      ? r.min === r.max
        ? ms(r.min)
        : `${ms(r.min)} – ${ms(r.max)}`
      : "";
  const odd = outliers(group.probes);
  // Every probe agreed, so print the answer once and keep a line each. NOT the
  // whole card: two probes can return the same records twelve times apart
  // (HKT 12 ms and 156 ms on the same three addresses), and folding by answer
  // would delete exactly that.
  const shared = sharedAnswer(group);
  const body = shared
    ? `<div class="shared">${shared}</div>` +
      group.probes.map((p) => probeLine(p, odd.has(p.probeId))).join("")
    : group.probes.map((p) => probeBody(p, group.probes.length > 1, odd)).join("");

  const header =
    `<header><span class="node">${esc(group.label)}</span>` +
    `${asn ? `<span class="asn">AS${esc(asn)}</span>` : ""}` +
    `${spread ? `<span class="cities">${esc(spread)}</span>` : ""}` +
    `${took ? `<span class="took">${esc(took)}</span>` : ""}` +
    `<span class="stamp${partial ? " err" : ""}">${group.responded}/${group.requested} 探针</span></header>`;

  // No folding by "this looks unremarkable". Being an outlier may move a node
  // up the page and colour its number — both push information at the reader —
  // but it must never decide what they do not get to see. The rule for that
  // would be mine, and the thresholds behind it are guesses; the table view
  // solves the same length problem by letting them choose the density instead.
  return `<article class="sheet ${failed ? "fail" : "done"}">${header}<div class="body">${body}</div></article>`;
}

/**
 * The answer every probe in this node returned, or null when they differ.
 * Rendered once above the probe lines instead of once per probe: six nodes
 * each repeating the same three Cloudflare addresses twice printed them
 * thirty-six times for a fact the summary already stated.
 */
function sharedAnswer(group) {
  const answers = group.probes.map((p) => p.detail?.answers);
  if (!answers.every((a) => Array.isArray(a) && a.length)) return null;
  // TTL is deliberately out of the key. It is each resolver's cache remainder,
  // so it differs everywhere by design — `summarize` in src/measurements/dnsKind.ts
  // says so and refuses to let it decide who agrees. Including it here split
  // 香港·香港宽频 over 77 vs 120 seconds on identical addresses.
  // Compared structurally. Joining with a delimiter — any delimiter — is
  // ambiguous against record data that contains it: one TXT whose value is
  // `bar|TXT foo` serialises identically to two TXT records `bar` and `foo`,
  // and this function would then call two different answers the same and print
  // only the first. The same mistake as reparsing on ", ", one level up.
  const norm = (a) =>
    a.map((r) => [r.type, r.data]).sort((x, y) => x[0].localeCompare(y[0]) || x[1].localeCompare(y[1]));
  const first = norm(answers[0]);
  const same = (a) => a.length === first.length && a.every((r, i) => r[0] === first[i][0] && r[1] === first[i][1]);
  if (!answers.every((a) => same(norm(a)))) return null;

  // Which does mean the TTLs on show are a range, not a number.
  const ttls = new Map();
  for (const a of answers) {
    for (const r of a) {
      const k = JSON.stringify([r.type, r.data]);
      const seen = ttls.get(k) ?? [];
      ttls.set(k, [...seen, r.ttl]);
    }
  }
  return answers[0]
    .map((a) => {
      const k = JSON.stringify([a.type, a.data]);
      const vs = (ttls.get(k) ?? []).filter((v) => v != null);
      const lo = Math.min(...vs);
      const hi = Math.max(...vs);
      const ttl = vs.length === 0 ? "" : lo === hi ? `ttl ${lo}` : `ttl ${lo}–${hi}`;
      return `${esc(a.type)} ${esc(a.data)}${ttl ? `<span class="ttl">${esc(ttl)}</span>` : ""}`;
    })
    .join("<br>");
}

/** One probe, when its answer is already printed above: where and how long. */
function probeLine(p, isOutlier) {
  const bits = [`探针 #${esc(p.probeId)}`];
  if (p.city) bits.push(esc(p.city));
  if (p.from) bits.push(esc(p.from));
  const time = p.rttMs == null ? "" : `<span class="${isOutlier ? "slow" : ""}">${esc(ms(p.rttMs))}</span>`;
  return `<div class="pid line">${bits.join(" · ")}${time ? ` · ${time}` : ""}</div>`;
}

/**
 * One row per probe, the shape every other probing tool converges on
 * (check-host, ping.pe): a dense grid you scan down a column. The cards say
 * more per node; this says more per screen, and which one a reader wants
 * depends on whether they are diagnosing one node or comparing fifty. The
 * choice is theirs and it is remembered.
 *
 * The destination address is a column on purpose — geo-steered DNS is legible
 * by scanning it, which is how check-host makes the same point without a
 * summary block at all.
 */
function tableView(groups, type) {
  const rows = groups.flatMap((g) =>
    g.probes.length === 0
      ? [
          `<tr class="down"><td>${esc(g.label)}</td><td class="c">—</td><td colspan="3">` +
            `等待中 0/${g.requested}</td></tr>`,
        ]
      : (() => {
          const odd = outliers(g.probes);
          return g.probes.map((p, i) => {
            const t = p.rttMs ?? p.detail?.avg;
            return (
              `<tr class="${p.ok ? "" : "down"}">` +
              `<td>${i === 0 ? esc(g.label) : ""}</td>` +
              `<td class="c">${esc(p.city ?? "")}</td>` +
              `<td class="n${odd.has(p.probeId) ? " slow" : ""}">${t == null ? "—" : esc(ms(t))}</td>` +
              `<td class="a">${cell(outcome(type, p))}</td>` +
              `<td class="e">${p.ok ? "" : esc(p.error ?? "失败")}</td></tr>`
            );
          });
        })(),
  );
  return (
    `<table class="grid"><thead><tr><th>节点</th><th>城市</th><th>耗时</th>` +
    `<th>目标 / 答案</th><th></th></tr></thead><tbody>${rows.join("")}</tbody></table>`
  );
}

/**
 * What this measurement actually found, for one probe, in one cell.
 *
 * Not the destination address for every type: an ntp run's finding is the
 * clock offset and whether the server has heard from its upstream lately, and
 * a table showing only round-trip time would report a server that is hours
 * adrift as healthy — `ok` stays true, and the chart above plots RTT. Each
 * type gets the field it exists to measure.
 */
function outcome(type, p) {
  const d = p.detail || {};
  const part = (text, cls) => ({ text: String(text), cls });
  // Deliberately not short-circuiting on `!p.ok`. A traceroute that never
  // arrives is marked failed and still carries the hop count, the timeouts and
  // how far it got — which is the entire diagnostic value of a failed
  // traceroute. An expired certificate is failed and still has a subject and a
  // date. The error column says what went wrong; this column keeps saying what
  // was seen.
  if (type === "ntp") {
    const bits = [];
    if (d.offsetMs != null) bits.push(part(`偏移 ${ms(d.offsetMs)}`, "strong"));
    if (d.stratum != null) bits.push(part(`层级 ${d.stratum}`));
    // A free-running server still advertises a healthy stratum; this is how a
    // reader catches that without opening the card.
    if (d.refAgeSec != null && d.refAgeSec > 3600) bits.push(part(`上游 ${age(d.refAgeSec)}前`, "slow"));
    if (d.probeClockAgeSec != null && d.probeClockAgeSec > 3600)
      bits.push(part(`探针时钟 ${age(d.probeClockAgeSec)}前`, "slow"));
    return bits;
  }
  if (type === "sslcert") {
    const bits = [];
    if (d.subjectCN) bits.push(part(d.subjectCN));
    if (d.daysLeft != null)
      bits.push(
        d.daysLeft < 0
          ? part(`已过期 ${Math.abs(d.daysLeft)} 天`, "slow")
          : part(`剩 ${d.daysLeft} 天`, d.daysLeft < 14 ? "slow" : undefined),
      );
    if (d.issuerO || d.issuerCN) bits.push(part(d.issuerO ?? d.issuerCN));
    return bits;
  }
  if (type === "http") {
    const bits = [];
    if (d.status != null) bits.push(part(d.status, d.status >= 400 ? "slow" : "strong"));
    if (d.httpVersion) bits.push(part(d.httpVersion));
    if (d.dstAddr) bits.push(part(d.dstAddr));
    return bits;
  }
  if (type === "traceroute") {
    const bits = [];
    if (d.hopCount != null) bits.push(part(`${d.hopCount} 跳`));
    if (d.reached === false) bits.push(part("未到达", "slow"));
    if (d.lossyHops > 0) bits.push(part(`${d.lossyHops} 跳有丢包`, "slow"));
    if (d.timeouts > 0) bits.push(part(`${d.timeouts} 跳超时`, "slow"));
    if (d.dstAddr) bits.push(part(d.dstAddr));
    return bits;
  }
  if (type === "ping") {
    const bits = [];
    if (d.lossPct > 0) bits.push(part(`丢包 ${d.lossPct}%`, "slow"));
    if (d.dstAddr) bits.push(part(d.dstAddr));
    return bits;
  }
  // One part per record. Joining them with a space made a single TXT valued
  // `foo A bar` identical to two records `TXT foo` and `A bar` — the same
  // delimiter mistake as the two above it, in the last place it survived. The
  // sinks below decide how to separate parts; this never flattens them.
  if (Array.isArray(d.answers)) return d.answers.map((a) => part(`${a.type} ${a.data}`));
  return d.dstAddr ? [part(d.dstAddr)] : [];
}

/** Parts as table HTML — one element each, so boundaries survive the DOM. */
function cell(parts) {
  return parts
    .map((x) => `<span class="rec${x.cls ? ` ${x.cls}` : ""}">${esc(x.text)}</span>`)
    .join("");
}

/**
 * Parts as Markdown. Each is a code span, so a value containing the separator
 * cannot be read as two — the boundary is the fence, not a character that
 * could occur in the data.
 *
 * The fence is longer than the longest backtick run inside the value, which is
 * how CommonMark says to do it, and a value that starts or ends with a
 * backtick gets one space of padding that the renderer eats again. An earlier
 * version replaced backticks with apostrophes: silently rewriting a measured
 * record, in a tool whose entire claim is that it does not.
 *
 * `|` is escaped because a pipe ends a table cell no matter what encloses it.
 * That is a change to the Markdown, not to the value — it renders back as the
 * character that was measured.
 */
function plain(parts) {
  return parts
    .map((x) => {
      const longest = Math.max(0, ...[...x.text.matchAll(/`+/g)].map((m) => m[0].length));
      const fence = "`".repeat(longest + 1);
      const pad = x.text.startsWith("`") || x.text.endsWith("`") ? " " : "";
      return `${fence}${pad}${x.text.replace(/\|/g, "\\|")}${pad}${fence}`;
    })
    .join(" ");
}

/** The same run as a curl the reader can paste — the API is the product too. */
function cliHint(report, id) {
  return (
    `<div class="cli"><span>等效命令</span>` +
    `<code>curl -s ${esc(location.origin)}/api/v1/m/${esc(id)}</code></div>`
  );
}

/** Results as a Markdown table, for pasting into a ticket or a chat. */
function markdown(report, id) {
  const lines = [
    `**${report.type}${report.queryType ? ` ${report.queryType}` : ""} ${report.target}** — ${report.totalResponded}/${report.totalRequested} 探针`,
    "",
    "| 节点 | 城市 | 耗时 | 目标 / 答案 |",
    "| --- | --- | --- | --- |",
  ];
  for (const g of ordered(report)) {
    if (g.probes.length === 0) {
      lines.push(`| ${g.label} | — | — | 等待中 0/${g.requested} |`);
      continue;
    }
    for (const p of g.probes) {
      // Same source as the table, or the two drift.
      const t = p.rttMs ?? p.detail?.avg;
      // Unconditional, like the table: a traceroute that never arrived still
      // has its hop count and an expired certificate still has its subject.
      // The error joins it rather than replacing it.
      const seen = plain(outcome(report.type, p));
      const text = [seen, p.ok ? "" : (p.error ?? "失败")].filter(Boolean).join(" · ");
      lines.push(`| ${g.label} | ${p.city ?? ""} | ${t == null ? "—" : ms(t)} | ${text || "—"} |`);
    }
  }
  lines.push("", `${location.origin}/m/${id}`);
  return lines.join("\n");
}

/**
 * "北京×2 广州×1" — but only when the node's probes really are in different
 * cities. A node is one country and one operator, not one place: 中国·电信 can
 * answer from Beijing and Guangzhou at once, and that is most of the RTT
 * spread a reader would otherwise read as jitter. When they all sit in one
 * city the per-probe lines already say so, and a header repeat is noise.
 */
function citySpread(probes) {
  const tally = new Map();
  for (const p of probes) if (p.city) tally.set(p.city, (tally.get(p.city) ?? 0) + 1);
  if (tally.size < 2) return "";
  return [...tally.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .map(([city, n]) => `${city}×${n}`)
    .join(" ");
}

function probeBody(p, labelled, odd) {
  // The city is worth a line even for a lone probe — "中国·电信" says nothing
  // about whether this was measured from Beijing or Ürümqi.
  // For dns the query time is the only latency there is, and nothing else on
  // the page shows it — the answer view replaces the bar chart these types
  // would otherwise get. It rides the existing line rather than adding one:
  // seventeen probes is seventeen new rows on a page already accused of
  // sprawling. Note this is the query round trip, not `解析耗时` below, which
  // is the probe resolving the target's own name.
  const slow = odd?.has(p.probeId) ? " slow" : "";
  const queryMs =
    Array.isArray(p.detail?.answers) && p.rttMs != null
      ? ` · <span class="${slow.trim()}">${esc(ms(p.rttMs))}</span>`
      : "";
  const tag =
    labelled || p.city || queryMs
      ? `<div class="pid">探针 #${esc(p.probeId)}` +
        `${p.city ? ` · ${esc(p.city)}` : ""}${p.from ? ` · ${esc(p.from)}` : ""}${queryMs}</div>`
      : "";
  if (p.error && !p.ok && Object.keys(p.detail || {}).length === 0) {
    return `<div class="probe">${tag}<span class="stamp err">${esc(p.error)}</span></div>`;
  }
  const d = p.detail || {};
  const rows = [];
  // Everything below comes from a measured host: DNS records, certificate
  // subjects, hostnames. A TXT record or a CN is attacker-controlled, and this
  // page renders measurements other people created and shared, so values are
  // escaped here and only `addHtml` may introduce markup.
  const add = (k, v) => v != null && v !== "" && rows.push([k, esc(v)]);
  const addHtml = (k, html) => html && rows.push([k, html]);

  if (d.sent != null) {
    // One number when the packets agreed; three only when they did not.
    add("延迟", d.min === d.max ? ms(d.avg) : `${ms(d.min)} / ${ms(d.avg)} / ${ms(d.max)}`);
    // Losing only the first packet is usually a neighbour lookup or a
    // firewall opening state, not the path — and with three packets it reads
    // as an alarming 33%. Say which packet went missing.
    const seq = Array.isArray(d.packets) ? d.packets : [];
    const onlyFirst = seq.length > 1 && seq[0] == null && seq.slice(1).every((v) => v != null);
    add("丢包", `${d.lossPct}% (${d.rcvd}/${d.sent})${onlyFirst ? " · 仅首包" : ""}`);
    if (seq.length) {
      addHtml(
        "逐包",
        seq.map((v) => (v == null ? '<span class="lost">✕</span>' : esc(ms(v)))).join("　"),
      );
    }
    if (d.dup) add("重复应答", `${d.dup} 个（可能是路由环路或中间设备代答）`);
  }
  if (d.hops) {
    const lossy = d.lossyHops ? ` · ${d.lossyHops} 跳部分丢失` : "";
    add(
      "路径",
      `${d.hopCount} 跳${d.reached ? "，已到达" : "，未到达"}${d.timeouts ? ` · ${d.timeouts} 跳超时` : ""}${lossy}`,
    );
    add("最后响应", d.lastResponding);
  }
  if (d.status != null) {
    add("状态码", `${d.status} · HTTP/${d.httpVersion ?? "?"}`);
    add("响应", `${ms(p.rttMs)} · 头 ${d.headerBytes}B / 体 ${d.bodyBytes}B`);
  }
  if (d.stratum != null) {
    add("stratum", d.stratum);
    // The mean alone hides how much the packets disagreed.
    const spread =
      d.offsetMinMs != null && d.offsetMaxMs != null && d.offsetMinMs !== d.offsetMaxMs
        ? `（${d.offsetMinMs} – ${d.offsetMaxMs}）`
        : "";
    add("时间偏移", d.offsetMs == null ? null : `${d.offsetMs} ms ${spread}`.trim());
    add("服务器精度", precision(d.precisionSec));
    add("轮询间隔", d.pollSec == null ? null : `${d.pollSec} 秒`);
    // A server that has been free-running for hours still advertises a
    // healthy stratum; this is how you catch that.
    add("上次同步上游", d.refAgeSec == null ? null : `${age(d.refAgeSec)}前`);
    // An offset measured by a probe whose own clock is stale means nothing.
    add("探针时钟", d.probeClockAgeSec == null ? null : `${age(d.probeClockAgeSec)}前同步`);
  }
  if (d.subjectCN) {
    add("证书", d.subjectCN);
    add("签发", d.issuerO ?? d.issuerCN ?? "?");
    add("到期", `${(d.notAfter || "").slice(0, 10)}${d.daysLeft != null ? ` · 剩 ${d.daysLeft} 天` : ""}`);
    add("指纹", d.fingerprint ? `${d.fingerprint.slice(0, 24)}…` : null);
  }
  if (Array.isArray(d.answers) && d.answers.length) {
    addHtml(
      "解析",
      d.answers
        .map((a) => `${esc(a.type)} ${esc(a.data)}<span class="ttl">ttl ${esc(a.ttl)}</span>`)
        .join("<br>"),
    );
  }
  // NXDOMAIN, SERVFAIL and an empty NOERROR all look alike without this.
  if (d.rcode && d.rcode !== "NOERROR") add("应答码", d.rcode);
  if (d.authenticated === true) add("DNSSEC", "已验证 · AD");
  else if (d.authenticated === false) add("DNSSEC", "未验证");
  if (p.error) addHtml("错误", `<span class="stamp err">${esc(p.error)}</span>`);
  // Since each probe resolves the target itself, part of what looks like
  // latency can be DNS. Five-second resolves are real and show up here.
  if (d.resolveMs != null) {
    addHtml("解析耗时", `<span class="${d.resolveMs > 1000 ? "slow" : ""}">${esc(ms(d.resolveMs))}</span>`);
  }
  add("目标 IP", d.dstAddr);

  const dl = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("");
  const raw = d.hops
    ? `<details class="raw" data-k="hops:${esc(p.probeId)}">` +
      `<summary>逐跳</summary><pre>${esc(
        d.hops
          .map((h) => {
            // Every hop is probed several times. A hop that answered once out
            // of three is not the same as one that answered three times.
            const fill = `${h.received}/${h.sent}`.padEnd(5);
            if (h.timeout) return `${String(h.hop).padStart(2)}  ${"*".padEnd(18)}${fill}`;
            const range =
              h.rttMinMs != null && h.rttMaxMs != null && h.rttMinMs !== h.rttMaxMs
                ? `${ms(h.rttMinMs)} – ${ms(h.rttMaxMs)}`
                : ms(h.rttMs);
            return `${String(h.hop).padStart(2)}  ${String(h.from).padEnd(18)}${fill}${range}`;
          })
          .join("\n"),
      )}</pre></details>`
    : "";
  return `<div class="probe">${tag}<dl>${dl}</dl>${raw}</div>`;
}

/* ── messages ───────────────────────────────────────── */

function notice(text, kind = "error") {
  $("out").insertAdjacentHTML("afterbegin", `<div class="notice ${kind}">${esc(text)}</div>`);
}

function showError(err) {
  const b = err.body || {};
  const wait = b.retryAfterSec ? `（${humanWait(b.retryAfterSec)}后重试）` : "";
  const hint = b.hint ? `<div class="hint">${esc(b.hint)}</div>` : "";
  $("out").innerHTML = `<div class="notice">${esc(err.message)}${wait}${hint}</div>`;
}

const humanWait = (sec) =>
  sec < 60 ? `${sec} 秒` : sec < 3600 ? `${Math.ceil(sec / 60)} 分钟` : `${Math.ceil(sec / 3600)} 小时`;

init().catch((err) => {
  $("out").innerHTML = `<div class="notice">加载失败：${esc(err.message)}</div>`;
});
