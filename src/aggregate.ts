import { cityOfProbe } from "./geo";
import type { MeasurementKind, NodeSummary, ProbeOutcome } from "./measurements";
import type { AtlasResultRow, ProbeMeta } from "./types";

export interface ProbeResult extends ProbeOutcome {
  probeId: number;
  asn: number | null;
  country: string | null;
  /** Where this probe actually is, or null when its coordinates can't say. */
  city: string | null;
  from: string | null;
}

export interface GroupResult {
  /** Node id in Phase B; ISO country code today. */
  key: string;
  requested: number;
  responded: number;
  summary: NodeSummary;
  probes: ProbeResult[];
}

/** How to attribute a probe to a group. */
export type KeyOf = (meta: ProbeMeta | undefined) => string;

/**
 * Group raw Atlas results and let the measurement type decode each row.
 *
 * Always reports `requested` vs `responded` so callers can see under-filled
 * groups ("JP requested 3, responded 1") rather than mistaking one probe for
 * a regional verdict — which matters a lot for countries where Atlas has
 * barely any probes.
 */
export async function aggregate(
  kind: MeasurementKind<unknown>,
  results: AtlasResultRow[],
  probeMeta: Map<number, ProbeMeta>,
  requested: Record<string, number>,
  keyOf: KeyOf,
): Promise<GroupResult[]> {
  const groups = new Map<string, GroupResult>();
  const ensure = (key: string): GroupResult => {
    let g = groups.get(key);
    if (!g) {
      g = { key, requested: requested[key] ?? 0, responded: 0, summary: {}, probes: [] };
      groups.set(key, g);
    }
    return g;
  };

  for (const row of results) {
    const meta = probeMeta.get(row.prb_id);
    const group = ensure(keyOf(meta));
    const outcome = await kind.parseRow(row);
    group.responded++;
    group.probes.push({
      ...outcome,
      probeId: row.prb_id,
      asn: meta?.asn_v4 ?? meta?.asn_v6 ?? null,
      country: meta?.country_code ?? null,
      // A node is one country and one operator, but its probes can be 2000 km
      // apart — which is most of the spread a reader would otherwise blame on
      // the network. Probes Atlas could only place to a country come back null.
      city: cityOfProbe(meta),
      from: typeof row.from === "string" ? row.from : null,
    });
  }

  // Surface requested groups that returned nothing at all.
  for (const key of Object.keys(requested)) ensure(key);

  for (const g of groups.values()) {
    g.summary = g.probes.length ? kind.summarize(g.probes) : {};
    g.probes.sort((a, b) => a.probeId - b.probeId);
  }

  return [...groups.values()].sort((a, b) => a.key.localeCompare(b.key));
}
