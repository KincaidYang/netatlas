import table from "../data/cities.json";

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

function distanceKm(aLat: number, aLon: number, bLat: number, bLon: number): number {
  const x =
    Math.sin(((bLat - aLat) * R) / 2) ** 2 +
    Math.cos(aLat * R) * Math.cos(bLat * R) * Math.sin(((bLon - aLon) * R) / 2) ** 2;
  return 2 * 6371 * Math.asin(Math.sqrt(x));
}

const cellKey = (lat: number, lon: number): number => Math.floor(lat) * 1000 + Math.floor(lon);

/**
 * One-degree buckets, built on first use. 3,500 rows is small enough that a
 * linear scan would work, but this runs once per probe on every results poll.
 */
let grid: Map<number, Row[]> | null = null;
function index(): Map<number, Row[]> {
  if (grid) return grid;
  grid = new Map();
  for (const row of CITIES) {
    const key = cellKey(row[0] / 1e4, row[1] / 1e4);
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
  let best: Row | null = null;
  let bestKm = Infinity;
  for (let dLat = -1; dLat <= 1; dLat++) {
    for (let dLon = -1; dLon <= 1; dLon++) {
      for (const row of cells.get(cellKey(lat + dLat, lon + dLon)) ?? []) {
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
