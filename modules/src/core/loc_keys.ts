// Unity Localization keys of catalog texts (plan B, D-11). The English text
// served by the catalogs stays the fallback; the key is derived when serving.

/** Kinds of catalog entity whose texts the client localizes (plan B, D-11). */
export type LocKind =
  | 'track'
  | 'mode'
  | 'car'
  | 'cosmetic'
  | 'store_section'
  | 'store_offer'
  | 'mission'
  | 'achievement'
  | 'division';

/** Text field of an entity: `name` for `displayName`, `title`, `description`. */
export type LocField = 'name' | 'title' | 'description';

/** Unity Localization key of a catalog text: `<kind>.<id>.<field>`. The English text stays the fallback. */
export function locKey(kind: LocKind, id: string, field: LocField): string {
  return `${kind}.${id}.${field}`;
}
