/**
 * Media reference collection — TECH_SPEC_V1.md §6.8, §6.9.
 *
 * Every media reference in the content model is a UUID stored under a key whose
 * name ends in `media_id` — `background_media_id` on the hero section, `media_id`
 * on portfolio items and on post `media` blocks, and `cover_media_id` on a post.
 * Collecting by key suffix (rather than hard-coding each path) means a new
 * media-bearing field is covered automatically once its schema lands, and it
 * transparently handles both nested JSON (section `data`, post `draft_body`) and
 * top-level columns folded into a scannable object. Retained older published
 * versions may still hold timeline `media_id` values (the field was removed) —
 * those references keep those S3 objects out of the orphan sweep for as long as
 * the version history retains them (§6.9).
 *
 * This mirrors the private collector in `publishService` (which builds the
 * document's `media` map); it is factored out here so the GC pass (§6.9) can
 * scan all four reference sources without depending on the publish service.
 */
export function collectMediaIds(value: unknown, acc: Set<string>): void {
  if (Array.isArray(value)) {
    for (const entry of value) collectMediaIds(entry, acc);
    return;
  }
  if (value && typeof value === "object") {
    for (const [key, v] of Object.entries(value as Record<string, unknown>)) {
      if (key.endsWith("media_id") && typeof v === "string" && v.length > 0) {
        acc.add(v);
      } else {
        collectMediaIds(v, acc);
      }
    }
  }
}
