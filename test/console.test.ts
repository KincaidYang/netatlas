import { describe, expect, it } from "vitest";
import { dns } from "../src/measurements/dnsKind";
import { http } from "../src/measurements/http";
import { ntp } from "../src/measurements/ntp";
import { ping } from "../src/measurements/ping";
import { sslcert } from "../src/measurements/sslcert";
import { traceroute } from "../src/measurements/traceroute";
import real from "./fixtures/real.pem?raw";
import APP from "../public/app.js?raw";
import DOC from "../CLAUDE.md?raw";
import type { AtlasResultRow } from "../src/types";

/**
 * The console reads `probe.detail` by field name and renders whatever it finds.
 * Nothing connects those names to the `parseRow` that produces them, so a
 * rename in a measurement kind shows an empty cell rather than failing — the
 * quietest failure available, on the page a reader trusts.
 *
 * These tests take the names out of `public/app.js` itself and check that the
 * parsers still produce them. Rename a field on either side and this goes red.
 *
 * They read the console as text on purpose: it is plain browser JavaScript with
 * no build step (see the header of app.js), so there is nothing to import.
 */
// Read as text through vite's `?raw`, the way the certificate fixtures are —
// the console is browser JavaScript with no build step, so there is nothing to
// import from it, and this project has no node types.

/** The body of `outcome()`, which is where per-type detail fields are read. */
function outcomeBody(): string {
  const m = /function outcome\(type, p\) \{([\s\S]*?)\n\}\n/.exec(APP);
  if (!m) throw new Error("outcome() not found in public/app.js — did it move or get renamed?");
  return m[1];
}

/** Field names the console reads inside one type's branch of `outcome()`. */
function fieldsFor(type: string): string[] {
  const body = outcomeBody();
  const start = body.indexOf(`if (type === "${type}")`);
  if (start === -1) return [];
  // Up to the next branch, or — for the last one — up to the shared fallback
  // that handles types without a branch of their own. Without that second
  // stop, `ping` swept in the fallback's fields and demanded `d.answers` of it.
  const rest = body.slice(start + 1);
  const ends = [rest.indexOf('if (type === "'), rest.indexOf("if (Array.isArray(")].filter((i) => i !== -1);
  const branch = ends.length ? rest.slice(0, Math.min(...ends)) : rest;
  return [...new Set([...branch.matchAll(/\bd\.([a-zA-Z][a-zA-Z0-9]*)/g)].map((m) => m[1]))];
}

const row = (o: Record<string, unknown>): AtlasResultRow => ({ prb_id: 1, ...o });

/** One row per type, shaped to exercise every field the console can show. */
const ROWS = {
  ping: row({ sent: 4, rcvd: 3, min: 10, avg: 20, max: 30, dst_addr: "1.1.1.1" }),
  traceroute: row({
    dst_addr: "1.1.1.1",
    result: [
      { hop: 1, result: [{ from: "192.0.2.1", rtt: 1 }, { x: "*" }, { from: "192.0.2.1", rtt: 2 }] },
      { hop: 2, result: [{ x: "*" }, { x: "*" }, { x: "*" }] },
    ],
  }),
  dns: row({
    result: {
      abuf: "EjSBgAABAAIAAAAAA2RucwZnb29nbGUAAAEAAcAMAAEAAQAAAHsABAgIBATADAABAAEAAAB7AAQICAgI",
      rt: 12.5,
    },
  }),
  http: row({ result: [{ res: 200, hsize: 100, bsize: 200, ver: "1.1", rt: 30, dst_addr: "1.1.1.1" }] }),
  ntp: row({
    stratum: 2,
    "ref-ts": 3996813481.06,
    timestamp: 1787824681,
    "root-delay": 0.024,
    "root-dispersion": 0.003,
    dst_addr: "1.1.1.1",
    result: [{ rtt: 0.023, offset: 0.005, "final-ts": 3996813481.72 }],
  }),
  sslcert: row({ cert: [real], dst_addr: "1.1.1.1", rt: 40 }),
} as const;

const KINDS = { ping, traceroute, dns, http, ntp, sslcert } as const;

describe("console ↔ parseRow field contract", () => {
  for (const [type, kind] of Object.entries(KINDS)) {
    it(`${type}: every field the console reads is produced by parseRow`, async () => {
      const fields = fieldsFor(type);
      // A type with no branch of its own falls through to the shared answer /
      // destination path, which the dns case already covers.
      if (fields.length === 0) return;
      const out = await (kind as { parseRow: (r: AtlasResultRow) => Promise<{ detail: object }> }).parseRow(
        ROWS[type as keyof typeof ROWS],
      );
      const produced = Object.keys(out.detail);
      for (const f of fields) {
        expect(produced, `${type}: console reads d.${f}, parseRow produced ${produced.join(", ")}`).toContain(f);
      }
    });
  }

  it("reads at least one field for the types whose finding is not the address", async () => {
    // Guards the extraction itself: if the regex stopped matching, every list
    // above would be empty and every assertion would pass vacuously.
    for (const type of ["ntp", "sslcert", "http", "traceroute"]) {
      expect(fieldsFor(type).length, `no fields extracted for ${type}`).toBeGreaterThan(0);
    }
  });
});

/**
 * CLAUDE.md states these numbers in prose. Three times on this branch a comment
 * of mine described behaviour the code did not have, so the numbers are held
 * here rather than trusted.
 */
describe("console thresholds match what CLAUDE.md claims", () => {
  const constant = (name: string): number => {
    const m = new RegExp(`${name} = (\\d+)`).exec(APP);
    if (!m) throw new Error(`${name} not found in public/app.js`);
    return Number(m[1]);
  };

  it("an outlier is 3x the baseline and 100 ms above it", () => {
    expect(constant("OUTLIER_RATIO")).toBe(3);
    expect(constant("OUTLIER_GAP_MS")).toBe(100);
    expect(DOC.replace(/\s+/g, " ")).toMatch(/3x the baseline and 100 ms above it/);
  });

  it("the first view flips to the table past twelve nodes", () => {
    const m = /groups\.length > (\d+) \? "table"/.exec(APP);
    expect(m, "view threshold not found in public/app.js").toBeTruthy();
    expect(Number(m![1])).toBe(12);
    expect(DOC).toContain("cards up to twelve nodes, table beyond");
  });

  it("staleness and expiry thresholds are the ones written down", () => {
    // An hour of clock staleness, fourteen days of certificate.
    expect(APP).toContain("d.refAgeSec > 3600");
    expect(APP).toContain("d.probeClockAgeSec > 3600");
    expect(APP).toContain("d.daysLeft < 14");
    // Whitespace-collapsed: the sentence wraps in the document.
    expect(DOC.replace(/\s+/g, " ")).toMatch(/an hour of clock staleness and fourteen days of certificate/);
  });
});
