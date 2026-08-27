import { describe, expect, it } from "vitest";
import { aggregate } from "../src/aggregate";
import { nodeKeyFor } from "../src/nodes";
import type { MeasurementKind, ProbeOutcome } from "../src/measurements";
import type { AtlasResultRow, ProbeMeta } from "../src/types";

/** A stand-in type plugin: aggregation must not know what it is grouping. */
const fake: MeasurementKind<unknown> = {
  type: "fake",
  label: "fake",
  creditsPerProbe: () => 1,
  validate: () => ({}),
  buildDefinition: () => ({}),
  parseRow: (row): ProbeOutcome => ({
    ok: row.good === true,
    rttMs: typeof row.rtt === "number" ? row.rtt : null,
    error: row.good === true ? undefined : "nope",
    detail: { seen: row.prb_id },
  }),
  summarize: (outcomes) => ({ count: outcomes.length }),
};

const meta = (id: number, cc: string, asn: number): [number, ProbeMeta] => [
  id,
  { id, country_code: cc, asn_v4: asn, asn_v6: asn },
];

const probes = new Map<number, ProbeMeta>([
  meta(1, "DE", 3320),
  meta(2, "DE", 3320),
  meta(3, "JP", 4713),
  meta(9, "CN", 4134),
]);

const row = (prb_id: number, extra: Record<string, unknown> = {}): AtlasResultRow => ({ prb_id, ...extra });

describe("aggregate", () => {
  it("groups by node and delegates decoding to the type plugin", async () => {
    const groups = await aggregate(
      fake,
      [row(3, { good: true, rtt: 12 }), row(1, { good: true, rtt: 5 }), row(2, { good: false })],
      probes,
      { "de-3320": 2, "jp-4713": 1 },
      nodeKeyFor,
    );

    expect(groups.map((g) => g.key)).toEqual(["de-3320", "jp-4713"]);
    const de = groups[0];
    expect(de.responded).toBe(2);
    expect(de.requested).toBe(2);
    expect(de.summary).toEqual({ count: 2 });
    expect(de.probes.map((p) => p.probeId)).toEqual([1, 2]); // sorted, not arrival order
    expect(de.probes[0]).toMatchObject({ ok: true, rttMs: 5, asn: 3320, country: "DE" });
    expect(de.probes[1]).toMatchObject({ ok: false, error: "nope", rttMs: null });
  });

  it("surfaces a requested node that returned nothing at all", async () => {
    // This is the whole point of carrying `requested` around: China has ~65
    // connected probes nationwide, so under-filling is normal and must never
    // look like a complete answer.
    const groups = await aggregate(fake, [row(1, { good: true })], probes, { "de-3320": 2, "cn-4134": 2 }, nodeKeyFor);

    const cn = groups.find((g) => g.key === "cn-4134")!;
    expect(cn).toMatchObject({ requested: 2, responded: 0, probes: [], summary: {} });
    expect(groups.find((g) => g.key === "de-3320")).toMatchObject({ requested: 2, responded: 1 });
  });

  it("keeps results from probes nobody asked for, with requested 0", async () => {
    // Atlas can return a probe that has since moved networks; dropping it
    // would quietly lose a real measurement.
    const groups = await aggregate(fake, [row(9, { good: true })], probes, { "de-3320": 1 }, nodeKeyFor);
    expect(groups.find((g) => g.key === "cn-4134")).toMatchObject({ requested: 0, responded: 1 });
  });

  it("attributes a probe with no metadata to 'unknown' instead of dropping it", async () => {
    const groups = await aggregate(fake, [row(404, { good: true })], probes, {}, nodeKeyFor);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ key: "unknown", responded: 1 });
  });

  it("passes the reported source address through", async () => {
    const groups = await aggregate(fake, [row(1, { good: true, from: "1.2.3.4" })], probes, {}, nodeKeyFor);
    expect(groups[0].probes[0].from).toBe("1.2.3.4");
  });

  it("supports grouping by country, for measurements made before nodes existed", async () => {
    const byCountry = (m: ProbeMeta | undefined) => (m?.country_code ?? "??").toLowerCase();
    const groups = await aggregate(fake, [row(1), row(2), row(3)], probes, { de: 2, jp: 1 }, byCountry);
    expect(groups.map((g) => [g.key, g.responded])).toEqual([
      ["de", 2],
      ["jp", 1],
    ]);
  });

  it("returns groups in a stable order", async () => {
    const groups = await aggregate(fake, [], probes, { "jp-4713": 1, "cn-4134": 1, "de-3320": 1 }, nodeKeyFor);
    expect(groups.map((g) => g.key)).toEqual(["cn-4134", "de-3320", "jp-4713"]);
  });
});
