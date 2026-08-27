"use strict";

/* netatlas console — no build step, no framework. */

const API = "/api/v1";
const PER_NODE = 2;
const POLL_MS = 3000;
const POLL_LIMIT_MS = 3 * 60 * 1000;

/** Types whose story is "how long did it take"; the rest are "what came back". */
const LATENCY_TYPES = new Set(["ping", "traceroute", "http", "ntp"]);

const $ = (id) => document.getElementById(id);
const esc = (s) =>
  String(s ?? "").replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));
const ms = (v) => (v == null ? "—" : v < 10 ? `${v.toFixed(1)} ms` : `${Math.round(v)} ms`);

const state = {
  types: [],
  nodes: [],
  presets: {},
  /** The result currently on screen, if any. */
  report: null,
  limits: { maxNodes: 8, maxPerNode: 2 },
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
    refreshQuota();
  });

  const [types, nodes, presets] = await Promise.all([
    api("/types"),
    api("/nodes"),
    api("/presets"),
  ]);
  state.types = types;
  state.nodes = nodes.nodes;
  state.totalNodes = nodes.totalCount;
  state.presets = presets;

  $("type").innerHTML = types.map((t) => `<option value="${t.type}">${esc(t.label)}</option>`).join("");
  // The result may already be on screen; the type select only exists now.
  syncFormTo(state.report);
  $("more").textContent = `展开全部 ${nodes.totalCount} 个节点`;
  renderRegions();
  renderPresets();
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
  if (!$("target").value) $("target").value = String(report.target ?? "").replace(/\.$/, "");
}

function renderRegions() {
  const byRegion = new Map();
  for (const n of state.nodes) {
    if (!byRegion.has(n.continent)) byRegion.set(n.continent, []);
    byRegion.get(n.continent).push(n);
  }
  $("regions").innerHTML = [...byRegion.entries()]
    .map(
      ([region, list]) => `<div class="region"><h2>${esc(region)}</h2><div class="chips">${list
        .map(
          (n) =>
            `<button type="button" class="chip" data-node="${esc(n.id)}" aria-pressed="false"` +
            `${n.probes === 0 ? " disabled" : ""} title="${esc(n.id)} · ${n.probes} 个在线探针">` +
            `${esc(n.label)}<span class="n">${n.probes}</span></button>`,
        )
        .join("")}</div></div>`,
    )
    .join("");

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

const PRESET_LABELS = {
  global: "全球",
  china: "中国大陆",
  greater_china: "大中华",
  apac: "亚太",
  europe: "欧洲",
  americas: "美洲",
};
const presetLabel = (name) => PRESET_LABELS[name] || name;

function applyPreset(name) {
  const ids = state.presets[name];
  if (!ids) return;
  const usable = ids.filter((id) => state.nodes.some((n) => n.id === id && n.probes > 0));
  // Presets are shared with API callers and can be larger than this caller's
  // tier allows; trim rather than let the server reject the default flow.
  state.selected = new Set(usable.slice(0, state.limits.maxNodes));
  syncChips();
}

async function toggleAll() {
  state.showingAll = !state.showingAll;
  const data = await api(state.showingAll ? "/nodes?all=1" : "/nodes");
  state.nodes = data.nodes;
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
  // Keep catalogue order (grouped by continent) so the summary reads like a route.
  const labels = state.nodes.filter((n) => state.selected.has(n.id)).map((n) => n.label);
  const shown = labels.slice(0, 4).join("、");
  const rest = labels.length > 4 ? ` +${labels.length - 4}` : "";
  $("chosen").innerHTML = labels.length
    ? `已选 <b>${labels.length}</b> 个节点：${esc(shown)}${esc(rest)}`
    : "未选节点";
}

function updateCost() {
  const type = state.types.find((t) => t.type === $("type").value);
  const n = state.selected.size;
  if (!type || n === 0) {
    $("cost").textContent = "选择节点后估算消耗";
    return;
  }
  const credits = type.creditsPerProbe * n * PER_NODE;
  $("cost").innerHTML = `<b>${n}</b> 个节点 × ${PER_NODE} 探针 · 预估 <b>${credits}</b> credits`;
}

function syncTypeHint() {
  const type = $("type").value;
  const hint = {
    http: "HTTP 只能打 RIPE anchor，测的是到 anchor 的链路，不是你自己网站的可用性",
    traceroute: "traceroute 单价是 ping 的 10 倍，限额更紧",
    dns: "查询每个探针本地的递归解析器，能看出 CDN 的真实调度",
  }[type];
  $("typehint").textContent = hint || "";
  $("target").placeholder =
    type === "http" ? "xx-xxx.anchors.atlas.ripe.net" : type === "ntp" ? "pool.ntp.org" : "example.com · 1.1.1.1";
}

async function refreshQuota() {
  try {
    const q = await api("/quota");
    state.limits = { maxNodes: q.maxNodes, maxPerNode: q.maxPerNode };
    if (state.selected.size > q.maxNodes) {
      state.selected = new Set([...state.selected].slice(0, q.maxNodes));
      syncChips();
    }
    const daily = q.creditsLimit ? ` · 今日已用 ${q.creditsUsedToday}/${q.creditsLimit}` : "";
    $("quota").innerHTML =
      q.tier === "byok"
        ? `使用你自己的 Key · 可选 <b>${q.maxNodes}</b> 个节点`
        : `匿名额度 <b>${q.tokensLeft}</b>/${q.tokenCapacity} 次${daily}`;
  } catch {
    $("quota").textContent = "";
  }
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

  try {
    const created = await api("/probe", {
      method: "POST",
      body: JSON.stringify({
        type: $("type").value,
        target,
        nodes: [...state.selected],
        perNode: PER_NODE,
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

function load(id) {
  stopPolling();
  state.startedAt = Date.now();
  const tick = async () => {
    try {
      const report = await api(`/m/${id}`);
      render(report, id);
      const settled = report.status === "Stopped" || report.totalResponded >= report.totalRequested;
      if (settled || Date.now() - state.startedAt > POLL_LIMIT_MS) return stopPolling();
    } catch (err) {
      stopPolling();
      showError(err);
    }
  };
  tick();
  state.timer = setInterval(tick, POLL_MS);
}

function stopPolling() {
  if (state.timer) clearInterval(state.timer);
  state.timer = null;
}

/* ── rendering ──────────────────────────────────────── */

function render(report, id) {
  state.report = report;
  syncFormTo(report);

  const partial = report.totalResponded < report.totalRequested;
  const running = report.status !== "Stopped" && partial;
  const target = String(report.target ?? "").replace(/\.$/, "");
  const head =
    `<div class="runhead">` +
    `<span class="kind">${esc(report.type)}</span>` +
    `<span class="what">${esc(target)}</span>` +
    `<span class="fill${partial && !running ? " partial" : ""}">` +
    `${report.totalResponded}/${report.totalRequested} 个探针已回${running ? " · 等待中" : ""}</span>` +
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
    if (!buckets.has(key)) buckets.set(key, []);
    buckets.get(key).push(g.label);
  }
  if (buckets.size === 0) return "";

  const sorted = [...buckets.entries()].sort((a, b) => b[1].length - a[1].length);
  const verdict =
    sorted.length > 1
      ? `<p class="verdict split">各地结果不一致 · ${sorted.length} 种</p>`
      : `<p class="verdict">各地结果一致</p>`;

  return (
    verdict +
    sorted
      .map(
        ([answer, who], i) =>
          `<div class="answer${i > 0 ? " alt" : ""}"><div class="val">${esc(answer)}</div>` +
          `<div class="who">${who.length} 个节点 · ${esc(who.join("、"))}</div></div>`,
      )
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
  return (
    `<article class="sheet ${failed ? "fail" : "done"}">` +
    `<header><span class="node">${esc(group.label)}</span>` +
    `${asn ? `<span class="asn">AS${esc(asn)}</span>` : ""}` +
    `<span class="stamp${partial ? " err" : ""}">${group.responded}/${group.requested} 探针</span></header>` +
    `<div class="body">${group.probes.map((p) => probeBody(p, group.probes.length > 1)).join("")}</div></article>`
  );
}

function probeBody(p, labelled) {
  const tag = labelled ? `<div class="pid">探针 #${esc(p.probeId)}${p.from ? ` · ${esc(p.from)}` : ""}</div>` : "";
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
    add("延迟", `${ms(d.min)} / ${ms(d.avg)} / ${ms(d.max)}`);
    add("丢包", `${d.lossPct}% (${d.rcvd}/${d.sent})`);
  }
  if (d.hops) {
    add("路径", `${d.hopCount} 跳${d.reached ? "，已到达" : "，未到达"}${d.timeouts ? ` · ${d.timeouts} 跳超时` : ""}`);
    add("最后响应", d.lastResponding);
  }
  if (d.status != null) {
    add("状态码", `${d.status} · HTTP/${d.httpVersion ?? "?"}`);
    add("响应", `${ms(p.rttMs)} · 头 ${d.headerBytes}B / 体 ${d.bodyBytes}B`);
  }
  if (d.stratum != null) {
    add("stratum", d.stratum);
    add("时间偏移", d.offsetMs == null ? null : `${d.offsetMs} ms`);
  }
  if (d.subjectCN) {
    add("证书", d.subjectCN);
    add("签发", d.issuerO ?? d.issuerCN ?? "?");
    add("到期", `${(d.notAfter || "").slice(0, 10)}${d.daysLeft != null ? ` · 剩 ${d.daysLeft} 天` : ""}`);
    add("指纹", d.fingerprint ? `${d.fingerprint.slice(0, 24)}…` : null);
  }
  if (Array.isArray(d.answers) && d.answers.length) {
    addHtml("解析", d.answers.map((a) => `${esc(a.type)} ${esc(a.data)}`).join("<br>"));
  }
  if (p.error) addHtml("错误", `<span class="stamp err">${esc(p.error)}</span>`);
  add("目标 IP", d.dstAddr);

  const dl = rows.map(([k, v]) => `<dt>${esc(k)}</dt><dd>${v}</dd>`).join("");
  const raw = d.hops
    ? `<details class="raw"><summary>逐跳</summary><pre>${esc(
        d.hops.map((h) => `${String(h.hop).padStart(2)}  ${h.timeout ? "*" : `${h.from}  ${ms(h.rttMs)}`}`).join("\n"),
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
