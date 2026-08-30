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

const FIELD = /\bd\.([a-zA-Z][a-zA-Z0-9]*)/g;

/**
 * Field names the console reads for one type.
 *
 * A type with no branch of its own — dns — falls through to the shared tail,
 * so that tail is what covers it. Returning an empty list for those was a hole
 * in the suite written to prevent holes: the loop skipped its assertions, and
 * renaming `answers` in `dnsKind.parseRow` would have left everything green.
 */
function fieldsFor(type: string): string[] {
  const body = outcomeBody();
  const start = body.indexOf(`if (type === "${type}")`);
  if (start === -1) return fallbackFields();
  // Up to the next branch, or — for the last one — up to the shared fallback
  // that handles types without a branch of their own. Without that second
  // stop, `ping` swept in the fallback's fields and demanded `d.answers` of it.
  const rest = body.slice(start + 1);
  const ends = [rest.indexOf('if (type === "'), rest.indexOf("if (Array.isArray(")].filter((i) => i !== -1);
  const branch = ends.length ? rest.slice(0, Math.min(...ends)) : rest;
  return [...new Set([...branch.matchAll(FIELD)].map((m) => m[1]))];
}

/**
 * The shared answer path at the end of `outcome()` — the branch a type without
 * one of its own lands in.
 *
 * Only that branch. The line after it, `return d.dstAddr ? …`, is the
 * last-resort for a type with neither a branch nor answers; dns never reaches
 * it, and demanding `dstAddr` of `dnsKind.parseRow` would be the test
 * modelling the code wrong rather than the code being wrong.
 */
function fallbackFields(): string[] {
  const body = outcomeBody();
  const at = body.indexOf("if (Array.isArray(");
  if (at === -1) throw new Error("shared fallback not found in outcome() — did it change shape?");
  const line = body.slice(at, body.indexOf("\n", at));
  return [...new Set([...line.matchAll(FIELD)].map((m) => m[1]))];
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
      expect(fields.length, `no fields extracted for ${type}`).toBeGreaterThan(0);
      const out = await (kind as { parseRow: (r: AtlasResultRow) => Promise<{ detail: object }> }).parseRow(
        ROWS[type as keyof typeof ROWS],
      );
      const produced = Object.keys(out.detail);
      for (const f of fields) {
        expect(produced, `${type}: console reads d.${f}, parseRow produced ${produced.join(", ")}`).toContain(f);
      }
    });
  }

  it("extracts fields for every type, including the ones with no branch", async () => {
    // Guards the extraction itself: if the regex stopped matching, every list
    // above would be empty and every assertion would pass vacuously.
    //
    // dns belongs in this list. Leaving it out was how the suite came to skip
    // dns entirely while claiming to cover six types — the same silent gap it
    // exists to catch, in the guard against silent gaps.
    for (const type of Object.keys(KINDS)) {
      expect(fieldsFor(type).length, `no fields extracted for ${type}`).toBeGreaterThan(0);
    }
    expect(fieldsFor("dns")).toContain("answers");
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

/**
 * A poll rewrites `#out` wholesale every three seconds. The order of the rows
 * is frozen while a run is still arriving (`state.order`); the disclosure state
 * has to be frozen for the same reason and was not, so a reader who opened a
 * traceroute's hop list got it closed under them on the next poll.
 *
 * Restoring it needs two halves that live 400 lines apart: every `<details>`
 * has to carry a content-stable key, and `render()` has to collect the open
 * ones before it overwrites and reapply them after. Either half alone silently
 * does nothing, which is why both are pinned here rather than described in a
 * comment.
 */
describe("what the reader opened survives a poll", () => {
  it("every disclosure carries a key", () => {
    const all = [...APP.matchAll(/<details\b[^>]*/g)].map((m) => m[0]);
    expect(all.length, "no <details> found — did the markup move?").toBeGreaterThan(0);
    for (const tag of all) expect(tag, `<details> without data-k: ${tag}`).toContain("data-k=");
  });

  it("the keys are content-stable, not positions", () => {
    // `i` is the render index and reorders as results arrive; the probe id and
    // the answer signature do not.
    expect(APP).toContain('data-k="hops:${esc(p.probeId)}"');
    // The answer key names the exact set; identity is not derived from it.
    // Both derived forms were wrong — the whole answer moves when a probe adds
    // an address, the first record moves when one sorts ahead of it — so the
    // restore matches by containment instead, and that is what is pinned here.
    expect(APP).toContain("state.answers.set(k, records)");
    // Containment, and one successor per predecessor. Both halves matter: the
    // predicate alone reopened every bucket that happened to contain what was
    // open, which expands answers the reader never touched.
    expect(APP).toMatch(/was\.records\.every\(\(r\) => recs\.includes\(r\)\)/);
    // One successor each, decided by matching rather than by first-come:
    // greedy assignment starves a predecessor whose only candidate was taken.
    expect(APP).toContain("heldBy.set(d, i)");
    expect(APP).toMatch(/claim\(incumbent, seen\)/);
    expect(APP).not.toContain('data-k="ans:${esc(records[0])}"');
  });

  it("render() collects the open keys before it overwrites, and reapplies after", () => {
    const body = /function render\(report, id\) \{([\s\S]*?)\n\}\n/.exec(APP);
    expect(body, "render() not found in public/app.js").toBeTruthy();
    const src = body![1];
    const collect = src.indexOf("details[data-k][open]");
    const write = src.indexOf('$("out").innerHTML =');
    const restore = src.lastIndexOf("d.open = true");
    expect(collect, "render() never reads the open disclosures").toBeGreaterThan(-1);
    expect(restore, "render() never reopens them").toBeGreaterThan(-1);
    // Reading after the overwrite reads an empty container: order is the point.
    expect(collect).toBeLessThan(write);
    expect(write).toBeLessThan(restore);
  });
});
