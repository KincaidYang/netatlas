import table from "../data/cities.json";
import type { ProbeMeta } from "./types";
import {
  buildIndex,
  isCountryCentroid,
  nearestCity,
  type CityRow,
} from "./geo-math";

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

const CITIES = table.cities as CityRow[];

/**
 * How far a probe may sit from a table entry and still be called by its name.
 * 50 km is the metro scale: 宁海 belongs to 宁波 (18 km away) while 深圳 and
 * 广州, 110 km apart, never blur together. Beyond it we say nothing — a probe
 * in the countryside has no city, and the 500-odd probes Atlas geolocated only
 * to a country sit on a centroid that would otherwise pick up a name it has no
 * right to.
 *
 * The value is baked into the table by `npm run cities:refresh`, so the radius
 * the table was built for is the radius it is read with.
 */
const MATCH_KM = table.matchKm as number;

/**
 * One-degree buckets, built on first use. 3,500 rows is small enough that a
 * linear scan would work, but this runs once per probe on every results poll.
 */
let grid: Map<number, CityRow[]> | null = null;
const index = (): Map<number, CityRow[]> => (grid ??= buildIndex(CITIES));

/**
 * The nearest city within MATCH_KM, or null when there isn't one.
 *
 * The rule itself lives in `./geo-math`, which `scripts/build-cities.mjs`
 * imports too — its coverage report has to answer exactly what this answers or
 * it is measuring a program that does not ship.
 */
export function cityFor(lat: number, lon: number, cc?: string | null): string | null {
  return nearestCity(index(), lat, lon, cc, MATCH_KM)?.[3] ?? null;
}

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
  if (isCountryCentroid(meta.tags, meta.country_code)) return null;
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
