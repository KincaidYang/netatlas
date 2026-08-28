import { describe, expect, it } from "vitest";
import { cityFor, cityOf, cityOfProbe } from "../src/geo";

/**
 * Every coordinate below was taken from a real connected probe in the Atlas
 * catalogue (or, for the misses, from a place Atlas puts probes that no city
 * can honestly claim). RIPE rounds probe coordinates to roughly a 1 km grid,
 * so these are the actual precision the lookup has to survive.
 */
describe("cityFor", () => {
  it("names probes in China from the hand-written table", () => {
    expect(cityFor(39.9115, 116.3875, "CN")).toBe("北京");
    expect(cityFor(34.77, 113.7199, "CN")).toBe("郑州");
    expect(cityFor(22.4568, 114.096, "CN")).toBe("深圳");
    expect(cityFor(22.2775, 114.1795, "HK")).toBe("香港");
    expect(cityFor(25.0532, 121.5396, "TW")).toBe("台北");
    expect(cityFor(22.6223, 120.3663, "TW")).toBe("高雄");
  });

  it("reaches county-level probes through their prefecture city", () => {
    // These three are the only probes in their region and sit 45-100 km from
    // the city centre; the table carries an extra row for each so the reader
    // gets 南阳 / 重庆 / 宁波 rather than nothing.
    expect(cityFor(33.1385, 111.4815, "CN")).toBe("南阳");
    expect(cityFor(29.9015, 108.5385, "CN")).toBe("重庆");
    expect(cityFor(29.2805, 121.6205, "CN")).toBe("宁波");
  });

  it("names probes abroad, in Chinese where the override table has one", () => {
    expect(cityFor(35.6875, 139.6905, "JP")).toBe("东京");
    expect(cityFor(50.1095, 8.6785, "DE")).toBe("法兰克福");
    expect(cityFor(52.3555, 4.9555, "NL")).toBe("阿姆斯特丹");
    // 80 probes sit here — the densest cluster in the US. Before the table
    // reached down to Ashburn's 43k population they were all called 阿灵顿,
    // 38 km away.
    expect(cityFor(39.0437, -77.4875, "US")).toBe("阿什本");
    // No Chinese name for this one, so GeoNames' own stands rather than a
    // guess. An English name a reader can look up beats an invented one.
    expect(cityFor(37.4685, -121.9215, "US")).toBe("Fremont");
  });

  it("answers with the metro, not the ward it happens to sit in", () => {
    // cities15000 carries Tokyo's 台東, London's Islington and Singapore's
    // housing estates as if they were cities. Build-time merging folds a place
    // into a neighbour at least 5x its size within 35 km, so these read as the
    // city that actually measured, not as an address.
    expect(cityFor(35.7125, 139.7795, "JP")).toBe("东京");
    expect(cityFor(51.5385, -0.1035, "GB")).toBe("伦敦");
    expect(cityFor(1.3695, 103.8455, "SG")).toBe("新加坡");
  });

  it("says nothing when no city is within reach", () => {
    expect(cityFor(0, -140)).toBeNull(); // middle of the Pacific
    expect(cityFor(-75.1, 123.4, "AQ")).toBeNull(); // Antarctica
  });

  it("keeps the 50 km promise where a degree of longitude is short", () => {
    // A degree of longitude is 111 km at the equator but 39 km at Tromsø, so a
    // fixed one-bucket search silently broke the contract in the north: this
    // probe is 44 km from Tromsø and two buckets away from it.
    expect(cityFor(69.6489, 20.1, "NO")).toBe("Tromsø");
    // Murmansk sits at 33.10E; 34.15E is 46 km away and, again, two buckets.
    expect(cityFor(68.9585, 34.15, "RU")).toBe("Murmansk");
  });

  it("refuses to name a country-centroid coordinate", () => {
    // Atlas tags ~500 probes `system-auto-geoip-country`; their coordinates are
    // the middle of the country, not a place. Naming them would invent a fact.
    expect(cityFor(35.0, 105.0, "CN")).toBeNull(); // geographic centre of China
    expect(cityFor(-25.0, 135.0, "AU")).toBeNull(); // centre of Australia
  });

  it("prefers the probe's own country when two cities are equally close", () => {
    // Probe 6982 is an anchor filed under CN whose coordinates are in Hong
    // Kong. The coordinates win: a border must not leak names across.
    expect(cityFor(22.3685, 114.1215, "CN")).toBe("香港");
  });

  it("rejects coordinates that are not numbers", () => {
    expect(cityFor(Number.NaN, 116.4)).toBeNull();
    expect(cityFor(39.9, Number.POSITIVE_INFINITY)).toBeNull();
  });
});

describe("cityOf", () => {
  it("reads GeoJSON order — longitude first, latitude second", () => {
    expect(cityOf({ coordinates: [116.3875, 39.9115] }, "CN")).toBe("北京");
    // Swapping them lands in the Indian Ocean, which has no city.
    expect(cityOf({ coordinates: [39.9115, 116.3875] }, "CN")).toBeNull();
  });

  it("tolerates the metadata simply not being there", () => {
    expect(cityOf(undefined, "CN")).toBeNull();
    expect(cityOf(null, "CN")).toBeNull();
    expect(cityOf({}, "CN")).toBeNull();
    expect(cityOf({ coordinates: [116.3875] }, "CN")).toBeNull();
  });
});

describe("cityOfProbe", () => {
  const centroid = { coordinates: [5.2913, 52.1326] as [number, number] };

  it("says nothing for a probe Atlas could only place to a country", () => {
    // The middle of the Netherlands is 12 km from Amersfoort, so the centroid
    // does resolve — which is exactly why the tag has to be honoured. Reading
    // coordinates alone would put a fabricated city on ~490 probes.
    expect(
      cityOfProbe({
        id: 1,
        country_code: "NL",
        geometry: centroid,
        tags: [{ slug: "system-ipv4-works" }, { slug: "system-auto-geoip-country" }],
      }),
    ).toBeNull();
  });

  it("names the same coordinates when the probe is not a centroid", () => {
    expect(
      cityOfProbe({
        id: 2,
        country_code: "NL",
        geometry: centroid,
        tags: [{ slug: "system-auto-geoip-city" }],
      }),
    ).toBe("Amersfoort");
    // Tags absent entirely — a host-placed probe, which is the common case.
    expect(cityOfProbe({ id: 3, country_code: "NL", geometry: centroid })).toBe("Amersfoort");
  });

  it("still names a territory that is one metro anyway", () => {
    // 12 of Hong Kong's 61 connected probes carry the country tag, and the
    // fallback point for Hong Kong is central Hong Kong. The whole territory
    // fits inside the match radius, so the tag costs no precision here.
    expect(
      cityOfProbe({
        id: 5,
        country_code: "HK",
        geometry: { coordinates: [114.1675, 22.2575] },
        tags: [{ slug: "system-auto-geoip-country" }],
      }),
    ).toBe("香港");
  });

  it("does not invent the Zhengzhou cluster", () => {
    // All 16 of China's country-tagged probes sit on this one point — what
    // GeoIP returns for "somewhere in China", which lands beside Zhengzhou.
    // Reading the coordinates would report a cluster that does not exist.
    expect(cityFor(34.7705, 113.7205, "CN")).toBe("郑州");
    expect(
      cityOfProbe({
        id: 6,
        country_code: "CN",
        geometry: { coordinates: [113.7205, 34.7705] },
        tags: [{ slug: "system-auto-geoip-country" }],
      }),
    ).toBeNull();
  });

  it("tolerates missing metadata", () => {
    expect(cityOfProbe(undefined)).toBeNull();
    expect(cityOfProbe(null)).toBeNull();
    expect(cityOfProbe({ id: 4 })).toBeNull();
  });
});
