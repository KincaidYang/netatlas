import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import type { AtlasClient } from "../src/atlas";
import {
  MAX_TOTAL_PROBES,
  NODE_PRESETS,
  SEED_NODES,
  labelForId,
  matchesQuery,
  nodeKeyFor,
  parseNodeId,
  presetNodes,
  searchNodes,
  requestedFromProbeIds,
  resolveNodes,
  type Node,
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

describe("presetNodes", () => {
  it("resolves the continent presets the console shows", () => {
    for (const name of ["global", "china", "asia", "europe", "north_america", "south_america", "africa", "oceania"]) {
      expect(presetNodes(name)?.length).toBeGreaterThan(0);
    }
  });

  it("keeps retired preset names working for API callers", () => {
    // The console dropped 大中华 / 亚太 / 美洲, but this is a no-login public
    // API and someone's script may already send them. 400 there costs a
    // working tool to save us a map.
    expect(presetNodes("greater_china")).toEqual(presetNodes("china"));
    expect(presetNodes("apac")).toEqual(presetNodes("asia"));
    expect(presetNodes("americas")).toEqual([
      ...(presetNodes("north_america") ?? []),
      ...(presetNodes("south_america") ?? []),
    ]);
  });

  it("does not advertise the aliases", () => {
    // GET /presets returns NODE_PRESETS directly, so an alias listed there
    // would render as a duplicate button in the console.
    expect(Object.keys(NODE_PRESETS)).not.toContain("greater_china");
    expect(Object.keys(NODE_PRESETS)).not.toContain("apac");
  });

  it("returns null for a name that never existed", () => {
    expect(presetNodes("atlantis")).toBeNull();
  });

  it("keeps every preset inside the anonymous node ceiling", () => {
    // A preset larger than QUOTA.anon.maxNodes 400s for exactly the callers
    // most likely to use one.
    for (const [name, ids] of Object.entries(NODE_PRESETS)) {
      expect(ids.length, `preset ${name}`).toBeLessThanOrEqual(10);
    }
  });
});

describe("node search", () => {
  const node = (id: string, label: string, probes: number, holder: string | null = null): Node => {
    const [cc, asn] = id.split("-");
    return { id, cc: cc.toUpperCase(), asn: Number(asn), asnV6: null, label, holder, continent: "亚洲", probes, probesV6: 0 };
  };
  const pool = [
    node("cn-4134", "中国 · 电信", 12),
    node("tw-3462", "台湾 · 中华电信", 34),
    node("mn-10219", "蒙古 · AS10219", 1),
    node("de-3320", "德国 · Deutsche Telekom", 171, "Deutsche Telekom"),
  ];

  it("finds a node by id, by bare ASN, and by ASN with the prefix", () => {
    expect(searchNodes(pool, "cn-4134", 10).map((n) => n.id)).toEqual(["cn-4134"]);
    expect(searchNodes(pool, "10219", 10).map((n) => n.id)).toEqual(["mn-10219"]);
    expect(searchNodes(pool, "AS10219", 10).map((n) => n.id)).toEqual(["mn-10219"]);
  });

  it("finds a node by country name and by country code", () => {
    expect(searchNodes(pool, "蒙古", 10).map((n) => n.id)).toEqual(["mn-10219"]);
    expect(searchNodes(pool, "de", 10).map((n) => n.id)).toEqual(["de-3320"]);
  });

  it("finds a node by operator name, in either language", () => {
    expect(searchNodes(pool, "电信", 10).map((n) => n.id)).toEqual(["tw-3462", "cn-4134"]);
    expect(searchNodes(pool, "deutsche", 10).map((n) => n.id)).toEqual(["de-3320"]);
  });

  it("ranks by probe count, because one probe is the least useful answer", () => {
    expect(searchNodes(pool, "电信", 10).map((n) => n.probes)).toEqual([34, 12]);
  });

  it("includes single-probe nodes rather than hiding them", () => {
    // Two thirds of the ~5,000 pairs Atlas has a probe in have exactly one.
    // They are marked in the console, not withheld.
    expect(searchNodes(pool, "蒙古", 10)[0].probes).toBe(1);
  });

  it("returns nothing for an empty or whitespace query", () => {
    expect(searchNodes(pool, "", 10)).toEqual([]);
    expect(searchNodes(pool, "   ", 10)).toEqual([]);
    expect(matchesQuery(pool[0], "")).toBe(false);
  });

  it("respects the limit", () => {
    expect(searchNodes(pool, "e", 2).length).toBeLessThanOrEqual(2);
  });
});
