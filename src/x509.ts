/**
 * Minimal DER / X.509 reader — just enough to describe a server certificate.
 *
 * Deliberately hand-rolled for the same reason src/dns.ts decodes DNS wire
 * format by hand: Workers has no X.509 parser, and pulling in `nodejs_compat`
 * (or an npm ASN.1 library) to read six fields is a bad trade. We read only
 * what we display and ignore everything else, so unknown extensions and
 * exotic encodings simply don't matter.
 */

export interface CertInfo {
  subjectCN: string | null;
  issuerCN: string | null;
  issuerO: string | null;
  /** ISO 8601, UTC. */
  notBefore: string | null;
  notAfter: string | null;
  sans: string[];
  serial: string | null;
}

interface Tlv {
  tag: number;
  /** Offset of the content (after tag + length bytes). */
  start: number;
  end: number;
}

const OID_CN = "2.5.4.3";
const OID_O = "2.5.4.10";
const OID_SAN = "2.5.29.17";

function readTlv(b: Uint8Array, pos: number): Tlv {
  if (pos + 2 > b.length) throw new Error("truncated DER");
  const tag = b[pos];
  let len = b[pos + 1];
  let start = pos + 2;
  if (len & 0x80) {
    const n = len & 0x7f;
    if (n === 0 || n > 4 || start + n > b.length) throw new Error("bad DER length");
    len = 0;
    for (let i = 0; i < n; i++) len = (len << 8) | b[start + i];
    start += n;
  }
  const end = start + len;
  if (end > b.length) throw new Error("truncated DER");
  return { tag, start, end };
}

/** Iterate the TLVs directly inside a constructed value. */
function* children(b: Uint8Array, parent: Tlv): Generator<Tlv> {
  let pos = parent.start;
  while (pos < parent.end) {
    const t = readTlv(b, pos);
    yield t;
    pos = t.end;
  }
}

function oid(b: Uint8Array, t: Tlv): string {
  const bytes = b.subarray(t.start, t.end);
  if (bytes.length === 0) return "";
  const out = [Math.floor(bytes[0] / 40), bytes[0] % 40];
  let acc = 0;
  for (let i = 1; i < bytes.length; i++) {
    acc = acc * 128 + (bytes[i] & 0x7f);
    if (!(bytes[i] & 0x80)) {
      out.push(acc);
      acc = 0;
    }
  }
  return out.join(".");
}

const text = (b: Uint8Array, t: Tlv): string =>
  new TextDecoder().decode(b.subarray(t.start, t.end)).replace(/\0/g, "").trim();

/** UTCTime (YYMMDDHHMMSSZ) and GeneralizedTime (YYYYMMDDHHMMSSZ). */
function time(b: Uint8Array, t: Tlv): string | null {
  const s = text(b, t);
  const m = /^(\d{2}|\d{4})(\d{2})(\d{2})(\d{2})(\d{2})(\d{2})?Z?$/.exec(s);
  if (!m) return null;
  let year = Number(m[1]);
  if (m[1].length === 2) year += year >= 50 ? 1900 : 2000;
  const iso = `${String(year).padStart(4, "0")}-${m[2]}-${m[3]}T${m[4]}:${m[5]}:${m[6] ?? "00"}Z`;
  return Number.isNaN(Date.parse(iso)) ? null : iso;
}

/** A Name is SEQUENCE OF SET OF SEQUENCE { type OID, value ANY }. */
function nameAttr(b: Uint8Array, name: Tlv, wanted: string): string | null {
  for (const set of children(b, name)) {
    for (const pair of children(b, set)) {
      const parts = [...children(b, pair)];
      if (parts.length >= 2 && oid(b, parts[0]) === wanted) return text(b, parts[1]);
    }
  }
  return null;
}

function dnsNames(b: Uint8Array, extensions: Tlv): string[] {
  for (const ext of children(b, extensions)) {
    const parts = [...children(b, ext)];
    if (parts.length < 2 || oid(b, parts[0]) !== OID_SAN) continue;
    // Last element is the OCTET STRING wrapping the extension value.
    const wrapped = parts[parts.length - 1];
    const names = readTlv(b, wrapped.start);
    const out: string[] = [];
    for (const gn of children(b, names)) {
      if (gn.tag === 0x82) out.push(text(b, gn)); // [2] dNSName
    }
    return out;
  }
  return [];
}

export function parseCertificate(der: Uint8Array): CertInfo {
  const cert = readTlv(der, 0);
  const tbs = readTlv(der, cert.start);

  let t = readTlv(der, tbs.start);
  if (t.tag === 0xa0) t = readTlv(der, t.end); // skip [0] EXPLICIT version
  const serial = [...der.subarray(t.start, t.end)]
    .map((x) => x.toString(16).padStart(2, "0"))
    .join("");

  const sigAlg = readTlv(der, t.end);
  const issuer = readTlv(der, sigAlg.end);
  const validity = readTlv(der, issuer.end);
  const [nb, na] = [...children(der, validity)];
  const subject = readTlv(der, validity.end);
  const spki = readTlv(der, subject.end);

  let sans: string[] = [];
  let pos = spki.end;
  while (pos < tbs.end) {
    const opt = readTlv(der, pos);
    if (opt.tag === 0xa3) {
      // [3] EXPLICIT Extensions — one SEQUENCE inside.
      sans = dnsNames(der, readTlv(der, opt.start));
      break;
    }
    pos = opt.end;
  }

  return {
    subjectCN: nameAttr(der, subject, OID_CN),
    issuerCN: nameAttr(der, issuer, OID_CN),
    issuerO: nameAttr(der, issuer, OID_O),
    notBefore: nb ? time(der, nb) : null,
    notAfter: na ? time(der, na) : null,
    sans,
    serial: serial || null,
  };
}

/** Strip PEM armour and base64-decode. */
export function pemToDer(pem: string): Uint8Array {
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/[^A-Za-z0-9+/=]/g, "");
  const bin = atob(body);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function sha256Hex(der: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", der as BufferSource);
  return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
