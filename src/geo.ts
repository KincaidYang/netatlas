import table from "../data/cities.json";
import type { ProbeMeta } from "./types";

/**
 * Probe coordinates → a city name.
 *
 * RIPE Atlas gives a probe's `geometry` and nothing else: there is no `city`
 * field on a probe, and `?city=` is not a filter (Atlas silently ignores
 * unknown filters and returns every probe it has). So the name has to come
 * from `data/cities.json`, which `npm run cities:refresh` bakes — China by
 * hand, everywhere else from GeoNames coordinates only.
 *
 * The country/region a reader sees never comes from here. That stays with
 * COUNTRY_NAMES in src/nodes.ts, keyed by the probe's own Atlas country code.
 * This module answers one question and no other: what is this place called.
 */

/** `[lat*1e4, lon*1e4, cc, name]` — scaled ints keep the bundled table small. */
type Row = [number, number, string, string];

const CITIES = table.cities as Row[];

/**
 * How far a probe may sit from a table entry and still be called by its name.
 * 50 km is the metro scale: 宁海 belongs to 宁波 (18 km away) while 深圳 and
 * 广州, 110 km apart, never blur together. Beyond it we say nothing — a probe
 * in the countryside has no city, and the 500-odd probes Atlas geolocated only
 * to a country sit on a centroid that would otherwise pick up a name it has no
 * right to.
 */
const MATCH_KM = table.matchKm as number;

const R = Math.PI / 180;

/** Length of one degree of longitude at the equator. */
const KM_PER_DEGREE = 111.32;

function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
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
const cellKey = (latBucket: number, lonBucket: number): number =>
  latBucket * 1000 + (((lonBucket + 180) % 360) + 360) % 360 - 180;

/**
 * How many longitude buckets 50 km spans here.
 *
 * A degree of longitude is 111 km at the equator and 39 km at Tromsø, so a
 * fixed one-bucket reach quietly breaks the 50 km contract in the north: a
 * probe at 69.65N, 20.1E sits 44 km from Tromsø and two buckets away from it.
 * The cosine is taken half a degree further poleward than the probe, since the
 * match radius reaches that far in latitude too.
 */
function lonReach(lat: number): number {
  const edge = Math.min(89.9, Math.abs(lat) + 0.5);
  return Math.min(180, Math.ceil(MATCH_KM / (KM_PER_DEGREE * Math.cos(edge * R))));
}

/**
 * One-degree buckets, built on first use. 3,500 rows is small enough that a
 * linear scan would work, but this runs once per probe on every results poll.
 */
let grid: Map<number, Row[]> | null = null;
function index(): Map<number, Row[]> {
  if (grid) return grid;
  grid = new Map();
  for (const row of CITIES) {
    const key = cellKey(Math.floor(row[0] / 1e4), Math.floor(row[1] / 1e4));
    const cell = grid.get(key);
    if (cell) cell.push(row);
    else grid.set(key, [row]);
  }
  return grid;
}

/**
 * The nearest city within MATCH_KM, or null when there isn't one.
 *
 * `cc` breaks ties toward the probe's own country: some probes report a
 * country that disagrees with their coordinates — one anchor is filed under CN
 * while sitting in Hong Kong — and a border should not leak names across.
 */
export function cityFor(lat: number, lon: number, cc?: string | null): string | null {
  if (!Number.isFinite(lat) || !Number.isFinite(lon)) return null;
  const country = cc?.toUpperCase();
  const cells = index();
  const latBucket = Math.floor(lat);
  const lonBucket = Math.floor(lon);
  const reach = lonReach(lat);
  let best: Row | null = null;
  let bestKm = Infinity;
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLon = -reach; dLon <= reach; dLon++) {
      for (const row of cells.get(cellKey(latBucket + dLat, lonBucket + dLon)) ?? []) {
        const d = distanceKm(lat, lon, row[0] / 1e4, row[1] / 1e4);
        if (d > MATCH_KM) continue;
        // A metre of difference is noise in coordinates Atlas already rounds,
        // so treat near-ties as ties and let the country decide.
        const closer = d < bestKm - 0.001;
        const tied = Math.abs(d - bestKm) <= 0.001;
        if (closer || (tied && country && row[2] === country && best?.[2] !== country)) {
          best = row;
          bestKm = d;
        }
      }
    }
  }
  return best?.[3] ?? null;
}

/**
 * Atlas's own admission that it could not place a probe any better than its
 * country. The coordinates on such a probe are a national centroid, and a
 * centroid lands near a real city often enough to be dangerous — the middle of
 * the Netherlands is 12 km from Amersfoort. Naming one would invent a fact, so
 * `cityOfProbe` refuses to.
 */
const COUNTRY_CENTROID_TAG = "system-auto-geoip-country";

/**
 * Territories small enough that the fallback point is still the right answer:
 * the whole place fits inside the match radius, so "somewhere in Hong Kong" and
 * "Hong Kong" are the same statement. Only add a territory whose full extent is
 * under MATCH_KM — Hong Kong is ~40 km across, Macau ~10, Singapore ~50.
 *
 * It matters: 12 of Hong Kong's 61 connected probes carry the country tag, and
 * blanking them would throw away something we actually know.
 */
const SINGLE_METRO = new Set(["HK", "MO", "SG"]);

/**
 * The city for a probe, or null — the entry point results should use, because
 * it is the one that knows which probes must not be named.
 *
 * The tag is not a formality. Of China's 82 connected probes, 16 carry it and
 * all 16 sit on `113.72, 34.77` — the fallback point GeoIP hands back for
 * "somewhere in China", which happens to land beside Zhengzhou. Reading their
 * coordinates would report a 16-probe cluster in 郑州 that does not exist.
 */
export function cityOfProbe(meta: ProbeMeta | undefined | null): string | null {
  if (!meta) return null;
  const cc = meta.country_code?.toUpperCase();
  if (meta.tags?.some((t) => t?.slug === COUNTRY_CENTROID_TAG) && !(cc && SINGLE_METRO.has(cc))) {
    return null;
  }
  return cityOf(meta.geometry, meta.country_code);
}

/** Convenience for the shape Atlas actually returns: `geometry.coordinates`. */
export function cityOf(
  geometry: { coordinates?: [number, number] | number[] } | null | undefined,
  cc?: string | null,
): string | null {
  const coords = geometry?.coordinates;
  if (!coords || coords.length < 2) return null;
  // GeoJSON is [longitude, latitude] — the opposite of how everyone says it.
  return cityFor(coords[1], coords[0], cc);
}
