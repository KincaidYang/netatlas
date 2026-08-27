/**
 * A human-readable tag written into the Atlas measurement `description`, so a
 * netatlas-created measurement is recognisable in the RIPE Atlas UI.
 *
 * It is NOT load-bearing: what was requested per group is recovered from
 * `GET /measurements/<id>/participation-requests/`, which Atlas serves without
 * authentication. Atlas caps the description at 255 characters.
 */
export const DESCRIPTION_MAX = 255;

export function buildDescription(type: string, target: string): string {
  return `netatlas ${type} ${target}`.slice(0, DESCRIPTION_MAX);
}
