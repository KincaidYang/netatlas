/**
 * Minimal DNS response parser. RIPE Atlas returns the raw DNS answer as a
 * base64 `abuf`; there is no pre-parsed record list. We decode just enough of
 * the wire format (including name-compression pointers) to extract the answer
 * section. Dependency-free so it runs on Workers without nodejs_compat.
 */

export interface DnsRecord {
  name: string;
  type: string;
  ttl: number;
  data: string;
}

export interface DnsMessage {
  /** The record type the question asked for, echoed back by the responder. */
  questionType: string;
  /** Textual response code: NOERROR, NXDOMAIN, SERVFAIL … */
  rcode: string;
  /** The resolver set AD — it validated the answer with DNSSEC. Only ever
   *  set when the query carried the DO bit, so it is null otherwise. */
  authenticated: boolean;
  /** TC — the answer did not fit and was cut short. */
  truncated: boolean;
  answers: DnsRecord[];
}

const RCODES: Record<number, string> = {
  0: "NOERROR", 1: "FORMERR", 2: "SERVFAIL", 3: "NXDOMAIN", 4: "NOTIMP",
  5: "REFUSED", 6: "YXDOMAIN", 7: "YXRRSET", 8: "NXRRSET", 9: "NOTAUTH", 10: "NOTZONE",
};

/** Answers only; see parseDnsMessage for the header alongside them. */
export const parseDnsAnswers = (abufBase64: string): DnsRecord[] => parseDnsMessage(abufBase64).answers;

/**
 * Decode a DNS response far enough to describe it.
 *
 * The header matters as much as the answer section: NXDOMAIN, SERVFAIL and
 * "no records" all look like an empty answer list, and on a probing platform
 * telling them apart is most of the point — a SERVFAIL in one country and
 * NOERROR everywhere else is exactly the kind of thing worth seeing.
 */
export function parseDnsMessage(abufBase64: string): DnsMessage {
  const empty: DnsMessage = { questionType: "", rcode: "", authenticated: false, truncated: false, answers: [] };
  const bytes = base64ToBytes(abufBase64);
  if (bytes.length < 12) return empty;
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const flagsLo = bytes[3];
  const header = {
    rcode: RCODES[flagsLo & 0x0f] ?? String(flagsLo & 0x0f),
    authenticated: ((flagsLo >> 5) & 1) === 1,
    truncated: ((bytes[2] >> 1) & 1) === 1,
  };

  const qdcount = dv.getUint16(4);
  const ancount = dv.getUint16(6);

  let pos = 12;
  let questionType = "";
  for (let i = 0; i < qdcount; i++) {
    const afterName = skipName(bytes, pos);
    // The response echoes the question, which is the only place a result row
    // records what was actually asked — Atlas does not repeat it per row.
    if (i === 0 && afterName + 2 <= bytes.length) questionType = typeName(dv.getUint16(afterName));
    pos = afterName + 4; // QTYPE (2) + QCLASS (2)
  }

  const records: DnsRecord[] = [];
  for (let i = 0; i < ancount && pos + 10 <= bytes.length; i++) {
    const [name, after] = readName(bytes, pos);
    pos = after;
    const type = dv.getUint16(pos);
    const ttl = dv.getUint32(pos + 4);
    const rdlength = dv.getUint16(pos + 8);
    const rdStart = pos + 10;
    records.push({ name, type: typeName(type), ttl, data: readRData(bytes, dv, type, rdStart, rdlength) });
    pos = rdStart + rdlength;
  }
  return { ...header, questionType, answers: records };
}

/** Read a (possibly compressed) DNS name. Returns [name, positionAfterName]. */
function readName(bytes: Uint8Array, offset: number): [string, number] {
  const labels: string[] = [];
  let pos = offset;
  let next = -1;
  let guard = 0;
  while (guard++ < 128) {
    const len = bytes[pos];
    if (len === undefined) break;
    if (len === 0) {
      pos += 1;
      if (next === -1) next = pos;
      break;
    }
    if ((len & 0xc0) === 0xc0) {
      const pointer = ((len & 0x3f) << 8) | bytes[pos + 1];
      if (next === -1) next = pos + 2;
      pos = pointer;
      continue;
    }
    labels.push(escapeLabel(asciiSlice(bytes, pos + 1, len)));
    pos += 1 + len;
  }
  return [labels.join("."), next === -1 ? pos : next];
}

/**
 * Presentation form, as dig writes it: a dot or backslash inside a label is
 * escaped, anything unprintable becomes \DDD. Cloudflare's NSEC "black lies"
 * really do return a label that is one zero byte, and a raw NUL has no place
 * in text we are going to render.
 */
const escapeLabel = (label: string): string =>
  label.replace(/[\\.]|[^\x21-\x7e]/g, (c) =>
    c === "." || c === "\\" ? `\\${c}` : `\\${c.charCodeAt(0).toString(10).padStart(3, "0")}`,
  );

function skipName(bytes: Uint8Array, offset: number): number {
  return readName(bytes, offset)[1];
}

function readRData(bytes: Uint8Array, dv: DataView, type: number, start: number, len: number): string {
  switch (type) {
    case 1: // A
      return len >= 4 ? `${bytes[start]}.${bytes[start + 1]}.${bytes[start + 2]}.${bytes[start + 3]}` : "";
    case 28: // AAAA
      return readIPv6(bytes, start, len);
    case 2: // NS
    case 5: // CNAME
    case 12: // PTR
      return readName(bytes, start)[0];
    case 15: { // MX: preference + exchange
      const pref = dv.getUint16(start);
      const [exchange] = readName(bytes, start + 2);
      return `${pref} ${exchange}`;
    }
    case 6: { // SOA: mname rname serial refresh retry expire minimum
      const [mname, p1] = readName(bytes, start);
      const [rname, p2] = readName(bytes, p1);
      const nums = [0, 4, 8, 12, 16].map((o) => dv.getUint32(p2 + o));
      return `${mname} ${rname} ${nums.join(" ")}`;
    }
    case 33: { // SRV: priority weight port target
      const priority = dv.getUint16(start);
      const weight = dv.getUint16(start + 2);
      const port = dv.getUint16(start + 4);
      const [target] = readName(bytes, start + 6);
      return `${priority} ${weight} ${port} ${target}`;
    }
    case 257: { // CAA: flags tag "value"
      const flags = bytes[start];
      const tagLen = bytes[start + 1];
      const tag = asciiSlice(bytes, start + 2, tagLen);
      const value = asciiSlice(bytes, start + 2 + tagLen, len - 2 - tagLen);
      return `${flags} ${tag} "${value}"`;
    }
    case 13: // HINFO: cpu, os — also what RFC 8482 answers an ANY query with
      return charStrings(bytes, start, len).map((v) => `"${v}"`).join(" ");
    case 35: { // NAPTR: order, preference, flags, service, regexp, replacement
      if (len < 4) return toHex(bytes, start, len);
      const order = dv.getUint16(start);
      const preference = dv.getUint16(start + 2);
      const [flags, service, regexp] = charStrings(bytes, start + 4, len - 4, 3);
      let p = start + 4;
      for (const v of [flags, service, regexp]) p += 1 + v.length;
      const [replacement] = readName(bytes, p);
      return `${order} ${preference} "${flags}" "${service}" "${regexp}" ${replacement || "."}.`;
    }
    case 43: // DS: key tag, algorithm, digest type, digest
    case 59: // CDS, same shape
      return len >= 4
        ? `${dv.getUint16(start)} ${bytes[start + 2]} ${bytes[start + 3]} ${toHex(bytes, start + 4, len - 4).toUpperCase()}`
        : "";
    case 48: // DNSKEY: flags, protocol, algorithm, public key
    case 60: // CDNSKEY, same shape
      return len >= 4
        ? `${dv.getUint16(start)} ${bytes[start + 2]} ${bytes[start + 3]} ${b64(bytes, start + 4, len - 4)}`
        : "";
    case 46: // RRSIG
      return readRrsig(bytes, dv, start, len);
    case 47: { // NSEC: next name + the types that exist at this name
      const [next, after] = readName(bytes, start);
      return `${next}. ${typeBitmap(bytes, after, start + len).join(" ")}`.trim();
    }
    case 50: // NSEC3
      return readNsec3(bytes, dv, start, len);
    case 52: // TLSA: usage, selector, matching type, certificate association
      return len >= 3
        ? `${bytes[start]} ${bytes[start + 1]} ${bytes[start + 2]} ${toHex(bytes, start + 3, len - 3).toUpperCase()}`
        : "";
    case 64: // SVCB
    case 65: // HTTPS
      return readSvcb(bytes, dv, start, len);
    case 16: // TXT (one or more length-prefixed strings)
      return charStrings(bytes, start, len).join(" ");
    default:
      return toHex(bytes, start, len);
  }
}

/** RFC 4034 §3.2. Timestamps are seconds since the epoch, shown as dig shows them. */
function readRrsig(bytes: Uint8Array, dv: DataView, start: number, len: number): string {
  if (len < 18) return toHex(bytes, start, len);
  const covered = typeName(dv.getUint16(start));
  const [signer, after] = readName(bytes, start + 18);
  return [
    covered,
    bytes[start + 2], // algorithm
    bytes[start + 3], // labels
    dv.getUint32(start + 4), // original TTL
    sigTime(dv.getUint32(start + 8)), // expiration
    sigTime(dv.getUint32(start + 12)), // inception
    dv.getUint16(start + 16), // key tag
    `${signer}.`,
    b64(bytes, after, start + len - after),
  ].join(" ");
}

const sigTime = (epoch: number): string => new Date(epoch * 1000).toISOString().replace(/[-:TZ.]/g, "").slice(0, 14);

/** RFC 5155 §3.2. The next hashed owner is base32hex, not base64. */
function readNsec3(bytes: Uint8Array, dv: DataView, start: number, len: number): string {
  if (len < 5) return toHex(bytes, start, len);
  const saltLen = bytes[start + 4];
  const hashStart = start + 5 + saltLen;
  const hashLen = bytes[hashStart];
  const typesAt = hashStart + 1 + hashLen;
  return [
    bytes[start], // hash algorithm
    bytes[start + 1], // flags
    dv.getUint16(start + 2), // iterations
    saltLen ? toHex(bytes, start + 5, saltLen).toUpperCase() : "-",
    base32hex(bytes, hashStart + 1, hashLen),
    ...typeBitmap(bytes, typesAt, start + len),
  ].join(" ");
}

/**
 * RFC 4034 §4.1.2 type bit maps: a series of (window, length, bitmap) blocks,
 * each bit standing for one record type. Used by both NSEC and NSEC3.
 */
function typeBitmap(bytes: Uint8Array, start: number, end: number): string[] {
  const types: string[] = [];
  let pos = start;
  while (pos + 2 <= end) {
    const window = bytes[pos];
    const blockLen = bytes[pos + 1];
    pos += 2;
    for (let i = 0; i < blockLen && pos + i < end; i++) {
      for (let bit = 0; bit < 8; bit++) {
        if (bytes[pos + i] & (0x80 >> bit)) types.push(typeName(window * 256 + i * 8 + bit));
      }
    }
    pos += blockLen;
  }
  return types;
}

const B32HEX = "0123456789ABCDEFGHIJKLMNOPQRSTUV";

function base32hex(bytes: Uint8Array, start: number, len: number): string {
  let out = "";
  let acc = 0;
  let bits = 0;
  for (let i = 0; i < len; i++) {
    acc = (acc << 8) | bytes[start + i];
    bits += 8;
    while (bits >= 5) {
      out += B32HEX[(acc >> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += B32HEX[(acc << (5 - bits)) & 31];
  return out;
}

const b64 = (bytes: Uint8Array, start: number, len: number): string =>
  len > 0 ? btoa(asciiSlice(bytes, start, len)) : "";

/** RFC 9460 SvcParamKeys, by number. */
const SVC_KEYS: Record<number, string> = {
  0: "mandatory", 1: "alpn", 2: "no-default-alpn", 3: "port",
  4: "ipv4hint", 5: "ech", 6: "ipv6hint", 7: "dohpath",
};

/**
 * SVCB / HTTPS (RFC 9460): priority, target name, then length-prefixed
 * parameters. Worth decoding rather than dumping hex — this is where a modern
 * site says whether it offers HTTP/3 and Encrypted Client Hello, and the
 * address hints are a second opinion on what DNS is steering towards.
 */
function readSvcb(bytes: Uint8Array, dv: DataView, start: number, len: number): string {
  const end = start + len;
  if (len < 3) return toHex(bytes, start, len);
  const priority = dv.getUint16(start);
  const [target, afterName] = readName(bytes, start + 2);
  const parts = [String(priority), target || "."];
  let pos = afterName;
  while (pos + 4 <= end) {
    const key = dv.getUint16(pos);
    const vlen = dv.getUint16(pos + 2);
    const value = pos + 4;
    parts.push(svcParam(bytes, dv, key, value, Math.max(0, Math.min(vlen, end - value))));
    pos = value + vlen;
  }
  return parts.join(" ");
}

function svcParam(bytes: Uint8Array, dv: DataView, key: number, start: number, len: number): string {
  switch (key) {
    case 0: { // mandatory: a list of keys that must be understood
      const keys: string[] = [];
      for (let i = 0; i + 2 <= len; i += 2) {
        const k = dv.getUint16(start + i);
        keys.push(SVC_KEYS[k] ?? `key${k}`);
      }
      return `mandatory=${keys.join(",")}`;
    }
    case 1: { // alpn: length-prefixed protocol ids
      const ids: string[] = [];
      let p = start;
      while (p < start + len) {
        const l = bytes[p];
        ids.push(asciiSlice(bytes, p + 1, l));
        p += 1 + l;
      }
      return `alpn="${ids.join(",")}"`;
    }
    case 2:
      return "no-default-alpn";
    case 3:
      return `port=${dv.getUint16(start)}`;
    case 4: { // ipv4hint
      const out: string[] = [];
      for (let i = 0; i + 4 <= len; i += 4) {
        out.push(`${bytes[start + i]}.${bytes[start + i + 1]}.${bytes[start + i + 2]}.${bytes[start + i + 3]}`);
      }
      return `ipv4hint=${out.join(",")}`;
    }
    case 5: // ech: an opaque config list, shown the way it is published
      return `ech=${btoa(asciiSlice(bytes, start, len))}`;
    case 6: { // ipv6hint
      const out: string[] = [];
      for (let i = 0; i + 16 <= len; i += 16) out.push(readIPv6(bytes, start + i, 16));
      return `ipv6hint=${out.join(",")}`;
    }
    case 7:
      return `dohpath=${asciiSlice(bytes, start, len)}`;
    default: {
      const name = SVC_KEYS[key] ?? `key${key}`;
      return len ? `${name}=${toHex(bytes, start, len)}` : name;
    }
  }
}

/** A run of length-prefixed strings, as TXT, HINFO and NAPTR all use. */
function charStrings(bytes: Uint8Array, start: number, len: number, max = Infinity): string[] {
  const out: string[] = [];
  let pos = start;
  const end = start + len;
  while (pos < end && out.length < max) {
    const l = bytes[pos];
    out.push(asciiSlice(bytes, pos + 1, l));
    pos += 1 + l;
  }
  while (out.length < Math.min(max, 3) && max !== Infinity) out.push("");
  return out;
}

function readIPv6(bytes: Uint8Array, start: number, len: number): string {
  if (len < 16) return "";
  const parts: string[] = [];
  for (let i = 0; i < 16; i += 2) {
    parts.push(((bytes[start + i] << 8) | bytes[start + i + 1]).toString(16));
  }
  return parts.join(":"); // uncompressed form; fine for comparison/display
}

function asciiSlice(bytes: Uint8Array, start: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += String.fromCharCode(bytes[start + i]);
  return s;
}

function toHex(bytes: Uint8Array, start: number, len: number): string {
  let s = "";
  for (let i = 0; i < len; i++) s += bytes[start + i].toString(16).padStart(2, "0");
  return s;
}

function typeName(t: number): string {
  const names: Record<number, string> = {
    1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 12: "PTR", 15: "MX", 16: "TXT", 28: "AAAA", 33: "SRV",
    13: "HINFO", 29: "LOC", 35: "NAPTR", 37: "CERT", 39: "DNAME",
    43: "DS", 44: "SSHFP", 45: "IPSECKEY", 46: "RRSIG", 47: "NSEC", 48: "DNSKEY",
    50: "NSEC3", 51: "NSEC3PARAM", 52: "TLSA", 53: "SMIMEA", 55: "HIP", 59: "CDS", 60: "CDNSKEY",
    61: "OPENPGPKEY", 64: "SVCB", 65: "HTTPS", 99: "SPF", 255: "ANY", 256: "URI", 257: "CAA",
  };
  return names[t] ?? String(t);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
