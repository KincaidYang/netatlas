import { describe, expect, it } from "vitest";
import { groupProbes } from "../src/probe-grouping";

/**
 * These rules were paid for with wrong catalogues on a live service, and until
 * now they lived in two hand-copied implementations — `src/catalog.ts`'s
 * 3-hourly sweep and `scripts/build-nodes.mjs` — with nothing checking that the
 * copies agreed. There is one copy now, so these tests cover both sweeps.
 */
describe("groupProbes", () => {
  it("keys a group by the v4 ASN, never the v6 one", () => {
    // An IPv6-only probe cannot be addressed by any node id, because a node id
    // is `cc-<v4 ASN>`. Keying it by its v6 ASN invented 61 groups that
    // resolved to nothing — search offered them and selecting one always came
    // back `unavailable`.
    const groups = groupProbes([
      { country_code: "NL", asn_v4: 1136, asn_v6: 1136 },
      { country_code: "NL", asn_v4: null, asn_v6: 1136 },
    ]);
    expect(groups.get("nl-1136")?.v4).toBe(1);
    expect(groups.size).toBe(1);
  });

  it("does not credit a node with IPv4 probes that have no IPv4", () => {
    // KPN uses 1136 for both families, which is how `nl-1136` came to count
    // probes that cannot answer an IPv4 measurement at all.
    const groups = groupProbes([
      { country_code: "NL", asn_v4: null, asn_v6: 1136 },
      { country_code: "NL", asn_v4: null, asn_v6: 1136 },
    ]);
    expect(groups.get("nl-1136")).toBeUndefined();
  });

  it("drops the probes Atlas could not place", () => {
    // `?-29802` would be counted among the pairs the console calls 全部可搜索
    // and then rejected by parseNodeId() — advertised and unselectable.
    const groups = groupProbes([
      { country_code: "?", asn_v4: 29802, asn_v6: null },
      { country_code: null, asn_v4: 29802, asn_v6: null },
      { country_code: "US", asn_v4: null, asn_v6: null },
    ]);
    expect(groups.size).toBe(0);
  });

  it("lowercases the country, because that is the form a node id takes", () => {
    const groups = groupProbes([{ country_code: "DE", asn_v4: 3320, asn_v6: null }]);
    expect([...groups.keys()]).toEqual(["de-3320"]);
    expect(groups.get("de-3320")?.cc).toBe("de");
  });

  it("keeps the dominant v6 ASN, not merely a v6 ASN", () => {
    // A probe can reach IPv6 through a tunnel broker on an unrelated AS. Taking
    // any v6-capable probe measures Hurricane Electric's path while claiming
    // the operator's, so the majority wins.
    const groups = groupProbes([
      { country_code: "DE", asn_v4: 8899, asn_v6: 8899 },
      { country_code: "DE", asn_v4: 8899, asn_v6: 8899 },
      { country_code: "DE", asn_v4: 8899, asn_v6: 6939 }, // tunnel broker
    ]);
    const g = groups.get("de-8899")!;
    expect(g.asnV6).toBe(8899);
    expect(g.v4).toBe(3);
    expect(g.v6).toBe(3);
  });

  it("reports no v6 ASN rather than a wrong one when nothing has IPv6", () => {
    const groups = groupProbes([{ country_code: "CN", asn_v4: 4812, asn_v6: null }]);
    expect(groups.get("cn-4812")?.asnV6).toBeNull();
    expect(groups.get("cn-4812")?.v6).toBe(0);
  });

  it("counts every connected probe it is given, private ones included", () => {
    // The sweep must not filter `is_public`: `findProbes` does not, so a
    // catalogue that did would plan against a different population than the one
    // it measures. There is no such filter here, and there must not be one.
    const groups = groupProbes(
      Array.from({ length: 5 }, () => ({ country_code: "CN", asn_v4: 4134, asn_v6: null })),
    );
    expect(groups.get("cn-4134")?.v4).toBe(5);
  });
});
