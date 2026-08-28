import {
  CATALOG_GENERATED_AT,
  COUNTRY_NAMES,
  OPERATOR_NAMES,
  POLICY,
  SEED_NODES,
  continentOf,
  matchesQuery,
  searchNodes,
  type Node,
} from "./nodes";

const ATLAS_PROBES = "https://atlas.ripe.net/api/v2/probes/";
const RIPESTAT = "https://stat.ripe.net/data/as-overview/data.json";

/** How long a sweep stays fresh. Page loads trigger a refresh, not perform one. */
const TTL_MS = 3 * 60 * 60 * 1000;
/** Atlas hard-caps a page at 500 regardless of what you ask for. */
const PAGE = 500;
const CONCURRENCY = 6;
/**
 * Every (country, ASN) pair Atlas has a connected probe in — about 5,000 of
 * them, against the ~240 the curated catalogue offers. The search box needs
 * all of them, including the 3,350-odd with a single probe.
 *
 * They do not fit in one place: 5,000 entries serialise to roughly 130 KB and
 * a Durable Object value stops at 128 KiB, so they are stored in shards. The
 * cap is a safety rail against unbounded growth, not a product decision.
 */
const MAX_STORED_GROUPS = 8000;
/** Entries per shard — ~1,200 lands near 35 KB, far under the per-value limit. */
const SHARD_SIZE = 1200;
/** A search that returns 4,000 chips is not an answer; narrow the query. */
const SEARCH_LIMIT = 120;
/** Name at most this many newly-discovered ASNs per sweep. */
const MAX_NEW_NAMES = 25;

/** [v4 probes, v6 probes, dominant v6 ASN] */
type Counts = Record<string, [number, number, number | null]>;

export interface CatalogSnapshot {
  refreshedAt: string | null;
  seededAt: string;
  stale: boolean;
  source: "live" | "seed";
  count: number;
  nodes: Node[];
  /** Search responses only: how many pairs were looked through, and matched. */
  searched?: number;
  matched?: number;
  /**
   * What Atlas actually holds right now, as opposed to the ~240 pairs this
   * catalogue curates out of it. The console shows these because the gap is
   * the point: a node picker of 240 chips sits on top of five thousand.
   */
  totals?: { probes: number; groups: number; countries: number };
}

const CLOUD = new Set(POLICY.cloud);
const ALWAYS = new Set(POLICY.always);
const rank = (asn: number): number => (CLOUD.has(asn) ? 2 : OPERATOR_NAMES[asn] ? 0 : 1);

/**
 * Live node catalogue.
 *
 * data/nodes.json is only a cold-start seed. The real catalogue is swept from
 * Atlas on a TTL: a page load *triggers* a refresh but never waits for one, so
 * visitors always get an instant response and Atlas sees one sweep per TTL
 * rather than one per visitor. A sweep is 30 requests / ~1 MB / ~5s, which is
 * nothing every few hours and abusive on every page load.
 */
export class CatalogCache implements DurableObject {
  private refreshing: Promise<void> | null = null;

  /**
   * Retry sooner than the TTL when a sweep fails. Atlas being briefly
   * unreachable should not mean three hours of stale catalogue.
   */
  private static readonly RETRY_MS = 10 * 60 * 1000;

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: unknown,
  ) {}

  /**
   * Sweep on a schedule, not only when someone happens to visit.
   *
   * The lazy trigger below is kept as a fallback, but on its own it puts the
   * cost on the wrong person: a visitor arriving after the TTL expires starts
   * the sweep, does not wait for it, and is the one person served the stale
   * answer — everyone after them gets the fresh one. With no visitors at all
   * the catalogue simply rots. Eight sweeps a day is 240 requests to Atlas,
   * which is nothing next to being wrong.
   */
  async alarm(): Promise<void> {
    let ok = true;
    try {
      await this.sweep();
    } catch {
      ok = false; // the retry below is the recovery; nothing else to do here
    }
    await this.state.storage.setAlarm(Date.now() + (ok ? TTL_MS : CatalogCache.RETRY_MS));
  }

  /**
   * One sweep at a time, whoever asked for it.
   *
   * On a cold object the first request arms an alarm that is already due, so
   * the alarm and the lazy trigger both want to sweep within the same second.
   * Without this they would each run a full 30-request pass and both write the
   * result — twice the load on Atlas to produce the same answer.
   */
  private sweep(): Promise<void> {
    this.refreshing ??= this.refresh().finally(() => {
      this.refreshing = null;
    });
    return this.refreshing;
  }

  /**
   * Start the chain the first time this object is used, and never twice.
   *
   * Scheduled from the last sweep, not from now. An object that predates
   * alarms — every deployed one, the first time this ships — may be holding a
   * snapshot two hours and fifty-nine minutes old; arming for three hours from
   * *this* request would leave it stale for nearly three more, which is the
   * exact state alarms were added to end. Already due means due now.
   */
  private async ensureAlarm(refreshedAt: number | undefined): Promise<void> {
    if ((await this.state.storage.getAlarm()) !== null) return;
    const due = refreshedAt ? refreshedAt + TTL_MS : Date.now();
    await this.state.storage.setAlarm(Math.max(due, Date.now()));
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "1";
    const query = url.searchParams.get("q")?.trim() ?? "";
    const sizeFor = url.searchParams.get("ids")?.trim() ?? "";

    const [counts, names, refreshedAt, swept] = await Promise.all([
      this.loadSharded<Counts[string]>("groups", "counts"),
      this.loadSharded<string>("names", "names"),
      this.state.storage.get<number>("refreshedAt"),
      this.state.storage.get<{ probes: number; countries: number }>("sweptTotals"),
    ]);

    this.state.waitUntil(this.ensureAlarm(refreshedAt));

    const stale = !refreshedAt || Date.now() - refreshedAt > TTL_MS;
    if (stale || force) {
      // Fire and forget: the DO stays responsive and the caller is not blocked.
      this.state.waitUntil(this.sweep());
    }

    // Live probe counts for specific node ids. `resolveNodes` plans its Atlas
    // lookups by size, and it has no other way to know how big a pair it never
    // catalogued really is — guessing made batches overflow Atlas's page cap.
    if (sizeFor) {
      const sizes: Record<string, number> = {};
      for (const id of sizeFor.split(",").map((x) => x.trim().toLowerCase()).filter(Boolean)) {
        const group = counts?.[id];
        if (group) sizes[id] = group[0];
      }
      return Response.json({ sizes, source: counts ? "live" : "seed" });
    }

    // Search looks through every stored pair, not the curated list — that is the
    // whole point: ~5,000 country×operator pairs exist and the catalogue shows
    // ~240 of them. A node id is self-describing, so anything found here is
    // directly selectable without the catalogue knowing about it.
    if (query) {
      const pool = counts ? allNodes(counts, names ?? {}) : SEED_NODES;
      const hits = searchNodes(pool, query, SEARCH_LIMIT);
      return Response.json({
        refreshedAt: refreshedAt ? new Date(refreshedAt).toISOString() : null,
        seededAt: CATALOG_GENERATED_AT,
        stale,
        source: counts ? "live" : "seed",
        count: hits.length,
        searched: pool.length,
        matched: pool.filter((n) => matchesQuery(n, query)).length,
        nodes: hits,
      } satisfies CatalogSnapshot);
    }

    const snapshot: CatalogSnapshot = counts
      ? {
          refreshedAt: new Date(refreshedAt ?? 0).toISOString(),
          seededAt: CATALOG_GENERATED_AT,
          stale,
          source: "live",
          count: 0,
          nodes: merge(counts, names ?? {}),
          totals: totalsOf(counts, swept),
        }
      : {
          refreshedAt: null,
          seededAt: CATALOG_GENERATED_AT,
          stale: true,
          source: "seed",
          count: SEED_NODES.length,
          nodes: SEED_NODES,
        };
    snapshot.count = snapshot.nodes.length;

    return Response.json(snapshot);
  }

  /** One full sweep of connected probes, collapsed into (country, ASN) counts. */
  private async refresh(): Promise<void> {
    const first = await page(1);
    const pages = Math.ceil((first.count ?? 0) / PAGE);
    const rest: ProbeRow[] = [];
    for (let start = 2; start <= pages; start += CONCURRENCY) {
      const batch = await Promise.all(
        Array.from({ length: Math.min(CONCURRENCY, pages - start + 1) }, (_, i) => page(start + i)),
      );
      for (const b of batch) rest.push(...b.results);
    }

    // Counted before the IPv4 filter below, because the headline on the console
    // says "RIPE Atlas 在线探针" and that has to mean every connected probe.
    // The groups deliberately drop the 188 IPv6-only ones — they cannot be
    // addressed by a `cc-<v4 ASN>` node id — so summing group counts would
    // quietly understate Atlas by exactly those probes.
    const all = [...first.results, ...rest];
    // `?` is Atlas's placeholder for a probe it could not place. It is not a
    // country and must not be counted as one — the probe itself is real and
    // still counts.
    const placed = all.map((p) => p.country_code).filter((cc): cc is string => !!cc && cc !== "?");
    const swept = { probes: all.filter((p) => p.country_code).length, countries: new Set(placed).size };

    const groups = new Map<string, { v4: number; v6: number; v6asn: Map<number, number> }>();
    for (const probe of all) {
      const cc = probe.country_code?.toLowerCase();
      // A node id is `cc-<v4 ASN>`, so a probe without one cannot be addressed
      // by any node — 188 of Atlas's connected probes are IPv6-only. Keying
      // them by their v6 ASN instead built groups that resolve to nothing, and
      // counted them as IPv4 probes of whichever node shares that number: KPN
      // uses 1136 for both families, so `nl-1136` was credited with probes that
      // have no IPv4 at all. They remain reachable for `af: 6` on a catalogued
      // node, which queries by v6 ASN and never consults these counts.
      const asn = probe.asn_v4;
      if (!cc || !asn) continue;
      const id = `${cc}-${asn}`;
      let g = groups.get(id);
      if (!g) {
        g = { v4: 0, v6: 0, v6asn: new Map() };
        groups.set(id, g);
      }
      g.v4++;
      if (probe.asn_v6) {
        g.v6++;
        g.v6asn.set(probe.asn_v6, (g.v6asn.get(probe.asn_v6) ?? 0) + 1);
      }
    }

    // Everything, not just what the curated catalogue would show: the search
    // box offers the full set and `merge()` applies the policy on the way out.
    const kept = [...groups.entries()]
      .sort((a, b) => b[1].v4 - a[1].v4)
      .slice(0, MAX_STORED_GROUPS);

    const counts: Counts = {};
    for (const [id, g] of kept) {
      const dominantV6 = [...g.v6asn.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      counts[id] = [g.v4, g.v6, dominantV6];
    }

    const stored = (await this.loadSharded<string>("names", "names")) ?? {};
    // Keep only names an existing group can display. Without this the map only
    // ever grows — 25 new holders per sweep, forever, for ASNs that left the
    // catalogue years ago — and at ~25 bytes each it crosses the 128 KiB
    // per-value limit somewhere past 5,000 entries. That `put` then throws
    // before `refreshedAt` advances, so the catalogue is permanently stale and
    // every page load fires another 30-request sweep at Atlas.
    const names: Record<string, string> = {};
    for (const id of Object.keys(counts)) {
      const asn = id.split("-")[1];
      if (stored[asn]) names[asn] = stored[asn];
    }
    await resolveNames(counts, names);

    await this.saveSharded("groups", counts);
    try {
      await this.saveSharded("names", names);
    } catch {
      // Names are cosmetic — an unnamed node reads as ASnnnn and still works.
      // Losing them must never cost us a refresh, because a refresh that never
      // lands means every page load sweeps Atlas again.
    }
    await this.state.storage.put({ sweptTotals: swept, refreshedAt: Date.now() });
    // The pre-sharding `counts` and `names` values are deliberately left in
    // place. They cost a little dead storage and buy a safe rollback: an older
    // Worker reads them and gets a working, if thinner, catalogue instead of
    // falling all the way back to the committed seed.
  }

  /**
   * A sharded map, falling back to the single value a pre-sharding sweep left
   * behind. For groups that fallback holds only pairs with two or more probes,
   * so search is thinner until the next sweep — degraded, not broken, which
   * beats an empty catalogue after a deploy.
   */
  private async loadSharded<T>(prefix: string, legacyKey: string): Promise<Record<string, T> | undefined> {
    const shards = (await this.state.storage.get<number>(`${prefix}Shards`)) ?? 0;
    if (shards === 0) return this.state.storage.get<Record<string, T>>(legacyKey);
    const keys = Array.from({ length: shards }, (_, i) => `${prefix}:${i}`);
    const loaded = await this.state.storage.get<Record<string, T>>(keys);
    const merged: Record<string, T> = {};
    for (const part of loaded.values()) Object.assign(merged, part);
    return merged;
  }

  private async saveSharded(prefix: string, data: Record<string, unknown>): Promise<void> {
    const entries = Object.entries(data);
    const shards = Math.max(1, Math.ceil(entries.length / SHARD_SIZE));
    const write: Record<string, unknown> = { [`${prefix}Shards`]: shards };
    for (let i = 0; i < shards; i++) {
      write[`${prefix}:${i}`] = Object.fromEntries(entries.slice(i * SHARD_SIZE, (i + 1) * SHARD_SIZE));
    }
    await this.state.storage.put(write);

    // A shrinking population leaves orphan shards that would otherwise be
    // merged back in on the next read, resurrecting entries that are gone.
    const previous = (await this.state.storage.get<number>(`${prefix}ShardsPrev`)) ?? 0;
    for (let i = shards; i < previous; i++) await this.state.storage.delete(`${prefix}:${i}`);
    await this.state.storage.put(`${prefix}ShardsPrev`, shards);
  }
}

interface ProbeRow {
  country_code?: string | null;
  asn_v4?: number | null;
  asn_v6?: number | null;
}

async function page(n: number): Promise<{ count?: number; results: ProbeRow[] }> {
  // No `is_public` filter, deliberately. `findProbes` — the path that actually
  // selects probes for a measurement — does not filter on it either, so a
  // catalogue that did would describe a different population from the one it
  // plans queries against: 1,099 of Atlas's 14,650 connected probes are
  // private, and every one of them can answer a measurement.
  const url = `${ATLAS_PROBES}?status=1&page_size=${PAGE}&page=${n}&fields=country_code,asn_v4,asn_v6`;
  const res = await fetch(url, { headers: { "User-Agent": "netatlas" } });
  if (!res.ok) throw new Error(`atlas probes page ${n}: ${res.status}`);
  return (await res.json()) as { count?: number; results: ProbeRow[] };
}

/** Look up holder names for ASNs we have never seen, a few at a time. */
async function resolveNames(counts: Counts, names: Record<string, string>): Promise<void> {
  const unknown: number[] = [];
  for (const id of Object.keys(counts)) {
    const asn = Number(id.split("-")[1]);
    if (!OPERATOR_NAMES[asn] && !names[asn] && !unknown.includes(asn)) unknown.push(asn);
    if (unknown.length >= MAX_NEW_NAMES) break;
  }
  await Promise.all(
    unknown.map(async (asn) => {
      try {
        const res = await fetch(`${RIPESTAT}?resource=AS${asn}`);
        if (!res.ok) return;
        const data = (await res.json()) as { data?: { holder?: string } };
        const holder = cleanHolder(data.data?.holder ?? "");
        if (holder) names[asn] = holder;
      } catch {
        /* an unnamed ASN still works; it just shows as ASnnnn */
      }
    }),
  );
}

/** Mirrors scripts/build-nodes.mjs so runtime-discovered names read the same. */
function cleanHolder(raw: string): string {
  let name = raw.split(",")[0].trim().replace(/^AS\d+\s*[-–]?\s*/i, "");
  const dash = name.indexOf(" - ");
  if (dash > 0) {
    const tail = name.slice(dash + 3).trim();
    name = tail.length >= 5 && !/^No\.|^\d/.test(tail) ? tail : name.slice(0, dash);
  }
  name = name.replace(/^(AS[N]?-[A-Z0-9-]+|[A-Z0-9]{4,}-[A-Z0-9-]+)\s+(?=[A-Za-z])/, "");
  name = name.replace(/\b(\w+)(\s+\1\b)+/gi, "$1");
  name = name.replace(/\s+(Ltd|Limited|Inc|LLC|S\.A\.|SA|GmbH|B\.V\.|BV|Co\.?|Corp\.?|Company|PLC|AG|AB|SAS|SRL|Pty|Pte)\.?$/gi, "").trim();
  return name.length > 26 ? `${name.slice(0, 25).trimEnd()}…` : name;
}

const seedById = new Map(SEED_NODES.map((n) => [n.id, n]));

/**
 * Everything the last sweep saw, before any policy trims it down — or nothing.
 *
 * `probes` and `countries` come from the sweep itself and never from the
 * groups. Summing groups looks tempting and is wrong twice over: they hold
 * only IPv4-addressable probes, so the total would be short by the 188 that
 * are IPv6-only. An object stored before this existed has groups but no
 * totals, and answering with that sum would publish the known-wrong figure —
 * for up to a full TTL, since a fresh snapshot is not re-swept. The console
 * hides the line when totals are absent, which is the right answer until a
 * sweep has actually counted.
 */
function totalsOf(
  counts: Counts,
  swept: { probes: number; countries: number } | undefined,
): { probes: number; groups: number; countries: number } | undefined {
  if (!swept) return undefined;
  return { probes: swept.probes, groups: Object.keys(counts).length, countries: swept.countries };
}

/** One stored group as a displayable node. Shared by the catalogue and search. */
function toNode(id: string, [v4, v6, v6asn]: Counts[string], names: Record<string, string>): Node {
  const seed = seedById.get(id);
  const [cc, asnStr] = id.split("-");
  const asn = Number(asnStr);
  const country = COUNTRY_NAMES[cc.toUpperCase()] ?? cc.toUpperCase();
  const operator = OPERATOR_NAMES[asn] ?? names[asn] ?? seed?.holder ?? `AS${asn}`;
  return {
    id,
    cc: cc.toUpperCase(),
    asn,
    asnV6: v6asn ?? seed?.asnV6 ?? null,
    label: seed?.label ?? `${country} · ${operator}`,
    holder: seed?.holder ?? names[asn] ?? null,
    continent: seed?.continent ?? continentOf(cc),
    probes: v4,
    probesV6: v6,
  };
}

/**
 * Every stored pair as a node, no policy applied — what the search box looks
 * through. Single-probe pairs are included on purpose; they are marked in the
 * console rather than hidden, because "one probe, may not answer" is a fact
 * the reader can act on and a missing node is not.
 */
function allNodes(counts: Counts, names: Record<string, string>): Node[] {
  return Object.entries(counts).map(([id, group]) => toNode(id, group, names));
}

/** Turn live counts into the displayable node list, applying the seed's policy. */
function merge(counts: Counts, names: Record<string, string>): Node[] {
  const all: Node[] = [];
  for (const [id, group] of Object.entries(counts)) {
    // Stored groups now include single-probe pairs for the search box; the
    // curated catalogue has always required POLICY.minProbes and still does.
    if (group[0] < POLICY.minProbes) continue;
    all.push(toNode(id, group, names));
  }

  // Same shape as the build script: top-N per country, with the curated
  // operators always kept, carriers ahead of clouds.
  const byCc = new Map<string, Node[]>();
  for (const n of all) {
    if (!byCc.has(n.cc)) byCc.set(n.cc, []);
    byCc.get(n.cc)!.push(n);
  }
  const picked: Node[] = [];
  for (const [cc, list] of byCc) {
    list.sort((a, b) => rank(a.asn) - rank(b.asn) || b.probes - a.probes);
    const quota = POLICY.perCountryOverrides[cc] ?? POLICY.perCountry;
    picked.push(
      ...list.slice(0, quota),
      ...list.slice(quota).filter((n) => ALWAYS.has(n.asn) || seedById.has(n.id)),
    );
  }
  if (picked.length > POLICY.maxNodes) {
    const keep = (n: Node) => POLICY.perCountryOverrides[n.cc] || ALWAYS.has(n.asn) || OPERATOR_NAMES[n.asn];
    picked.sort((a, b) => Number(!!keep(b)) - Number(!!keep(a)) || b.probes - a.probes);
    picked.length = POLICY.maxNodes;
  }
  // Mark the short default list, carriers ahead of clouds (same rule as the
  // build script, so a refreshed catalogue looks like the committed seed).
  const featured = new Set<string>();
  for (const [cc, take] of Object.entries(POLICY.featuredCountries)) {
    const slice = picked
      .filter((n) => n.cc === cc)
      .sort((a, b) => rank(a.asn) - rank(b.asn) || b.probes - a.probes);
    for (const n of slice.slice(0, take)) featured.add(n.id);
  }
  for (const n of picked) n.featured = featured.has(n.id);

  // Disambiguate two ASNs of the same carrier in one country.
  const seen = new Map<string, number>();
  for (const n of picked) {
    const hits = (seen.get(n.label) ?? 0) + 1;
    seen.set(n.label, hits);
    if (hits > 1) n.label = `${n.label} AS${n.asn}`;
  }
  return picked.sort(
    (a, b) => a.continent.localeCompare(b.continent) || a.cc.localeCompare(b.cc) || b.probes - a.probes,
  );
}
