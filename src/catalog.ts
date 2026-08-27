import {
  CATALOG_GENERATED_AT,
  COUNTRY_NAMES,
  OPERATOR_NAMES,
  POLICY,
  SEED_NODES,
  type Node,
} from "./nodes";

const ATLAS_PROBES = "https://atlas.ripe.net/api/v2/probes/";
const RIPESTAT = "https://stat.ripe.net/data/as-overview/data.json";

/** How long a sweep stays fresh. Page loads trigger a refresh, not perform one. */
const TTL_MS = 3 * 60 * 60 * 1000;
/** Atlas hard-caps a page at 500 regardless of what you ask for. */
const PAGE = 500;
const CONCURRENCY = 6;
/** Keep DO storage well under the 128 KiB per-value limit. */
const MAX_STORED_GROUPS = 2500;
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

  constructor(
    private readonly state: DurableObjectState,
    private readonly env: unknown,
  ) {}

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    const force = url.searchParams.get("force") === "1";

    const [counts, names, refreshedAt] = await Promise.all([
      this.state.storage.get<Counts>("counts"),
      this.state.storage.get<Record<string, string>>("names"),
      this.state.storage.get<number>("refreshedAt"),
    ]);

    const stale = !refreshedAt || Date.now() - refreshedAt > TTL_MS;
    if ((stale || force) && !this.refreshing) {
      // Fire and forget: the DO stays responsive and the caller is not blocked.
      this.refreshing = this.refresh().finally(() => {
        this.refreshing = null;
      });
      this.state.waitUntil(this.refreshing);
    }

    const snapshot: CatalogSnapshot = counts
      ? {
          refreshedAt: new Date(refreshedAt ?? 0).toISOString(),
          seededAt: CATALOG_GENERATED_AT,
          stale,
          source: "live",
          count: 0,
          nodes: merge(counts, names ?? {}),
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

    const groups = new Map<string, { v4: number; v6: number; v6asn: Map<number, number> }>();
    for (const probe of [...first.results, ...rest]) {
      const cc = probe.country_code?.toLowerCase();
      const asn = probe.asn_v4 ?? probe.asn_v6;
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

    const kept = [...groups.entries()]
      .filter(([, g]) => g.v4 >= POLICY.minProbes)
      .sort((a, b) => b[1].v4 - a[1].v4)
      .slice(0, MAX_STORED_GROUPS);

    const counts: Counts = {};
    for (const [id, g] of kept) {
      const dominantV6 = [...g.v6asn.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
      counts[id] = [g.v4, g.v6, dominantV6];
    }

    const names = (await this.state.storage.get<Record<string, string>>("names")) ?? {};
    await resolveNames(counts, names);

    await this.state.storage.put({ counts, names, refreshedAt: Date.now() });
  }
}

interface ProbeRow {
  country_code?: string | null;
  asn_v4?: number | null;
  asn_v6?: number | null;
}

async function page(n: number): Promise<{ count?: number; results: ProbeRow[] }> {
  const url = `${ATLAS_PROBES}?status=1&is_public=true&page_size=${PAGE}&page=${n}&fields=country_code,asn_v4,asn_v6`;
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

/** Turn live counts into the displayable node list, applying the seed's policy. */
function merge(counts: Counts, names: Record<string, string>): Node[] {
  const all: Node[] = [];
  for (const [id, [v4, v6, v6asn]] of Object.entries(counts)) {
    const seed = seedById.get(id);
    const [cc, asnStr] = id.split("-");
    const asn = Number(asnStr);
    const country = COUNTRY_NAMES[cc.toUpperCase()] ?? cc.toUpperCase();
    const operator = OPERATOR_NAMES[asn] ?? names[asn] ?? seed?.holder ?? `AS${asn}`;
    all.push({
      id,
      cc: cc.toUpperCase(),
      asn,
      asnV6: v6asn ?? seed?.asnV6 ?? null,
      label: seed?.label ?? `${country} · ${operator}`,
      holder: seed?.holder ?? names[asn] ?? null,
      continent: seed?.continent ?? "??",
      probes: v4,
      probesV6: v6,
    });
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
