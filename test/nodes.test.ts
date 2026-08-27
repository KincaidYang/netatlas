import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import type { AtlasClient } from "../src/atlas";
import {
  MAX_TOTAL_PROBES,
  NODE_PRESETS,
  SEED_NODES,
  labelForId,
  nodeKeyFor,
  parseNodeId,
  requestedFromProbeIds,
  resolveNodes,
} from "../src/nodes";
import type { ProbeMeta } from "../src/types";

describe("node ids", () => {
  it("are self-describing, so selection never depends on the catalogue", () => {
    expect(parseNodeId("cn-4134")).toEqual({ cc: "CN", asn: 4134 });
    expect(parseNodeId("  US-7922 ")).toEqual({ cc: "US", asn: 7922 });
  });

  it("reject anything that is not a country/ASN pair", () => {
    for (const bad of ["cn", "4134", "cn-", "chn-4134", "cn-abc", "cn-4134-x", ""]) {
      expect(parseNodeId(bad), bad).toBeNull();
    }
  });

  it("label catalogued and uncatalogued nodes alike", () => {
    expect(labelForId("cn-4134")).toContain("电信");
    // AS64500 is not in the catalogue; the country still resolves.
    expect(labelForId("jp-64500")).toBe("日本 · AS64500");
    expect(labelForId("not-a-node")).toBe("not-a-node");
  });
});

describe("nodeKeyFor", () => {
  const meta = (o: Partial<ProbeMeta>): ProbeMeta => ({ id: 1, ...o });

  it("prefers the ASN the catalogue knows about", () => {
    // A probe's v4 and v6 ASNs can differ; picking the wrong one splits one
    // node's results into two groups.
    expect(nodeKeyFor(meta({ country_code: "CN", asn_v4: 4134, asn_v6: 4809 }))).toBe("cn-4134");
    expect(nodeKeyFor(meta({ country_code: "CN", asn_v4: 65001, asn_v6: 4134 }))).toBe("cn-4134");
  });

  it("still produces a sensible key for a node nobody catalogued", () => {
    expect(nodeKeyFor(meta({ country_code: "JP", asn_v4: 64500 }))).toBe("jp-64500");
    expect(nodeKeyFor(meta({ country_code: "JP" }))).toBe("jp");
    expect(nodeKeyFor(undefined)).toBe("unknown");
  });
});

describe("requestedFromProbeIds", () => {
  it("rebuilds per-node counts from Atlas's stored selection", () => {
    // This is what replaces a database: the probe ids Atlas kept tell us what
    // was requested per node, long after the request itself is gone.
    const meta = new Map<number, ProbeMeta>([
      [1, { id: 1, country_code: "DE", asn_v4: 3320 }],
      [2, { id: 2, country_code: "DE", asn_v4: 3320 }],
      [3, { id: 3, country_code: "JP", asn_v4: 4713 }],
    ]);
    expect(requestedFromProbeIds([{ ids: [1, 2, 3] }], meta)).toEqual({ "de-3320": 2, "jp-4713": 1 });
  });
});

/** A client that answers findProbes from a fixed pool, and can be told to fail. */
function fakeClient(pool: ProbeMeta[], failOn: (asns: number[]) => boolean = () => false) {
  const calls: number[][] = [];
  const client = {
    findProbes: async ({ asns, countries }: { asns?: number[]; countries?: string[] }) => {
      calls.push(asns ?? []);
      if (failOn(asns ?? [])) throw new HTTPException(400, { message: "atlas said no" });
      // Atlas ANDs two OR-sets, so it can return pairs nobody asked for.
      return pool.filter(
        (p) => asns?.includes(p.asn_v4!) && countries?.includes(p.country_code!.toUpperCase()),
      );
    },
  } as unknown as AtlasClient;
  return { client, calls };
}

const probe = (id: number, cc: string, asn: number): ProbeMeta => ({ id, country_code: cc, asn_v4: asn, asn_v6: asn });

describe("resolveNodes", () => {
  const pool = [
    probe(11, "DE", 3320),
    probe(12, "DE", 3320),
    probe(13, "DE", 3320),
    probe(21, "JP", 4713),
    // The cross-product Atlas may hand back: JP × AS3320 was never asked for.
    probe(31, "JP", 3320),
  ];

  it("resolves nodes to explicit probe ids, one Atlas group per node", async () => {
    const { client } = fakeClient(pool);
    const out = await resolveNodes(client, ["de-3320", "jp-4713"], 2, 4);

    expect(out.probes).toHaveLength(2);
    for (const g of out.probes) expect(g.type).toBe("probes");
    const ids = out.probes.flatMap((g) => String(g.value).split(",").map(Number));
    expect(ids).toHaveLength(3); // 2 from DE, 1 from JP (only one exists)
    expect(out.requested).toEqual({ "de-3320": 2, "jp-4713": 1 });
    expect(out.available).toEqual({ "de-3320": 3, "jp-4713": 1 });
    expect(out.unavailable).toEqual([]);
  });

  it("drops the country/ASN pairs nobody asked for", async () => {
    // ASN selection in Atlas is global — this is exactly how "香港 · AWS"
    // would otherwise end up probing from Virginia.
    const { client } = fakeClient(pool);
    const out = await resolveNodes(client, ["de-3320", "jp-4713"], 3, 4);
    const ids = out.probes.flatMap((g) => String(g.value).split(",").map(Number));
    expect(ids).not.toContain(31);
    expect(ids.sort()).toEqual([11, 12, 13, 21]);
  });

  it("reports a node with no connected probe instead of failing the request", async () => {
    const { client } = fakeClient(pool);
    const out = await resolveNodes(client, ["de-3320", "cn-4134"], 1, 4);
    expect(out.unavailable).toEqual(["cn-4134"]);
    expect(out.available["cn-4134"]).toBe(0);
    expect(out.requested).toEqual({ "de-3320": 1 });
  });

  it("retries node by node when one bad entry makes Atlas reject the batch", async () => {
    // One unknown country code must not take everyone else's measurement down
    // with it.
    const { client, calls } = fakeClient(pool, (asns) => asns.includes(65999));
    const out = await resolveNodes(client, ["de-3320", "zz-65999"], 1, 4);
    expect(out.requested).toEqual({ "de-3320": 1 });
    expect(out.unavailable).toEqual(["zz-65999"]);
    expect(calls.length).toBeGreaterThan(1); // batch, then per node
  });

  it("accepts a well-formed node the catalogue has never heard of", async () => {
    const { client } = fakeClient([probe(41, "JP", 64500)]);
    const out = await resolveNodes(client, ["jp-64500"], 1, 4);
    expect(out.requested).toEqual({ "jp-64500": 1 });
  });

  it("rejects malformed and empty selections", async () => {
    const { client } = fakeClient(pool);
    await expect(resolveNodes(client, [], 1, 4)).rejects.toThrow(/at least one node/);
    await expect(resolveNodes(client, ["not-a-node"], 1, 4)).rejects.toThrow(/invalid node/);
  });

  it("caps the total probe count a single request can buy", async () => {
    const { client } = fakeClient(pool);
    const many = Array.from({ length: 25 }, (_, i) => `de-${3320 + i}`);
    await expect(resolveNodes(client, many, 3, 4)).rejects.toThrow(
      new RegExp(`exceeds cap of ${MAX_TOTAL_PROBES}`),
    );
  });

  it("gives up with 503, not a mystery, when nothing at all is connected", async () => {
    const { client } = fakeClient([]);
    await expect(resolveNodes(client, ["de-3320"], 1, 4)).rejects.toMatchObject({ status: 503 });
  });

  it("de-duplicates and lower-cases the requested node list", async () => {
    const { client } = fakeClient(pool);
    const out = await resolveNodes(client, ["DE-3320", "de-3320", " de-3320 "], 1, 4);
    expect(out.probes).toHaveLength(1);
  });
});

describe("catalogue seed", () => {
  it("stays small enough to scan, and every preset points at real nodes", () => {
    // The catalogue is a starting point for humans, not an inventory: a
    // thousand nodes makes the picker useless.
    expect(SEED_NODES.length).toBeLessThanOrEqual(300);
    const ids = new Set(SEED_NODES.map((n) => n.id));
    for (const [name, nodes] of Object.entries(NODE_PRESETS)) {
      expect(nodes.length, `preset '${name}' is empty`).toBeGreaterThan(0);
      for (const id of nodes) expect(ids.has(id), `preset '${name}' references ${id}`).toBe(true);
    }
  });

  it("gives every node a well-formed id matching its country and ASN", () => {
    for (const n of SEED_NODES) {
      expect(parseNodeId(n.id), n.id).toEqual({ cc: n.cc.toUpperCase(), asn: n.asn });
    }
  });
});
