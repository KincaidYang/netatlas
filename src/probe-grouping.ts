/**
 * Probes → country×operator groups, in one copy.
 *
 * Two sweeps build this same map: `src/catalog.ts` at runtime, every three
 * hours, and `scripts/build-nodes.mjs` at build time for `data/nodes.json`.
 * CLAUDE.md says they must agree, and the reason is written in blood — keying a
 * group by the probe's v6 ASN "invented 61 groups that resolve to nothing" and
 * "credited 80 real nodes with IPv4 probes that have no IPv4". A rule that
 * expensive should not be stated twice and hoped over.
 *
 * Node imports this `.ts` from the `.mjs` script directly (native type
 * stripping, no loader, no build step). Keep it erasable-syntax-only.
 */

export interface GroupRow {
  country_code?: string | null;
  asn_v4?: number | null;
  asn_v6?: number | null;
}

export interface Group {
  /** `cc-asn`, lowercased — the node id, which is self-describing. */
  id: string;
  cc: string;
  asn: number;
  /** Probes reachable over IPv4 on this ASN. The count a node id addresses. */
  v4: number;
  /** How many of those also have IPv6. */
  v6: number;
  /**
   * The v6 ASN most of them use, or null. An operator's IPv6 often rides a
   * different AS, and a node id carries only the v4 one, so this is how an
   * `af: 6` request finds the right probes instead of assuming the numbers
   * match — assuming it made `de-8899` report 0 probes where it has 37.
   */
  asnV6: number | null;
}

/**
 * Group connected probes by `cc-<v4 ASN>`.
 *
 * **Keyed by the v4 ASN, never falling back to the v6 one.** 188 of Atlas's
 * connected probes are IPv6-only and no node id can address them; keying those
 * by their v6 ASN builds groups that resolve to nothing and inflates the IPv4
 * count of whatever node shares that number — KPN uses 1136 for both families,
 * so `nl-1136` counted probes with no IPv4 at all. Those probes stay reachable
 * for `af: 6` on a catalogued node, which queries by v6 ASN and never reads
 * these counts.
 *
 * `?` is Atlas's placeholder for a probe it could not place. A `?-29802` group
 * would be counted among the pairs the console calls 全部可搜索 and then
 * rejected by `parseNodeId()`, which takes two-letter codes only — advertised
 * and unselectable, the exact combination the search box exists to avoid.
 *
 * No `is_public` filter, deliberately: `findProbes` — the path that actually
 * selects probes for a measurement — does not filter on it, so a catalogue that
 * did would describe a different population from the one it plans against.
 */
export function groupProbes(probes: Iterable<GroupRow>): Map<string, Group> {
  const groups = new Map<string, Group>();
  const v6seen = new Map<string, Map<number, number>>();
  for (const p of probes) {
    const cc = p.country_code?.toLowerCase();
    const asn = p.asn_v4;
    if (!cc || cc === "?" || !asn) continue;
    const id = `${cc}-${asn}`;
    let g = groups.get(id);
    if (!g) {
      g = { id, cc, asn, v4: 0, v6: 0, asnV6: null };
      groups.set(id, g);
      v6seen.set(id, new Map());
    }
    g.v4++;
    if (p.asn_v6) {
      g.v6++;
      const tally = v6seen.get(id)!;
      tally.set(p.asn_v6, (tally.get(p.asn_v6) ?? 0) + 1);
    }
  }
  // The dominant v6 ASN, resolved once the whole sweep has been seen. Taking
  // every v6-capable probe instead would be worse: a probe can reach IPv6
  // through a tunnel broker on an unrelated AS, and that measures Hurricane
  // Electric's path while claiming the operator's.
  for (const [id, tally] of v6seen) {
    groups.get(id)!.asnV6 = [...tally.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
  }
  return groups;
}
