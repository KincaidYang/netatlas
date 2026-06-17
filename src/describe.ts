/**
 * The service is stateless (no DB in phase 1), but GET /probe/:id still needs
 * to know what was *requested* per region to report fill rates. We stash that
 * compactly in the Atlas measurement `description` and parse it back on read.
 */

export interface ProbeDescription {
  domain: string;
  queryType: string;
  af: number;
  requested: Record<string, number>;
}

export function buildDescription(d: ProbeDescription): string {
  const req = Object.entries(d.requested)
    .map(([cc, n]) => `${cc}:${n}`)
    .join(",");
  return `netatlas|domain=${d.domain}|qt=${d.queryType}|af=${d.af}|req=${req}`;
}

export function parseDescription(desc: string): ProbeDescription | null {
  if (!desc.startsWith("netatlas|")) return null;
  const parts: Record<string, string> = {};
  for (const seg of desc.split("|").slice(1)) {
    const i = seg.indexOf("=");
    if (i === -1) continue;
    parts[seg.slice(0, i)] = seg.slice(i + 1);
  }
  const requested: Record<string, number> = {};
  if (parts.req) {
    for (const pair of parts.req.split(",")) {
      if (!pair) continue;
      const [cc, n] = pair.split(":");
      requested[cc] = Number(n);
    }
  }
  return {
    domain: parts.domain ?? "",
    queryType: parts.qt ?? "",
    af: Number(parts.af ?? 4),
    requested,
  };
}
