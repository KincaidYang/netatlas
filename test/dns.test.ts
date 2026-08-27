import { describe, expect, it } from "vitest";
import { parseDnsAnswers, parseDnsMessage } from "../src/dns";

/**
 * Every fixture below is a real DNS response captured off the wire from
 * 8.8.8.8 and frozen here, so the parser is exercised against genuine
 * name-compression pointers rather than something we encoded ourselves.
 * The expected records were cross-checked against `dig` at capture time.
 */
const WIRE = {
  /** dns.google A — two answers, both using a pointer back to the question. */
  a: "EjSBgAABAAIAAAAAA2RucwZnb29nbGUAAAEAAcAMAAEAAQAAAHsABAgIBATADAABAAEAAAB7AAQICAgI",
  /** example.com AAAA. */
  aaaa: "EjSBgAABAAIAAAAAB2V4YW1wbGUDY29tAAAcAAHADAAcAAEAAAEsABAmBkcAABAAAAAAAACsQpPzwAwAHAABAAABLAAQJgZHAAAQAAAAAAAAaBQXmg==",
  /** www.ripe.net A — a two-hop CNAME chain into Akamai; names point at names. */
  chain: "EjSBgAABAAQAAAAAA3d3dwRyaXBlA25ldAAAAQABwAwABQABAAAANwAXA3d3dwRyaXBlA25ldAdlZGdla2V5wBXAKgAFAAEAAFEHABoHZTMzNzA2NgRkc2NiCmFrYW1haWVkZ2XAFcBNAAEAAQAAABQABBc2diPATQABAAEAAAAUAAQXNnYm",
  /** google.com MX — preference plus a compressed exchange name. */
  mx: "EjSBgAABAAEAAAAABmdvb2dsZQNjb20AAA8AAcAMAA8AAQAAADwACQAKBHNtdHDADA==",
  /** _sip._udp.sip.voice.google.com SRV. */
  srv: "EjSBgAABAAIAAAAABF9zaXAEX3VkcANzaXAFdm9pY2UGZ29vZ2xlA2NvbQAAIQABwAwAIQABAAABLAAmABQAARPEDXNpcC1hbnljYXN0LTIFdm9pY2UGZ29vZ2xlA2NvbQDADAAhAAEAAAEsACYACgABE8QNc2lwLWFueWNhc3QtMQV2b2ljZQZnb29nbGUDY29tAA==",
  /** ripe.net SOA — two names followed by five 32-bit counters. */
  soa: "EjSBgAABAAEAAAAABHJpcGUDbmV0AAAGAAHADAAGAAEAAA4QACoFbWFudXMHYXV0aGRuc8AMA2Ruc8AMapA+IwAADhAAAAJYAA0vAAAADhA=",
  /** google.com CAA. */
  caa: "EjSBgAABAAEAAAAABmdvb2dsZQNjb20AAQEAAcAMAQEAAQAAQ4EADwAFaXNzdWVwa2kuZ29vZw==",
  /** 8.8.8.8.in-addr.arpa PTR. */
  ptr: "EjSBgAABAAEAAAAAATgBOAE4ATgHaW4tYWRkcgRhcnBhAAAMAAHADAAMAAEAAEF5AAwDZG5zBmdvb2dsZQA=",
  /** ripe.net NS — five answers, each pointing into a different earlier name. */
  ns: "EjSBgAABAAUAAAAABHJpcGUDbmV0AAACAAHADAACAAEAAE7AAA0FcmlybnMEYXJpbsARwAwAAgABAABOwAANA25zMwZsYWNuaWPAEcAMAAIAAQAATsAADANuczQFYXBuaWPAEcAMAAIAAQAATsAAEAVtYW51cwdhdXRoZG5zwAzADAACAAEAAE7AAA4DbnMzB2FmcmluaWPAEQ==",
  /** _dmarc.ripe.net TXT — a single character-string. */
  txt: "EjSBgAABAAEAAAAABl9kbWFyYwRyaXBlA25ldAAAEAABwAwAEAABAAAOEAA7OnY9RE1BUkMxO3A9bm9uZTtydWE9bWFpbHRvOnQ5Z2VwZmllQGFnLmV1LmRtYXJjYWR2aXNvci5jb20=",
  /** A DKIM key over TCP: too long for one character-string, so DER splits it at 255. */
  txtSplit: "EjSBgAABAAEAAAAAAnMxCWRvbWFpbmtleQh1MjMyNTQyNAV3bDE3NQhzZW5kZ3JpZANuZXQAABAAAcAMABAAAQAABwgBmP9rPXJzYTsgdD1zOyBwPU1JSUJJakFOQmdrcWhraUc5dzBCQVFFRkFBT0NBUThBTUlJQkNnS0NBUUVBeGJnclo4TkkrcjF6L1M0UkhVV2RNbXdtTitKR0VZOUJsY2QxY3Fob2N5S3ErNHF6VTVURFhYNGdLSVoyQXBxM3RUZEEvYTVoTkVFNGJQeWhKQUhGQTAveDdYaGcvL0Y0K2lMd0FCNzY2UUoxMFlqdjduUUlxdnpNbU1wTGN0cjVGamduY2xHdlBVZ293M29mVXBubXh5cjFzOWZSMkpkdnJSelh0d3Z1dmJEVjhqOThpdUlHWWdjVGNtUXdKSEgzSGNHdXiXWU9jNTdZWkJOUFVRYmQ1ZmNSNWhjcGJpK3JXZVQvU2xOQ0NMTkxQNGdtWFZnN2xQYzM3WW8zQ0c1Z3BBc1RBZi80Ukl4YjIyYUwyeFc1OTZoL0hpMUVlYmVrcHFGMWRXb2dSczd4MkpLMUpZUWFWSUpFWU5TdXY1bnFMUjZGQTFTVW1CMTM3NUpMNHBUWFM2UUlEQVFBQg==",
  /** cloudflare.com HTTPS (type 65) — a type the parser has no case for. */
  https: "EjSBgAABAAEAAAAACmNsb3VkZmxhcmUDY29tAABBAAHADABBAAEAAAEsAD0AAQAAAQAGAmgzAmgyAAQACGgQhOVoEIXlAAYAICYGRwAAAAAAAAAAAGgQhOUmBkcAAAAAAAAAAABoEIXl",
  /** A truncated (TC=1) reply: the header says one question, zero answers. */
  empty: "EjSDgAABAAAAAAAAAnMxCl9kb21haW5rZXkGcGF5cGFsA2NvbQAAEAAB",
};

const data = (abuf: string) => parseDnsAnswers(abuf).map((r) => r.data);

describe("parseDnsAnswers", () => {
  it("decodes A records and follows the pointer back to the question name", () => {
    expect(parseDnsAnswers(WIRE.a)).toEqual([
      { name: "dns.google", type: "A", ttl: 123, data: "8.8.4.4" },
      { name: "dns.google", type: "A", ttl: 123, data: "8.8.8.8" },
    ]);
  });

  it("decodes AAAA in uncompressed hextet form", () => {
    // Not the shortest RFC 5952 form — good enough to display and compare,
    // which is all the console does with it.
    expect(data(WIRE.aaaa)).toEqual([
      "2606:4700:10:0:0:0:ac42:93f3",
      "2606:4700:10:0:0:0:6814:179a",
    ]);
  });

  it("walks a CNAME chain whose names are themselves compressed", () => {
    expect(parseDnsAnswers(WIRE.chain).map((r) => [r.name, r.type, r.data])).toEqual([
      ["www.ripe.net", "CNAME", "www.ripe.net.edgekey.net"],
      ["www.ripe.net.edgekey.net", "CNAME", "e337066.dscb.akamaiedge.net"],
      ["e337066.dscb.akamaiedge.net", "A", "23.54.118.35"],
      ["e337066.dscb.akamaiedge.net", "A", "23.54.118.38"],
    ]);
  });

  it("decodes MX, SRV, SOA, CAA, PTR and NS", () => {
    expect(data(WIRE.mx)).toEqual(["10 smtp.google.com"]);
    expect(data(WIRE.srv)).toEqual([
      "20 1 5060 sip-anycast-2.voice.google.com",
      "10 1 5060 sip-anycast-1.voice.google.com",
    ]);
    expect(data(WIRE.soa)).toEqual(["manus.authdns.ripe.net dns.ripe.net 1787837987 3600 600 864000 3600"]);
    expect(data(WIRE.caa)).toEqual(['0 issue "pki.goog"']);
    expect(data(WIRE.ptr)).toEqual(["dns.google"]);
    expect(data(WIRE.ns)).toEqual([
      "rirns.arin.net",
      "ns3.lacnic.net",
      "ns4.apnic.net",
      "manus.authdns.ripe.net",
      "ns3.afrinic.net",
    ]);
  });

  it("joins the character-strings of a TXT record", () => {
    expect(data(WIRE.txt)).toEqual(["v=DMARC1;p=none;rua=mailto:t9gepfie@ag.eu.dmarcadvisor.com"]);

    const [dkim] = data(WIRE.txtSplit);
    expect(dkim.startsWith("k=rsa; t=s; p=MIIBIjANBgkq")).toBe(true);
    // The 255-byte split is an encoding artefact, not part of the value.
    expect(dkim).toContain("HcGux YOc57YZBNPUQ");
    expect(dkim.endsWith("QIDAQAB")).toBe(true);
  });

  it("decodes SVCB / HTTPS parameters", () => {
    // Byte-for-byte what `dig HTTPS cloudflare.com` prints, except that our
    // IPv6 stays uncompressed — the same form our AAAA records use.
    expect(data(WIRE.https)).toEqual([
      '1 . alpn="h3,h2" ipv4hint=104.16.132.229,104.16.133.229 ' +
        "ipv6hint=2606:4700:0:0:0:0:6810:84e5,2606:4700:0:0:0:0:6810:85e5",
    ]);
    expect(parseDnsAnswers(WIRE.https)[0].type).toBe("HTTPS");
  });

  it("falls back to hex for record types it does not model", () => {
    // Type 40 (SINK) has no decoder and never will; the bytes are still shown.
    const bytes = new Uint8Array([
      0x12, 0x34, 0x81, 0x80, 0, 1, 0, 1, 0, 0, 0, 0, // header: 1 question, 1 answer
      1, 0x78, 0, // question name "x."
      0, 40, 0, 1, //   type 40, class IN
      0xc0, 0x0c, // answer name → pointer to the question
      0, 40, 0, 1, 0, 0, 0, 60, // type 40, class IN, ttl 60
      0, 3, 0xaa, 0xbb, 0xcc, // rdlength 3
    ]);
    const [rec] = parseDnsAnswers(btoa(String.fromCharCode(...bytes)));
    expect(rec).toEqual({ name: "x", type: "40", ttl: 60, data: "aabbcc" });
  });

  it("returns nothing for a reply with no answer section", () => {
    expect(parseDnsAnswers(WIRE.empty)).toEqual([]);
  });

  it("returns nothing rather than throwing on junk", () => {
    expect(parseDnsAnswers("")).toEqual([]);
    expect(parseDnsAnswers("AAAA")).toEqual([]); // shorter than a DNS header
  });

  it("does not hang on a compression pointer that loops", () => {
    // A malicious or corrupt response can point a name at itself. The parser
    // must give up, not spin: this runs inside a Worker request.
    const bytes = new Uint8Array(20);
    const dv = new DataView(bytes.buffer);
    dv.setUint16(4, 1); // qdcount
    dv.setUint16(6, 1); // ancount
    bytes[12] = 0xc0; // pointer …
    bytes[13] = 0x0c; // … to itself
    const b64 = btoa(String.fromCharCode(...bytes));
    expect(() => parseDnsAnswers(b64)).not.toThrow();
  });
});

/**
 * DNSSEC responses, captured over TCP with the DO bit set. Every expectation
 * below is what `dig +dnssec` printed for the same query at capture time.
 */
const DNSSEC = {
  /** cloudflare.com DS — the delegation digest held by the .com zone. */
  ds: "EjSBoAABAAIAAAABCmNsb3VkZmxhcmUDY29tAAArAAHADAArAAEAABoLACQJQw0CMploOabYCK/j60p5Wg5qejmnb8Uv8iiyK3b21jgm8rnADAAuAAEAABoLAFcAKw0CAAFRgGqXdTxqjipUoeYDY29tAMkdR1StPiQ/8HoaYctMN8MqLMQlvW0WuILcqHgX7sYrwuegk7YbU8TlL1aNKsQq7NN24JCaG2jMKiUn1hGrU/4AACkCAAAAgAAAAA==",
  /** cloudflare.com DNSKEY — a ZSK, a KSK, and the signature over both. */
  dnskey: "EjSBoAABAAMAAAABCmNsb3VkZmxhcmUDY29tAAAwAAHADAAwAAEAAAJhAEQBAAMNoJMRESz5E4gYzS/q6XDrvU1qMPYIjCWzJaOau8XNEZeqCYKD5ar0IRd8KqXXFJkqmVfRvMGPmM1x8fGAa2XhSMAMADAAAQAAAmEARAEBAw2Z2yzBTKvcM9bXfaY6LxX3ERJYTyNOjR3EKOOeikqX4aonGlVdyQcB4X4qTEtvEgt8MtRPSsAr2JTPLUvnd4oZwAwALgABAAACYQBiADANAgAADhBq3t1Jao5xyQlDCmNsb3VkZmxhcmUDY29tAFLQXQUxlQ3Seov0QesVvFBX/VbfqEQvYfMVK2xNBR8u8ihirsTr9ZsP7PSoWtj4X8qo9iG7JBcT6D5af7EJSd4AACkCAAAAgAAAAA==",
  /** cloudflare.com NSEC — Cloudflare's "black lies": the next name is one zero byte. */
  nsec: "EjSBoAABAAIAAAABCmNsb3VkZmxhcmUDY29tAAAvAAHADAAvAAEAAAEsACABAApjbG91ZGZsYXJlA2NvbQAACWINgAxUC40cwAEBwMAMAC4AAQAAASwAYgAvDQIAAAEsapHCHmqPAv6GyQpjbG91ZGZsYXJlA2NvbQABqZqce4BwnobSdGgeEi/fzQQXgJ5yIcDbySbL0NQwgqoZv0TIsw42+7NGCaiEHO1aOhFuRQLn8eIuvA1mmYbOAAApAgAAAIAAAAA=",
  /** _25._tcp.mail.ietf.org TLSA — a real DANE record. */
  tlsa: "EjSBoAABAAIAAAABA18yNQRfdGNwBG1haWwEaWV0ZgNvcmcAADQAAcAMADQAAQAAASwAIwMBATiogSahWujmQ86UR8POmodOoOBSVdB+4SIngJ7b5cfxwAwALgABAAABLABcADQNBQAAASxqkcIeao8C/obJBGlldGYDb3JnAKr00R7E3jx18syBL2OkWdRTry+GL4Yw7MO/8nlu2KvYLY+QI9hnOG+Up0wNLfQCNnzRdEBM8OH72hUKmip1BL0AACkCAAAAgAAAAA==",
};

describe("DNSSEC records", () => {
  it("decodes DS: key tag, algorithm, digest type, digest", () => {
    expect(data(DNSSEC.ds)[0]).toBe(
      "2371 13 2 32996839A6D808AFE3EB4A795A0E6A7A39A76FC52FF228B22B76F6D63826F2B9",
    );
  });

  it("decodes DNSKEY: flags, protocol, algorithm, key", () => {
    const [zsk, ksk] = data(DNSSEC.dnskey);
    expect(zsk).toBe(
      "256 3 13 oJMRESz5E4gYzS/q6XDrvU1qMPYIjCWzJaOau8XNEZeqCYKD5ar0IRd8KqXXFJkqmVfRvMGPmM1x8fGAa2XhSA==",
    );
    // 257 is the key-signing key — the one the parent's DS points at.
    expect(ksk.startsWith("257 3 13 mdsswUyr3DPW132mOi8V9xESWE8jTo0dxCjjnopKl+")).toBe(true);
  });

  it("decodes RRSIG, including the timestamps in dig's format", () => {
    const rrsig = parseDnsAnswers(DNSSEC.ds).find((r) => r.type === "RRSIG")!;
    expect(rrsig.data.startsWith("DS 13 2 86400 20260902010044 20260825235044 41446 com. ")).toBe(true);
  });

  it("decodes NSEC, escaping a label that is not printable", () => {
    // Cloudflare answers "no such name" with a next-name of one zero byte.
    // A raw NUL has no business reaching the page, so it is escaped as dig
    // escapes it.
    expect(data(DNSSEC.nsec)[0]).toBe(
      "\\000.cloudflare.com. A NS SOA PTR HINFO MX TXT AAAA LOC SRV NAPTR CERT SSHFP " +
        "RRSIG NSEC DNSKEY TLSA SMIMEA HIP CDS CDNSKEY OPENPGPKEY SVCB HTTPS URI CAA",
    );
  });

  it("decodes TLSA", () => {
    expect(data(DNSSEC.tlsa)[0]).toBe(
      "3 1 1 38A88126A15AE8E643CE9447C3CE9A874EA0E05255D07EE12227809EDBE5C7F1",
    );
  });
});

describe("parseDnsMessage", () => {
  it("reads the header, so 'no records' can be told apart from a failure", () => {
    // NXDOMAIN, SERVFAIL and an empty NOERROR all present as zero answers.
    expect(parseDnsMessage(DNSSEC.ds)).toMatchObject({ rcode: "NOERROR", truncated: false });
    expect(parseDnsMessage(WIRE.empty)).toMatchObject({ rcode: "NOERROR", truncated: true });
  });

  it("reports AD when the resolver validated the answer", () => {
    for (const abuf of Object.values(DNSSEC)) {
      expect(parseDnsMessage(abuf).authenticated).toBe(true);
    }
    // Captured without the DO bit, so the resolver never set AD.
    expect(parseDnsMessage(WIRE.a).authenticated).toBe(false);
  });
});
