import { describe, expect, it } from "vitest";
import { KINDS, KIND_TYPES } from "../src/measurements";
import {
  DEFAULT_PUBLIC_DAILY_CREDITS,
  QUOTA,
  bucketFor,
  dayKey,
  publicDailyCredits,
  sha256Hex,
} from "../src/quota";
import { NODE_PRESETS } from "../src/nodes";

/**
 * The per-probe prices were measured against real spend (RIPE documents only
 * the first four). Getting one wrong means the ledger drifts from the account,
 * so they are pinned here as well as in CLAUDE.md.
 */
const PRICES: Record<string, number> = {
  ping: 3,
  dns: 10,
  traceroute: 30,
  sslcert: 10,
  http: 20,
  ntp: 20,
};

describe("credit estimation", () => {
  it("prices every registered type as measured", () => {
    expect(new Set(KIND_TYPES)).toEqual(new Set(Object.keys(PRICES)));
    for (const [type, price] of Object.entries(PRICES)) {
      expect(KINDS.get(type)!.creditsPerProbe({} as never), type).toBe(price);
    }
  });

  it("charges double for DNS over TCP", () => {
    const dns = KINDS.get("dns")!;
    expect(dns.creditsPerProbe({ protocol: "TCP" } as never)).toBe(20);
    expect(dns.creditsPerProbe({ protocol: "UDP" } as never)).toBe(10);
  });

  it("keeps the worst anonymous request affordable against the daily pot", () => {
    // The expensive corner: traceroute, every node the tier allows, filled.
    const { maxNodes, maxPerNode, dailyCredits } = QUOTA.anon;
    const worst = PRICES.traceroute * maxNodes * maxPerNode;
    expect(worst).toBe(600);
    expect(worst).toBeLessThanOrEqual(dailyCredits);
    // …and one caller draining their whole day must not drain the public pot.
    expect(dailyCredits * 10).toBeLessThanOrEqual(DEFAULT_PUBLIC_DAILY_CREDITS);
  });

  it("sits below the account's real daily income", () => {
    // The account earns ~141k-163k/day from the probes it hosts; the public
    // budget runs on that interest and never touches the principal.
    expect(DEFAULT_PUBLIC_DAILY_CREDITS).toBeLessThan(141_000);
  });
});

describe("tier policy", () => {
  it("gives every shipped preset a chance of being submitted anonymously", () => {
    // A preset the default tier cannot submit means the console's own default
    // selection is rejected before it can create anything.
    for (const [name, nodes] of Object.entries(NODE_PRESETS)) {
      expect(nodes.length, `preset '${name}'`).toBeLessThanOrEqual(QUOTA.anon.maxNodes);
    }
  });

  it("is looser for callers spending their own credits", () => {
    expect(QUOTA.byok.maxNodes).toBeGreaterThan(QUOTA.anon.maxNodes);
    expect(QUOTA.byok.job.capacity).toBeGreaterThan(QUOTA.anon.job.capacity);
    expect(QUOTA.byok.job.refillSeconds).toBeLessThan(QUOTA.anon.job.refillSeconds);
    expect(QUOTA.byok.countsAgainstGlobalBudget).toBe(false);
    expect(QUOTA.byok.dailyCredits).toBe(0); // 0 = unmetered
  });

  it("puts traceroute in a tighter bucket than everything else", () => {
    for (const tier of ["anon", "byok"] as const) {
      expect(QUOTA[tier].traceroute.capacity).toBeLessThan(QUOTA[tier].job.capacity);
      expect(QUOTA[tier].traceroute.refillSeconds).toBeGreaterThan(QUOTA[tier].job.refillSeconds);
    }
  });

  it("routes each type to its bucket", () => {
    expect(bucketFor("anon", "traceroute")).toEqual({ name: "traceroute", spec: QUOTA.anon.traceroute });
    for (const type of ["ping", "dns", "sslcert", "http", "ntp"]) {
      expect(bucketFor("anon", type).name).toBe("job");
    }
  });
});

describe("publicDailyCredits", () => {
  it("falls back to the default for anything that is not a usable number", () => {
    for (const raw of [undefined, "", "abc", "-1", "NaN"]) {
      expect(publicDailyCredits(raw)).toBe(DEFAULT_PUBLIC_DAILY_CREDITS);
    }
  });

  it("honours an explicit override, including zero as a kill switch", () => {
    expect(publicDailyCredits("500")).toBe(500);
    expect(publicDailyCredits("0")).toBe(0);
  });
});

describe("dayKey", () => {
  it("is the UTC date, so budgets reset with Atlas's own day", () => {
    expect(dayKey(Date.UTC(2026, 7, 27, 23, 59, 59))).toBe("2026-08-27");
    expect(dayKey(Date.UTC(2026, 7, 28, 0, 0, 0))).toBe("2026-08-28");
  });
});

describe("sha256Hex", () => {
  it("hashes identities so no raw IP or Atlas key is ever stored", async () => {
    await expect(sha256Hex("abc")).resolves.toBe(
      "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
    );
    await expect(sha256Hex("")).resolves.toHaveLength(64);
    expect(await sha256Hex("1.2.3.4")).not.toBe(await sha256Hex("1.2.3.5"));
  });
});
