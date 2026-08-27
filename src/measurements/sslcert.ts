import type { AtlasResultRow, Env } from "../types";
import { parseCertificate, pemToDer, sha256Hex, type CertInfo } from "../x509";
import { assertPublicTarget, asString, af, bad, ms, rttStats, stringifyError } from "./kind";
import type { MeasurementKind, NodeSummary, ProbeOutcome } from "./kind";

export interface SslParams {
  target: string;
  af: 4 | 6;
  port: number;
  /** SNI hostname; defaults to the target. */
  hostname?: string;
}

const isIpLiteral = (t: string): boolean => t.includes(":") || /^[\d.]+$/.test(t);

/** TLS ports we are willing to point probes at — this is not a port scanner. */
const ALLOWED_PORTS = new Set([443, 465, 636, 853, 993, 995, 8443]);

export const sslcert: MeasurementKind<SslParams> = {
  type: "sslcert",
  label: "SSL 证书",
  creditsPerProbe: () => 10,

  validate(input: Record<string, unknown>, _env: Env): SslParams {
    const port = Number(input.port ?? 443);
    if (!ALLOWED_PORTS.has(port)) {
      bad(`port ${port} is not allowed. Allowed: ${[...ALLOWED_PORTS].join(", ")}`);
    }
    const target = assertPublicTarget(asString(input, "target"));
    const explicit =
      typeof input.hostname === "string" && input.hostname.trim()
        ? assertPublicTarget(input.hostname)
        : undefined;
    // Default SNI to the target. Without it a shared-hosting or CDN endpoint
    // hands back a fallback certificate, which reads as "expired" and is a
    // completely wrong verdict about the site the caller asked about.
    const hostname = explicit ?? (isIpLiteral(target) ? undefined : target);
    return { target, af: af(input), port, hostname };
  },

  buildDefinition(p, description) {
    const def: Record<string, unknown> = {
      type: "sslcert",
      af: p.af,
      target: p.target,
      port: p.port,
      description,
      is_oneoff: true,
    };
    if (p.hostname) def.hostname = p.hostname;
    return def;
  },

  async parseRow(row: AtlasResultRow): Promise<ProbeOutcome> {
    if (row.error) return { ok: false, rttMs: null, error: stringifyError(row.error), detail: {} };
    if (row.err) return { ok: false, rttMs: null, error: stringifyError(row.err), detail: {} };
    if (row.alert) {
      return { ok: false, rttMs: ms(row.rt), error: `TLS alert: ${stringifyError(row.alert)}`, detail: {} };
    }

    const chain = Array.isArray(row.cert) ? (row.cert as string[]) : [];
    if (chain.length === 0) return { ok: false, rttMs: ms(row.rt), error: "no certificate", detail: {} };

    let info: CertInfo | null = null;
    let fingerprint: string | null = null;
    let parseError: string | undefined;
    try {
      const der = pemToDer(chain[0]);
      info = parseCertificate(der);
      fingerprint = await sha256Hex(der);
    } catch (e) {
      parseError = e instanceof Error ? e.message : "certificate parse failed";
    }

    const now = Date.now();
    const notAfter = info?.notAfter ? Date.parse(info.notAfter) : NaN;
    const expired = Number.isFinite(notAfter) ? notAfter < now : null;
    const daysLeft = Number.isFinite(notAfter) ? Math.floor((notAfter - now) / 86400000) : null;

    return {
      ok: !parseError && expired === false,
      rttMs: ms(row.rt),
      error: parseError ?? (expired ? "certificate expired" : undefined),
      detail: {
        subjectCN: info?.subjectCN ?? null,
        issuerCN: info?.issuerCN ?? null,
        issuerO: info?.issuerO ?? null,
        notBefore: info?.notBefore ?? null,
        notAfter: info?.notAfter ?? null,
        daysLeft,
        sans: info?.sans ?? [],
        serial: info?.serial ?? null,
        fingerprint,
        chainLength: chain.length,
        tlsVersion: typeof row.ver === "string" ? row.ver : null,
        dstAddr: typeof row.dst_addr === "string" ? row.dst_addr : null,
      },
    };
  },

  summarize(outcomes: ProbeOutcome[]): NodeSummary {
    // Differing fingerprints across regions is the interesting signal here:
    // it means someone is serving a different certificate somewhere.
    const prints = [...new Set(outcomes.map((o) => o.detail.fingerprint).filter(Boolean))] as string[];
    const daysLeft = outcomes
      .map((o) => o.detail.daysLeft)
      .filter((v): v is number => typeof v === "number");
    return {
      ...rttStats(outcomes.map((o) => o.rttMs)),
      distinctFingerprints: prints.length,
      fingerprint: prints.length === 1 ? prints[0] : null,
      daysLeft: daysLeft.length ? Math.min(...daysLeft) : null,
    };
  },
};
