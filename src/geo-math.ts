/**
 * The nearest-city rule, in one copy.
 *
 * `src/geo.ts` serves this at runtime; `scripts/build-cities.mjs` replays it to
 * report how many live probes the table it just built can name. CLAUDE.md says
 * those two must agree — "when they drift it stops measuring what ships" — but
 * saying so is not a mechanism, and they had already drifted: the script's
 * tie-break moved to a later row whenever that row sat in the probe's country,
 * where the runtime only moves when the incumbent does *not*. Same radius, same
 * reach, different answer on a three-way tie.
 *
 * Node imports this `.ts` from the `.mjs` script directly (native type
 * stripping, no loader, no build step), so there is one implementation and the
 * question of whether the copies match cannot be asked.
 *
 * Keep it erasable-syntax-only — no `enum`, no `namespace`, no parameter
 * properties. Node strips types, it does not compile them.
 *
 * Nothing here reads `data/cities.json`. The caller supplies the rows and the
 * match radius, because the script has to run this against the table it is
 * still building, before there is a file to read.
 */

/** `[lat*1e4, lon*1e4, cc, name]` — scaled ints keep the bundled table small. */
export type CityRow = [number, number, string, string];

const R = Math.PI / 180;

/** Length of one degree of longitude at the equator. */
export const KM_PER_DEGREE = 111.32;

export function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const x =
    Math.sin(((bLat - aLat) * R) / 2) ** 2 +
    Math.cos(aLat * R) * Math.cos(bLat * R) * Math.sin(((bLon - aLon) * R) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
}

/**
 * One bucket per whole degree. Longitude wraps so a search that runs off the
 * antimeridian comes back on the other side instead of falling off the index;
 * latitude does not, because there is nothing past the pole to reach.
 */
export const cellKey = (latBucket: number, lonBucket: number): number =>
  latBucket * 1000 + ((((lonBucket + 180) % 360) + 360) % 360) - 180;

/**
 * How many longitude buckets the match radius spans at this latitude.
 *
 * A degree of longitude is 111 km at the equator and 39 km at Tromsø, so a
 * fixed one-bucket reach quietly breaks the radius contract in the north: a
 * probe at 69.65N, 20.1E sits 44 km from Tromsø and two buckets away from it.
 * The cosine is taken half a degree further poleward than the probe, since the
 * match radius reaches that far in latitude too.
 */
export function lonReach(lat: number, matchKm: number): number {
  const edge = Math.min(89.9, Math.abs(lat) + 0.5);
  return Math.min(180, Math.ceil(matchKm / (KM_PER_DEGREE * Math.cos(edge * R))));
}

/** One-degree buckets over rows in the stored `[lat*1e4, lon*1e4, …]` form. */
export function buildIndex(rows: CityRow[]): Map<number, CityRow[]> {
  const grid = new Map<number, CityRow[]>();
  for (const row of rows) {
    const key = cellKey(Math.floor(row[0] / 1e4), Math.floor(row[1] / 1e4));
    const cell = grid.get(key);
    if (cell) cell.push(row);
    else grid.set(key, [row]);
  }
  return grid;
}

/**
 * The nearest row within `matchKm`, or null when there isn't one.
 *
 * `cc` breaks ties toward the probe's own country: some probes report a country
 * that disagrees with their coordinates — one anchor is filed under CN while
 * sitting in Hong Kong — and a border should not leak names across. A metre is
 * noise in coordinates Atlas already rounds, so near-ties count as ties.
 *
 * The tie only moves the pick when the incumbent is *not* already in the
 * country. Without that guard a third row equidistant from two others in the
 * same country displaces the first for no reason, which is how the runtime and
 * the coverage report used to disagree.
 */
export function nearestCity(
  index: Map<number, CityRow[]>,
  lat: number,
  lon: number,
  cc: string | null | undefined,
  matchKm: number,
): CityRow | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const country = cc?.toUpperCase();
  const latBucket = Math.floor(lat);
  const lonBucket = Math.floor(lon);
  const reach = lonReach(lat, matchKm);
  let best: CityRow | null = null;
  let bestKm = Infinity;
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLon = -reach; dLon <= reach; dLon++) {
      for (const row of index.get(cellKey(latBucket + dLat, lonBucket + dLon)) ?? []) {
        const d = distanceKm(lat, lon, row[0] / 1e4, row[1] / 1e4);
        if (d > matchKm) continue;
        const closer = d < bestKm - 0.001;
        const tied = Math.abs(d - bestKm) <= 0.001;
        if (closer || (tied && country && row[2] === country && best?.[2] !== country)) {
          best = row;
          bestKm = d;
        }
      }
    }
  }
  return best;
}

/**
 * Atlas's own admission that it could not place a probe any better than its
 * country. The coordinates on such a probe are a national centroid, and a
 * centroid lands near a real city often enough to be dangerous — the middle of
 * the Netherlands is 12 km from Amersfoort.
 */
export const COUNTRY_CENTROID_TAG = "system-auto-geoip-country";

/**
 * Territories small enough that the fallback point is still the right answer:
 * the whole place fits inside the match radius, so "somewhere in Hong Kong" and
 * "Hong Kong" are the same statement. Only add a territory whose full extent is
 * under the match radius — Hong Kong is ~40 km across, Macau ~10, Singapore ~50.
 *
 * It matters twice: 12 of Hong Kong's 61 connected probes carry the country tag
 * and would lose a name they have, and the coverage report would call them
 * skipped while the shipped code names them.
 */
export const SINGLE_METRO = new Set(["HK", "MO", "SG"]);

/**
 * Whether this probe's coordinates are a country centroid rather than a place.
 *
 * Of China's 82 connected probes, 16 carry the tag and all 16 sit on
 * `113.72, 34.77` — the point GeoIP returns for "somewhere in China", which
 * lands beside Zhengzhou. Reading their coordinates reports a 16-probe cluster
 * in 郑州 that does not exist.
 */
export function isCountryCentroid(
  tags: ReadonlyArray<{ slug?: string } | null | undefined> | null | undefined,
  cc: string | null | undefined,
): boolean {
  if (!tags?.some((t) => t?.slug === COUNTRY_CENTROID_TAG)) return false;
  return !(cc && SINGLE_METRO.has(cc.toUpperCase()));
}
