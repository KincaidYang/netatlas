import { HTTPException } from "hono/http-exception";
import type { AtlasClient, ProbeSelectionGroup } from "./atlas";
import type { ProbeMeta } from "./types";
import catalog from "../data/nodes.json";

export interface Node {
  /** `cc-asn`, e.g. "cn-4134". */
  id: string;
  cc: string;
  asn: number;
  asnV6: number | null;
  label: string;
  holder: string | null;
  continent: string;
  /** Probe counts at catalogue build time — a hint, never treated as truth. */
  probes: number;
  probesV6: number;
  /** Part of the short default list shown before the user expands anything. */
  featured?: boolean;
}

export const CATALOG_GENERATED_AT: string = catalog.generatedAt;
export const SEED_NODES: Node[] = catalog.nodes as Node[];
export const COUNTRY_NAMES: Record<string, string> = catalog.countries;
export const OPERATOR_NAMES: Record<string, string> = catalog.operators as Record<string, string>;
/** ISO country code → continent, baked by the build script from one table. */
export const CONTINENT_OF: Record<string, string> = catalog.continents as Record<string, string>;

/**
 * Which continent a country belongs to. `??` only for Atlas's own placeholder
 * for a probe it could not place — every real ISO code is in the table.
 */
export const continentOf = (cc: string): string => CONTINENT_OF[cc.toUpperCase()] ?? "??";
export const POLICY = catalog.policy as {
  minProbes: number;
  perCountry: number;
  perCountryOverrides: Record<string, number>;
  featuredCountries: Record<string, number>;
  maxNodes: number;
  always: number[];
  cloud: number[];
};
const BY_ID = new Map(SEED_NODES.map((n) => [n.id, n]));

/** `cn-4134` → { cc: "CN", asn: 4134 }. Node ids are self-describing on purpose. */
export function parseNodeId(id: string): { cc: string; asn: number } | null {
  const m = /^([a-z]{2})-(\d{1,10})$/.exec(id.trim().toLowerCase());
  return m ? { cc: m[1].toUpperCase(), asn: Number(m[2]) } : null;
}

/** Build a display label for any node id, catalogued or not. */
export function labelForId(id: string, names: Record<string, string> = {}): string {
  const node = BY_ID.get(id);
  if (node) return node.label;
  const parsed = parseNodeId(id);
  if (!parsed) return id;
  const country = COUNTRY_NAMES[parsed.cc] ?? parsed.cc;
  const operator = OPERATOR_NAMES[parsed.asn] ?? names[parsed.asn] ?? `AS${parsed.asn}`;
  return `${country} · ${operator}`;
}

export const nodeById = (id: string): Node | undefined => BY_ID.get(id.toLowerCase());

/**
 * Does this node answer the search box?
 *
 * The catalogue offers ~240 curated nodes; Atlas actually has connected probes
 * in about 5,000 country×operator pairs. Search is how the other 4,760 are
 * reachable, so it has to match the several ways someone would name one:
 * the id (`cn-4134`), a bare ASN (`4134`), the country in Chinese or by code,
 * or the operator's name. Most of those 4,398 ASNs have no resolved holder —
 * `resolveNames` only names a handful per sweep — so they read as `AS12345`,
 * and matching the bare number is what makes them findable at all.
 */
export function matchesQuery(node: Node, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return false;
  if (node.id.includes(q)) return true;
  if (node.cc.toLowerCase() === q) return true;
  if (String(node.asn) === q || `as${node.asn}` === q) return true;
  if (node.label.toLowerCase().includes(q)) return true;
  if (node.holder?.toLowerCase().includes(q)) return true;
  return (COUNTRY_NAMES[node.cc] ?? "").includes(query.trim());
}

/** Most probes first — a node with one probe is the least useful answer. */
export function searchNodes(nodes: Node[], query: string, limit: number): Node[] {
  return nodes
    .filter((n) => matchesQuery(n, query))
    .sort((a, b) => b.probes - a.probes || a.id.localeCompare(b.id))
    .slice(0, limit);
}

/**
 * Hard ceilings; the quota layer in src/quota.ts tightens these per caller.
 *
 * MAX_NODES is not a pricing decision — a BYOK caller pays their own credits.
 * It bounds the work one request makes us do: `resolveNodes` issues an Atlas
 * lookup per chunk of nodes and emits one probe group per node, and a Worker
 * has a finite subrequest budget. Above the probe ceiling it is meaningless
 * anyway, since every node needs at least one probe to answer.
 */
export const MAX_NODES = 50;
export const MAX_PROBES_PER_NODE = 3;
export const MAX_TOTAL_PROBES = 150;

/** Named selections, resolved against the real catalogue at build time. */
export const NODE_PRESETS: Record<string, string[]> = catalog.presets as Record<string, string[]>;

/**
 * Preset names that used to exist, kept working.
 *
 * The console no longer offers 大中华 / 亚太 / 美洲 — they were a different
 * granularity from the continent sections right below them — but this is a
 * public, no-login API and `POST /probe {"preset":"greater_china"}` is
 * something a caller may already have in a script. Answering 400 to those
 * costs someone a working tool to save us a map. They are resolved but not
 * listed: `GET /presets` returns the canonical set only.
 */
const PRESET_ALIASES: Record<string, string[]> = {
  greater_china: ["china"],
  apac: ["asia"],
  americas: ["north_america", "south_america"],
};

/** Node ids for a preset name, or null if there is no such preset. */
export function presetNodes(name: string): string[] | null {
  const direct = NODE_PRESETS[name];
  if (direct) return direct;
  const alias = PRESET_ALIASES[name];
  if (!alias) return null;
  return [...new Set(alias.flatMap((n) => NODE_PRESETS[n] ?? []))];
}

/**
 * Which node a probe belongs to. A probe's v4 and v6 ASNs can differ, so try
 * both against the catalogue before falling back to a synthesised key — that
 * way results from a node we no longer list still group sensibly.
 */
export function nodeKeyFor(meta: ProbeMeta | undefined): string {
  if (!meta?.country_code) return "unknown";
  const cc = meta.country_code.toLowerCase();
  for (const asn of [meta.asn_v4, meta.asn_v6]) {
    if (asn && BY_ID.has(`${cc}-${asn}`)) return `${cc}-${asn}`;
  }
  const asn = meta.asn_v4 ?? meta.asn_v6;
  return asn ? `${cc}-${asn}` : cc;
}

export const labelFor = (key: string): string => labelForId(key);

export interface ResolvedSelection {
  probes: ProbeSelectionGroup[];
  /** Probe count actually secured per node. */
  requested: Record<string, number>;
  /** Nodes that had no connected probe right now. */
  unavailable: string[];
  /** Live pool size per node at resolution time — the honest, current number. */
  available: Record<string, number>;
}

const shuffle = <T>(xs: T[]): T[] => {
  const a = [...xs];
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
};

/**
 * Turn node ids into a concrete Atlas probe selection, resolved live.
 *
 * Why not just hand Atlas `{type:"asn", value}`? Because ASN selection is
 * *global* — AS16509 (AWS) or AS174 (Cogent) span dozens of countries, so
 * "香港 · AWS" would silently pull probes from Virginia. Resolving to explicit
 * probe ids is the only way to pin country AND operator.
 *
 * Resolution is done at request time against `status=1` (connected), so probes
 * churning in and out never yields a stale selection. data/nodes.json is only
 * used to know which nodes *exist* and to size the queries below.
 */
export async function resolveNodes(
  client: AtlasClient,
  nodeIds: string[],
  perNode: number,
  af: 4 | 6,
  maxProbes: number = MAX_TOTAL_PROBES,
): Promise<ResolvedSelection> {
  const ids = [...new Set(nodeIds.map((n) => n.trim().toLowerCase()))].filter(Boolean);
  if (ids.length === 0) throw new HTTPException(400, { message: "'nodes' must list at least one node" });
  if (ids.length > MAX_NODES) {
    throw new HTTPException(400, { message: `too many nodes (${ids.length}); max ${MAX_NODES}` });
  }

  // A node id encodes everything selection needs (country + ASN), so any
  // well-formed pair works — including operators the catalogue hasn't listed.
  // If it has no connected probe the caller learns that from `unavailable`,
  // which is the same answer a stale catalogue entry would have produced.
  const nodes = ids.map((id) => {
    const seeded = BY_ID.get(id);
    if (seeded) return seeded;
    const parsed = parseNodeId(id);
    if (!parsed) {
      throw new HTTPException(400, {
        message: `invalid node '${id}'; expected '<cc>-<asn>' like 'cn-4134'. See GET /nodes.`,
      });
    }
    return {
      id,
      cc: parsed.cc,
      asn: parsed.asn,
      // Deliberately null, not the v4 ASN. A node id carries one ASN and the
      // catalogue is what knows whether the operator's IPv6 rides a different
      // one; assuming they match made every such node look empty over IPv6.
      // See the unknown-v6 path below.
      asnV6: null,
      label: labelForId(id),
      holder: null,
      continent: "??",
      probes: 50, // unknown size; assume mid-sized for query planning
      probesV6: 0,
    } satisfies Node;
  });

  const per = Math.min(Math.max(Math.floor(perNode) || 1, 1), MAX_PROBES_PER_NODE);
  const ceiling = Math.min(maxProbes, MAX_TOTAL_PROBES);
  if (nodes.length * per > ceiling) {
    throw new HTTPException(400, {
      message:
        `requested ${nodes.length * per} probes (${nodes.length} nodes x ${per}) ` +
        `exceeds cap of ${ceiling}; select fewer nodes or lower perNode`,
    });
  }

  // Atlas caps a page at 500 probes, so chunk the lookup using the catalogue's
  // probe counts as a size hint. Being wrong here costs an extra request at
  // worst — the counts are never used as an answer, only as a query plan.
  const BUDGET = 400;
  const chunks: Node[][] = [];
  let current: Node[] = [];
  let size = 0;
  for (const node of [...nodes].sort((a, b) => b.probes - a.probes)) {
    const cost = Math.max(node.probes, 1);
    if (current.length && size + cost > BUDGET) {
      chunks.push(current);
      current = [];
      size = 0;
    }
    current.push(node);
    size += cost;
  }
  if (current.length) chunks.push(current);

  const pools = new Map<string, number[]>(nodes.map((n) => [n.id, []]));

  /**
   * Probes of a node whose IPv6 ASN we do not know, keyed by node id.
   *
   * These come back from a v4-keyed query, so they are "this operator's probes
   * that also have IPv6" — which is not the same as "this operator's IPv6".
   * A probe can reach v6 through a tunnel broker on a completely different AS,
   * and measuring Hurricane Electric's path while claiming the operator's is
   * exactly the kind of quiet wrongness this codebase exists to avoid. They
   * are narrowed to one ASN below.
   */
  const v6Candidates = new Map<string, ProbeMeta[]>();

  const collect = (chunk: Node[], found: ProbeMeta[], keyBy: 4 | 6): void => {
    for (const probe of found) {
      const cc = probe.country_code?.toLowerCase();
      if (!cc) continue;
      const asn = keyBy === 6 ? probe.asn_v6 : probe.asn_v4;
      if (!asn) continue;
      // country_code__in + asn__in is an AND of two OR-sets, so the response
      // can contain pairs nobody asked for. Keep only exact matches.
      const node = chunk.find(
        (n) => n.cc.toLowerCase() === cc && (keyBy === 6 ? (n.asnV6 ?? n.asn) : n.asn) === asn,
      );
      if (!node) continue;
      if (af === 6 && keyBy === 4) {
        if (!probe.asn_v6) continue; // no IPv6 at all — cannot serve an af:6 run
        const list = v6Candidates.get(node.id) ?? [];
        list.push(probe);
        v6Candidates.set(node.id, list);
      } else {
        pools.get(node.id)!.push(probe.id);
      }
    }
  };

  const lookup = (group: Node[], keyBy: 4 | 6): Promise<ProbeMeta[]> =>
    client.findProbes({
      asns: [...new Set(group.map((n) => (keyBy === 6 ? (n.asnV6 ?? n.asn) : n.asn)))],
      countries: [...new Set(group.map((n) => n.cc))],
      af: keyBy,
      limit: 500,
    });

  /**
   * Which ASN this node's IPv6 actually belongs to, when the catalogue never
   * said. The most common one among its probes — the same rule the catalogue
   * applies when it records a group's dominant v6 ASN, so a node resolved this
   * way and one resolved from the catalogue mean the same thing.
   */
  const dominantV6 = (probes: ProbeMeta[]): number | null => {
    const tally = new Map<number, number>();
    for (const p of probes) if (p.asn_v6) tally.set(p.asn_v6, (tally.get(p.asn_v6) ?? 0) + 1);
    return [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  };

  // Over IPv6 a node the catalogue never saw has no known v6 ASN, so it is
  // queried by its v4 ASN and narrowed afterwards. Everything else keeps the
  // query it always had.
  const keyFor = (node: Node): 4 | 6 => (af === 6 && node.asnV6 === null ? 4 : af);

  await Promise.all(
    chunks.flatMap((chunk) => {
      const byKey = new Map<4 | 6, Node[]>();
      for (const node of chunk) {
        const key = keyFor(node);
        byKey.set(key, [...(byKey.get(key) ?? []), node]);
      }
      return [...byKey.entries()].map(async ([keyBy, group]) => {
        try {
          collect(group, await lookup(group, keyBy), keyBy);
        } catch {
          // One bad input (an unknown country code, say) makes Atlas reject the
          // whole batch. Retry node by node so a single bogus entry degrades to
          // "unavailable" instead of failing everybody else's measurement.
          await Promise.all(
            group.map(async (node) => {
              try {
                collect([node], await lookup([node], keyBy), keyBy);
              } catch {
                /* leaves the pool empty → reported as unavailable */
              }
            }),
          );
        }
      });
    }),
  );

  // Narrow each unknown-v6 node to a single IPv6 ASN, so a selection cannot
  // mix an operator's native v6 with a tunnel broker's.
  for (const [id, candidates] of v6Candidates) {
    const asn = dominantV6(candidates);
    if (asn === null) continue;
    pools.get(id)!.push(...candidates.filter((p) => p.asn_v6 === asn).map((p) => p.id));
  }

  const probes: ProbeSelectionGroup[] = [];
  const requested: Record<string, number> = {};
  const unavailable: string[] = [];
  const available: Record<string, number> = {};
  for (const node of nodes) {
    const pool = pools.get(node.id) ?? [];
    available[node.id] = pool.length;
    const chosen = shuffle(pool).slice(0, per);
    if (chosen.length === 0) {
      unavailable.push(node.id);
      continue;
    }
    probes.push({ type: "probes", value: chosen.join(","), requested: chosen.length });
    requested[node.id] = chosen.length;
  }

  if (probes.length === 0) {
    throw new HTTPException(503, {
      message: `none of the requested nodes has a connected probe right now: ${unavailable.join(", ")}`,
    });
  }
  return { probes, requested, unavailable, available };
}

/** Recover the per-node request counts from Atlas's stored probe selection. */
export function requestedFromProbeIds(
  groups: Array<{ ids: number[] }>,
  meta: Map<number, ProbeMeta>,
): Record<string, number> {
  const out: Record<string, number> = {};
  for (const group of groups) {
    for (const id of group.ids) {
      const key = nodeKeyFor(meta.get(id));
      out[key] = (out[key] ?? 0) + 1;
    }
  }
  return out;
}
