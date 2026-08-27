import { HTTPException } from "hono/http-exception";
import { describe, expect, it } from "vitest";
import { assertPublicTarget } from "../src/measurements/kind";
import { kindFor } from "../src/measurements";
import { dns } from "../src/measurements/dnsKind";
import { http } from "../src/measurements/http";
import { ping } from "../src/measurements/ping";
import { sslcert } from "../src/measurements/sslcert";
import type { Env } from "../src/types";

const env = {} as Env;
const anyHttp = { ALLOW_ANY_HTTP_TARGET: "1" } as Env;

/** The thrown value carries the 400 that reaches the caller. */
const rejects = (fn: () => unknown, match?: RegExp) => {
  let thrown: unknown;
  try {
    fn();
  } catch (e) {
    thrown = e;
  }
  expect(thrown, "expected a rejection").toBeInstanceOf(HTTPException);
  expect((thrown as HTTPException).status).toBe(400);
  if (match) expect((thrown as HTTPException).message).toMatch(match);
};

describe("assertPublicTarget", () => {
  it("accepts public hostnames and addresses, normalised to lower case", () => {
    expect(assertPublicTarget("Example.COM")).toBe("example.com");
    expect(assertPublicTarget("  1.1.1.1 ")).toBe("1.1.1.1");
    expect(assertPublicTarget("2606:4700:4700::1111")).toBe("2606:4700:4700::1111");
    expect(assertPublicTarget("a.b.c.d.example.co.uk")).toBe("a.b.c.d.example.co.uk");
    expect(assertPublicTarget("xn--fiqs8s.example")).toBe("xn--fiqs8s.example");
  });

  // This is the list that stops a stranger aiming thousands of probes at
  // someone's LAN, so every range gets a case — including the boundaries,
  // where an off-by-one in the mask would show up.
  it.each([
    ["0.0.0.0", "unspecified"],
    ["10.0.0.0", "rfc1918 /8 first"],
    ["10.255.255.255", "rfc1918 /8 last"],
    ["100.64.0.1", "cgnat"],
    ["127.0.0.1", "loopback"],
    ["169.254.169.254", "link-local metadata"],
    ["172.16.0.1", "rfc1918 /12 first"],
    ["172.31.255.254", "rfc1918 /12 last"],
    ["192.0.0.1", "ietf protocol assignments"],
    ["192.0.2.5", "test-net-1"],
    ["192.168.1.1", "rfc1918 /16"],
    ["198.18.0.1", "benchmarking"],
    ["224.0.0.1", "multicast"],
    ["239.255.255.255", "multicast last"],
    ["240.0.0.1", "reserved"],
    ["255.255.255.255", "broadcast"],
  ])("rejects %s (%s)", (addr) => {
    rejects(() => assertPublicTarget(addr), /reserved address space/);
  });

  it("keeps the neighbours of those ranges usable", () => {
    for (const ok of ["9.255.255.255", "11.0.0.0", "172.15.255.255", "172.32.0.0", "192.167.255.255", "223.255.255.255"]) {
      expect(assertPublicTarget(ok)).toBe(ok);
    }
  });

  it.each(["::1", "::", "fc00::1", "fd12:3456::1", "fe80::1"])("rejects the IPv6 literal %s", (addr) => {
    rejects(() => assertPublicTarget(addr), /reserved address space/);
  });

  it("rejects URLs instead of quietly probing the host part", () => {
    rejects(() => assertPublicTarget("https://example.com/path"), /not a URL/);
    rejects(() => assertPublicTarget("user@example.com"), /not a URL/);
    rejects(() => assertPublicTarget("example.com/"), /not a URL/);
    rejects(() => assertPublicTarget("exa mple.com"), /not a URL/);
  });

  it("rejects names that resolve only inside someone's network", () => {
    for (const name of ["db.localhost", "printer.local", "api.internal"]) {
      rejects(() => assertPublicTarget(name), /not publicly resolvable/);
    }
    // Bare `localhost` never reaches that check — the hostname rule requires a
    // dot and turns it away first. Different message, same rejection.
    rejects(() => assertPublicTarget("localhost"), /not a valid hostname/);
  });

  it("rejects empty, oversized and malformed names", () => {
    rejects(() => assertPublicTarget("   "), /required/);
    rejects(() => assertPublicTarget(`${"a".repeat(250)}.com`), /too long/);
    rejects(() => assertPublicTarget("no-dot"), /not a valid hostname/);
    rejects(() => assertPublicTarget("-lead.example.com"), /not a valid hostname/);
    rejects(() => assertPublicTarget("trail-.example.com"), /not a valid hostname/);
  });
});

describe("per-type validation", () => {
  it("requires a target", () => {
    rejects(() => ping.validate({}, env), /'target' is required/);
  });

  it("clamps ping packet counts instead of trusting the caller", () => {
    expect(ping.validate({ target: "1.1.1.1", packets: 99 }, env).packets).toBe(6);
    expect(ping.validate({ target: "1.1.1.1", packets: 0 }, env).packets).toBe(1);
    expect(ping.validate({ target: "1.1.1.1", packets: "nonsense" }, env).packets).toBe(3);
  });

  it("defaults sslcert SNI to the target, but never to an IP literal", () => {
    // Without SNI a CDN hands back a fallback certificate that reads as long
    // expired — a completely wrong verdict about the site that was asked for.
    expect(sslcert.validate({ target: "example.com" }, env).hostname).toBe("example.com");
    expect(sslcert.validate({ target: "1.1.1.1" }, env).hostname).toBeUndefined();
    expect(sslcert.validate({ target: "2606:4700:4700::1111" }, env).hostname).toBeUndefined();
    expect(sslcert.validate({ target: "1.1.1.1", hostname: "one.one.one.one" }, env).hostname).toBe(
      "one.one.one.one",
    );
  });

  it("restricts sslcert to known TLS ports — this is not a port scanner", () => {
    expect(sslcert.validate({ target: "example.com", port: 8443 }, env).port).toBe(8443);
    rejects(() => sslcert.validate({ target: "example.com", port: 22 }, env), /not allowed/);
    rejects(() => sslcert.validate({ target: "example.com", port: 80 }, env), /not allowed/);
  });

  it("rejects a non-anchor http target here, not at Atlas", () => {
    rejects(() => http.validate({ target: "example.com" }, env), /only target RIPE Atlas anchors/);
    expect(http.validate({ target: "de-fra-as3320.anchors.atlas.ripe.net" }, env).target).toBe(
      "de-fra-as3320.anchors.atlas.ripe.net",
    );
  });

  it("opens http up only when the account has RIPE's exemption", () => {
    expect(http.validate({ target: "example.com" }, anyHttp).target).toBe("example.com");
    // Even then, the reserved-range rules still apply.
    rejects(() => http.validate({ target: "192.168.1.1" }, anyHttp), /reserved address space/);
  });

  it("rejects unsupported DNS query types", () => {
    expect(dns.validate({ target: "example.com", queryType: "aaaa" }, env).queryType).toBe("AAAA");
    // ANY is fine — Atlas accepts it. HTTPS is a real record type that Atlas
    // will not let you ask for, so it has to be turned away here.
    expect(dns.validate({ target: "example.com", queryType: "any" }, env).queryType).toBe("ANY");
    rejects(() => dns.validate({ target: "example.com", queryType: "HTTPS" }, env), /unsupported queryType/);
  });

  it("validates an explicit DNS resolver like any other target", () => {
    expect(dns.validate({ target: "example.com", resolver: "8.8.8.8" }, env).resolver).toBe("8.8.8.8");
    rejects(() => dns.validate({ target: "example.com", resolver: "192.168.0.1" }, env), /reserved/);
  });

  it("rejects unknown measurement types by name", () => {
    rejects(() => kindFor("nmap"), /unknown measurement type 'nmap'/);
    rejects(() => kindFor(undefined), /unknown measurement type/);
  });
});
