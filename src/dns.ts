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

export function parseDnsAnswers(abufBase64: string): DnsRecord[] {
  const bytes = base64ToBytes(abufBase64);
  if (bytes.length < 12) return [];
  const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);

  const qdcount = dv.getUint16(4);
  const ancount = dv.getUint16(6);

  let pos = 12;
  for (let i = 0; i < qdcount; i++) {
    pos = skipName(bytes, pos) + 4; // QTYPE (2) + QCLASS (2)
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
  return records;
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
    labels.push(asciiSlice(bytes, pos + 1, len));
    pos += 1 + len;
  }
  return [labels.join("."), next === -1 ? pos : next];
}

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
    case 16: { // TXT (one or more length-prefixed strings)
      const out: string[] = [];
      let p = start;
      const end = start + len;
      while (p < end) {
        const l = bytes[p];
        out.push(asciiSlice(bytes, p + 1, l));
        p += 1 + l;
      }
      return out.join(" ");
    }
    default:
      return toHex(bytes, start, len);
  }
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
    1: "A", 2: "NS", 5: "CNAME", 6: "SOA", 12: "PTR", 15: "MX", 16: "TXT", 28: "AAAA", 33: "SRV", 257: "CAA",
  };
  return names[t] ?? String(t);
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
