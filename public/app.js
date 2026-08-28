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

  const head =
    `<div class="runhead">` +
    `<span class="kind">${esc(report.type)}</span>` +
    `${report.queryType ? `<span class="qt">${esc(report.queryType)}</span>` : ""}` +
    `<span class="what">${esc(target)}</span>` +
    resolved +
    `<span class="fill${partial && !running ? " partial" : ""}">` +
    `${report.totalResponded}/${report.totalRequested} 个探针已回${note}</span>` +
    `<button type="button" id="share">复制链接</button></div>`;

  const body = LATENCY_TYPES.has(report.type) ? latencyView(report) : answerView(report);
  $("out").innerHTML = head + body + report.groups.map(sheet).join("");

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
function latencyView(report) {
  const rows = report.groups.map((g) => ({
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
  const buckets = new Map();
  for (const g of report.groups) {
    if (g.responded === 0) continue;
    const key = signature(report.type, g);
    if (!key) continue;
    let b = buckets.get(key);
    if (!b) buckets.set(key, (b = { who: [], ttlMin: null, ttlMax: null }));
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

  const sorted = [...buckets.entries()].sort((a, b) => b[1].who.length - a[1].who.length);
  // Several DNS answers across regions is ordinary GeoDNS, so this states the
  // fact and leaves it there. Several *certificates* is worth a second look.
  const split = sorted.length > 1;
  const verdict =
    report.type === "dns"
      ? `<p class="verdict">${split ? `各地返回 ${sorted.length} 组结果` : "各地结果一致"}</p>`
      : split
        ? `<p class="verdict split">各地证书不一致 · ${sorted.length} 种</p>`
        : `<p class="verdict">各地证书一致</p>`;

  return (
    verdict +
    sorted
      .map(([answer, b], i) => {
        const ttl =
          b.ttlMin === null
            ? ""
            : ` · TTL ${b.ttlMin}${b.ttlMax !== b.ttlMin ? `–${b.ttlMax}` : ""}`;
        return (
          `<div class="answer${i > 0 ? " alt" : ""}"><div class="val">${esc(answer)}</div>` +
          `<div class="who">${b.who.length} 个节点 · ${esc(b.who.join("、"))}${esc(ttl)}</div></div>`
        );
      })
      .join("")
  );
}

function signature(type, group) {
  if (type === "dns") {
    const answers = group.summary?.distinctAnswers ?? [];
    return answers.length ? answers.join(", ") : null;
  }
  const fp = group.summary?.fingerprint;
  return fp ? `SHA-256 ${fp.slice(0, 16)}…` : null;
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
  return (
    `<article class="sheet ${failed ? "fail" : "done"}">` +
    `<header><span class="node">${esc(group.label)}</span>` +
    `${asn ? `<span class="asn">AS${esc(asn)}</span>` : ""}` +
    `${spread ? `<span class="cities">${esc(spread)}</span>` : ""}` +
    `<span class="stamp${partial ? " err" : ""}">${group.responded}/${group.requested} 探针</span></header>` +
    `<div class="body">${group.probes.map((p) => probeBody(p, group.probes.length > 1)).join("")}</div></article>`
  );
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

function probeBody(p, labelled) {
  // The city is worth a line even for a lone probe — "中国·电信" says nothing
  // about whether this was measured from Beijing or Ürümqi.
  const tag =
    labelled || p.city
      ? `<div class="pid">探针 #${esc(p.probeId)}` +
        `${p.city ? ` · ${esc(p.city)}` : ""}${p.from ? ` · ${esc(p.from)}` : ""}</div>`
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
    ? `<details class="raw"><summary>逐跳</summary><pre>${esc(
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
