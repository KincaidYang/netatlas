import { afterEach, describe, expect, it, vi } from "vitest";
import { DESCRIPTION_MAX, buildDescription } from "../src/describe";
import { dns, SUPPORTED_QUERY_TYPES } from "../src/measurements/dnsKind";
import { http } from "../src/measurements/http";
import { ntp } from "../src/measurements/ntp";
import { ping } from "../src/measurements/ping";
import { sslcert } from "../src/measurements/sslcert";
import { traceroute } from "../src/measurements/traceroute";
import real from "./fixtures/real.pem?raw";
import rsa from "./fixtures/rsa.pem?raw";
import { rttStats, stringifyError } from "../src/measurements/kind";
import type { AtlasResultRow } from "../src/types";

const row = (o: Record<string, unknown>): AtlasResultRow => ({ prb_id: 1, ...o });

describe("ping.parseRow", () => {
  it("reads a normal result", async () => {
    const out = await ping.parseRow(row({ sent: 3, rcvd: 3, min: 10.1, avg: 10.2345, max: 10.9, ttl: 54, dst_addr: "1.1.1.1" }));
    expect(out.ok).toBe(true);
    expect(out.rttMs).toBe(10.235); // rounded to 3 decimals
    expect(out.detail).toMatchObject({ lossPct: 0, sent: 3, rcvd: 3, ttl: 54, dstAddr: "1.1.1.1" });
  });

  it("never reports Atlas's -1 as a negative round-trip time", async () => {
    // Atlas puts -1 in min/avg/max when nothing came back. That is "no
    // measurement", and showing it as a latency is worse than showing nothing.
    const out = await ping.parseRow(row({ sent: 3, rcvd: 0, min: -1, avg: -1, max: -1 }));
    expect(out).toMatchObject({ ok: false, rttMs: null, error: "all packets lost" });
    expect(out.detail).toMatchObject({ lossPct: 100, min: null, avg: null, max: null });
  });

  it("computes partial loss", async () => {
    expect((await ping.parseRow(row({ sent: 4, rcvd: 3, avg: 20 }))).detail.lossPct).toBe(25);
  });

  it("reports a probe-level error without inventing detail", async () => {
    expect(await ping.parseRow(row({ error: { reason: "network unreachable" } }))).toEqual({
      ok: false,
      rttMs: null,
      error: "network unreachable",
      detail: {},
    });
  });

  it("summarises loss across a node's probes", async () => {
    const outcomes = [
      await ping.parseRow(row({ sent: 3, rcvd: 3, avg: 10 })),
      await ping.parseRow(row({ sent: 3, rcvd: 0, avg: -1 })),
    ];
    expect(ping.summarize(outcomes)).toEqual({ rttMs: { min: 10, avg: 10, max: 10 }, lossPct: 50 });
  });
});

describe("traceroute.parseRow", () => {
  const hops = [
    { hop: 1, result: [{ from: "192.0.2.1", rtt: 1.234 }] },
    { hop: 2, result: [{ x: "*" }, { x: "*" }] },
    { hop: 3, result: [{ from: "203.0.113.9", rtt: 9.5 }] },
  ];

  it("marks the target reached when the last responder is the destination", async () => {
    const out = await traceroute.parseRow(row({ dst_addr: "203.0.113.9", result: hops }));
    expect(out).toMatchObject({ ok: true, rttMs: 9.5 });
    expect(out.detail).toMatchObject({ hopCount: 3, reached: true, timeouts: 1, lastResponding: "203.0.113.9" });
  });

  it("reports not-reached when the path dies short of the destination", async () => {
    const out = await traceroute.parseRow(row({ dst_addr: "203.0.113.9", result: hops.slice(0, 2) }));
    expect(out).toMatchObject({ ok: false, rttMs: null, error: "target not reached" });
    expect(out.detail).toMatchObject({ reached: false, lastResponding: "192.0.2.1", timeouts: 1 });
  });

  it("keeps timed-out hops in the path rather than collapsing them", async () => {
    const path = (await traceroute.parseRow(row({ dst_addr: "203.0.113.9", result: hops }))).detail.hops;
    expect(path).toEqual([
      { hop: 1, from: "192.0.2.1", rttMs: 1.234, timeout: false },
      { hop: 2, from: null, rttMs: null, timeout: true },
      { hop: 3, from: "203.0.113.9", rttMs: 9.5, timeout: false },
    ]);
  });
});

describe("dns.parseRow", () => {
  /** dns.google A, as captured in test/dns.test.ts. */
  const ABUF = "EjSBgAABAAIAAAAAA2RucwZnb29nbGUAAAEAAcAMAAEAAQAAAHsABAgIBATADAABAAEAAAB7AAQICAgI";

  it("decodes the single-resolver shape", async () => {
    const out = await dns.parseRow(row({ result: { abuf: ABUF, rt: 24.5 } }));
    expect(out).toMatchObject({ ok: true, rttMs: 24.5 });
    expect((out.detail.answers as Array<{ data: string }>).map((a) => a.data)).toEqual(["8.8.4.4", "8.8.8.8"]);
    expect(out.detail.resolvers).toBeUndefined();
  });

  it("keeps the per-resolver breakdown only when a probe used several", async () => {
    const out = await dns.parseRow(
      row({
        resultset: [
          { dst_addr: "192.0.2.53", result: { abuf: ABUF, rt: 5 } },
          { dst_addr: "192.0.2.54", error: "timeout" },
        ],
      }),
    );
    expect(out.ok).toBe(true);
    expect(out.rttMs).toBe(5);
    expect(out.detail.resolvers).toHaveLength(2);
  });

  it("is not ok when no resolver answered", async () => {
    const out = await dns.parseRow(row({ resultset: [{ dst_addr: "192.0.2.53", error: { reason: "timeout" } }] }));
    expect(out).toMatchObject({ ok: false, rttMs: null, error: "timeout" });
  });

  it("collects the distinct answers a node saw — the point of a DNS probe", async () => {
    const outcomes = [await dns.parseRow(row({ result: { abuf: ABUF, rt: 5 } })), await dns.parseRow(row({ result: { abuf: ABUF, rt: 7 } }))];
    expect(dns.summarize(outcomes)).toMatchObject({ distinctAnswers: ["A 8.8.4.4", "A 8.8.8.8"] });
  });
});

describe("http.parseRow", () => {
  it("reads status, version and sizes", async () => {
    const out = await http.parseRow(row({ result: [{ res: 200, rt: 394.2, ver: "1.1", hsize: 124, bsize: 96 }] }));
    expect(out).toMatchObject({ ok: true, rttMs: 394.2 });
    expect(out.detail).toMatchObject({ status: 200, httpVersion: "1.1", headerBytes: 124, bodyBytes: 96 });
  });

  it("treats 4xx/5xx as not ok, with the code in the error", async () => {
    expect(await http.parseRow(row({ result: [{ res: 503, rt: 12 }] }))).toMatchObject({ ok: false, error: "HTTP 503" });
  });

  it("reports a transport error from inside the result array", async () => {
    expect(await http.parseRow(row({ result: [{ err: "connect: timeout" }] }))).toMatchObject({
      ok: false,
      error: "connect: timeout",
    });
    expect(await http.parseRow(row({ result: [] }))).toMatchObject({ ok: false, error: "no response" });
  });
});

describe("ntp.parseRow", () => {
  it("averages the replies and keeps the clock offset", async () => {
    const out = await ntp.parseRow(
      row({ stratum: 2, version: 4, mode: "server", "root-delay": 0.01, result: [{ rtt: 10, offset: -1.5 }, { rtt: 20, offset: -2.5 }] }),
    );
    expect(out).toMatchObject({ ok: true, rttMs: 15 });
    expect(out.detail).toMatchObject({ stratum: 2, version: 4, mode: "server", offsetMs: -2 });
  });

  it("is not ok when nothing replied", async () => {
    expect(await ntp.parseRow(row({ stratum: 2, result: [{ x: "*" }] }))).toMatchObject({
      ok: false,
      rttMs: null,
      error: "no NTP reply",
    });
  });
});

describe("shared helpers", () => {
  it("rttStats ignores the probes that returned nothing", async () => {
    expect(rttStats([10, null, 20, null])).toEqual({ rttMs: { min: 10, avg: 15, max: 20 } });
    expect(rttStats([null, null])).toEqual({ rttMs: null });
  });

  it("stringifyError digs a message out of whatever Atlas sent", async () => {
    expect(stringifyError("plain")).toBe("plain");
    expect(stringifyError({ error: "a" })).toBe("a");
    expect(stringifyError({ reason: "b" })).toBe("b");
    expect(stringifyError({ nested: { deep: 1 } })).toBe('{"nested":{"deep":1}}');
    expect(stringifyError(undefined)).toBe("error");
  });
});

describe("buildDefinition", () => {
  it("asks each probe's own resolver unless one is pinned — that is what reveals GeoDNS", async () => {
    const auto = dns.buildDefinition(dns.validate({ target: "example.com" }, {} as never), "d");
    expect(auto).toMatchObject({ use_probe_resolver: true, query_argument: "example.com" });
    expect(auto.target).toBeUndefined();

    const pinned = dns.buildDefinition(dns.validate({ target: "example.com", resolver: "8.8.8.8" }, {} as never), "d");
    expect(pinned).toMatchObject({ target: "8.8.8.8" });
    expect(pinned.use_probe_resolver).toBeUndefined();
  });

  it("always creates one-off measurements", async () => {
    for (const kind of [ping, traceroute, ntp]) {
      const params = kind.validate({ target: "example.com" }, {} as never);
      expect(kind.buildDefinition(params as never, "desc")).toMatchObject({ is_oneoff: true, description: "desc" });
    }
  });
});

describe("buildDescription", () => {
  it("stays inside the 255 characters Atlas accepts", async () => {
    // Measured, not documented: 231 characters were accepted and 331 rejected.
    expect(buildDescription("dns", "example.com")).toBe("netatlas dns example.com");
    expect(buildDescription("ping", "a".repeat(400))).toHaveLength(DESCRIPTION_MAX);
    expect(DESCRIPTION_MAX).toBe(255);
  });
});

describe("sslcert.parseRow", () => {
  const cert = (pem: string, extra: Record<string, unknown> = {}) => row({ cert: [pem], rt: 30, ...extra });

  afterEach(() => vi.useRealTimers());
  const at = (iso: string) => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date(iso));
  };

  it("describes a certificate that is currently valid", async () => {
    at("2026-09-01T00:00:00Z");
    const out = await sslcert.parseRow(cert(real, { ver: "TLSv1.3", dst_addr: "203.0.113.7" }));
    expect(out).toMatchObject({ ok: true, rttMs: 30, error: undefined });
    expect(out.detail).toMatchObject({
      subjectCN: "example.com",
      issuerO: "SSL Corporation",
      notAfter: "2026-10-27T22:17:21Z",
      daysLeft: 56,
      chainLength: 1,
      tlsVersion: "TLSv1.3",
      dstAddr: "203.0.113.7",
    });
    expect(out.detail.fingerprint).toHaveLength(64);
  });

  it("calls the same certificate expired once its notAfter has passed", async () => {
    at("2027-01-01T00:00:00Z");
    const out = await sslcert.parseRow(cert(real));
    expect(out).toMatchObject({ ok: false, error: "certificate expired" });
    expect(out.detail.daysLeft).toBeLessThan(0);
  });

  it("reports TLS-level failures instead of pretending there is a certificate", async () => {
    // A bare RegExp as a toMatchObject value asserts nothing at all — it does
    // not fail on a mismatch — so the alert text is checked in full instead.
    expect(await sslcert.parseRow(row({ alert: { level: 2, description: 40 }, rt: 12 }))).toMatchObject({
      ok: false,
      rttMs: 12,
      error: 'TLS alert: {"level":2,"description":40}',
    });
    expect(await sslcert.parseRow(row({ err: "connection refused" }))).toMatchObject({
      ok: false,
      error: "connection refused",
    });
    expect(await sslcert.parseRow(row({ rt: 5 }))).toMatchObject({ ok: false, error: "no certificate" });
  });

  it("survives a certificate it cannot parse", async () => {
    const out = await sslcert.parseRow(cert("-----BEGIN CERTIFICATE-----\nMDAw\n-----END CERTIFICATE-----"));
    expect(out.ok).toBe(false);
    expect(out.error).toBeTruthy();
  });

  it("flags a target serving different certificates in different places", async () => {
    // The interesting signal for a multi-region TLS check: same hostname,
    // two fingerprints means someone is serving something else somewhere.
    at("2026-09-01T00:00:00Z");
    const outcomes = [await sslcert.parseRow(cert(real)), await sslcert.parseRow(cert(rsa))];
    expect(sslcert.summarize(outcomes)).toMatchObject({ distinctFingerprints: 2, fingerprint: null });
    expect(sslcert.summarize([outcomes[0]])).toMatchObject({ distinctFingerprints: 1 });
  });
});

describe("resolve_on_probe", () => {
  const KINDS_WITH_TARGET = { ping, traceroute, ntp, sslcert };

  it("makes every probe resolve a hostname itself", async () => {
    // Without it Atlas resolves the name once, centrally, and hands the same
    // address to every probe — so a multi-region run measures the path to one
    // IP from everywhere instead of what each region actually reaches.
    for (const [name, kind] of Object.entries(KINDS_WITH_TARGET)) {
      const params = kind.validate({ target: "qq.com" }, {} as never);
      expect(kind.buildDefinition(params as never, "d"), name).toMatchObject({ resolve_on_probe: true });
    }
    const httpDef = http.buildDefinition(
      http.validate({ target: "de-fra-as3320.anchors.atlas.ripe.net" }, {} as never),
      "d",
    );
    expect(httpDef).toMatchObject({ resolve_on_probe: true });
  });

  it("leaves it off when the target is already an address", async () => {
    for (const [name, kind] of Object.entries(KINDS_WITH_TARGET)) {
      for (const target of ["1.1.1.1", "2606:4700:4700::1111"]) {
        const params = kind.validate({ target }, {} as never);
        expect(kind.buildDefinition(params as never, "d"), `${name} ${target}`).not.toHaveProperty(
          "resolve_on_probe",
        );
      }
    }
  });

  it("is what dns has always done", () => {
    expect(dns.buildDefinition(dns.validate({ target: "qq.com" }, {} as never), "d")).toMatchObject({
      resolve_on_probe: true,
    });
  });
});

describe("dns query types", () => {
  it("carries the caller's record type into the Atlas definition", () => {
    for (const qt of ["A", "AAAA", "CNAME", "NS", "SOA", "TXT", "MX", "PTR", "SRV", "CAA"]) {
      const params = dns.validate({ target: "qq.com", queryType: qt }, {} as never);
      expect(dns.buildDefinition(params, "d"), qt).toMatchObject({ query_type: qt, query_class: "IN" });
    }
  });

  it("defaults to A, which is why the console needs a selector", () => {
    expect(dns.validate({ target: "qq.com" }, {} as never).queryType).toBe("A");
  });

  it("keeps the record type in the cross-node comparison", async () => {
    // A CNAME and an A in one answer are different facts; comparing bare
    // values across nodes would conflate them.
    const ABUF = "EjSBgAABAAIAAAAAA2RucwZnb29nbGUAAAEAAcAMAAEAAQAAAHsABAgIBATADAABAAEAAAB7AAQICAgI";
    const out = await dns.parseRow(row({ result: { abuf: ABUF, rt: 5 } }));
    expect(dns.summarize([out]).distinctAnswers).toEqual(["A 8.8.4.4", "A 8.8.8.8"]);
  });
});

describe("DNSSEC queries", () => {
  it("sets the DO bit and a bigger payload for signature-bearing types", () => {
    // Without DO the answer comes back unsigned and the resolver never sets
    // AD — the one thing a DNSSEC query is asked to find out. And a signed
    // answer does not fit in the default 512 bytes.
    for (const qt of ["DS", "DNSKEY", "RRSIG", "NSEC", "NSEC3", "TLSA"]) {
      const def = dns.buildDefinition(dns.validate({ target: "cloudflare.com", queryType: qt }, {} as never), "d");
      expect(def, qt).toMatchObject({ set_do_bit: true, udp_payload_size: 4096 });
    }
  });

  it("leaves ordinary queries alone", () => {
    for (const qt of ["A", "AAAA", "MX", "TXT", "HTTPS"]) {
      const def = dns.buildDefinition(dns.validate({ target: "cloudflare.com", queryType: qt }, {} as never), "d");
      expect(def, qt).not.toHaveProperty("set_do_bit");
    }
  });

  it("accepts every advertised record type", () => {
    for (const qt of SUPPORTED_QUERY_TYPES) {
      expect(dns.validate({ target: "cloudflare.com", queryType: qt }, {} as never).queryType).toBe(qt);
    }
  });

  it("reports the response code, so an empty answer is not just empty", async () => {
    const NXDOMAIN = "EjSBgwABAAAAAAAAAngAAAEAAQ==";
    const out = await dns.parseRow(row({ result: { abuf: NXDOMAIN, rt: 4 } }));
    expect(out).toMatchObject({ ok: false, error: "NXDOMAIN" });
    expect(out.detail.rcode).toBe("NXDOMAIN");
  });

  it("only claims DNSSEC validation when the query asked for it", async () => {
    const DS = "EjSBoAABAAIAAAABCmNsb3VkZmxhcmUDY29tAAArAAHADAArAAEAABoLACQJQw0CMploOabYCK/j60p5Wg5qejmnb8Uv8iiyK3b21jgm8rnADAAuAAEAABoLAFcAKw0CAAFRgGqXdTxqjipUoeYDY29tAMkdR1StPiQ/8HoaYctMN8MqLMQlvW0WuILcqHgX7sYrwuegk7YbU8TlL1aNKsQq7NN24JCaG2jMKiUn1hGrU/4AACkCAAAAgAAAAA==";
    // Read from the question the responder echoed back — the result row does
    // not carry the query type at all.
    const asked = await dns.parseRow(row({ result: { abuf: DS, rt: 9 } }));
    expect(asked.detail.authenticated).toBe(true);
    // AD is meaningless on a query that never carried DO; do not report it.
    const ABUF_A = "EjSBgAABAAIAAAAAA2RucwZnb29nbGUAAAEAAcAMAAEAAQAAAHsABAgIBATADAABAAEAAAB7AAQICAgI";
    const notAsked = await dns.parseRow(row({ result: { abuf: ABUF_A, rt: 9 } }));
    expect(notAsked.detail.authenticated).toBeNull();
  });
});
