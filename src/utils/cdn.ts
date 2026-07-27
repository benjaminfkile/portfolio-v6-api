/**
 * CDN URL resolution — TECH_SPEC_V1.md §6.8.
 *
 * `media_assets` stores an `s3_key` only, never an absolute URL, and the
 * published document / preview document reference media by `media_id` and carry
 * a lookup map of ids → keys. The content, post, and preview endpoints resolve
 * those keys to absolute URLs at read time through this one function, so the
 * stored documents stay domain-agnostic: moving the CDN behind a different
 * hostname (or introducing signing) is a config change plus this function, with
 * no document rewrite and no republish of history.
 */

/** Resolve a single `s3_key` to an absolute CDN URL using `cdn_domain`. */
export function toCdnUrl(cdnDomain: string, key: string): string {
  return `https://${cdnDomain}/${key}`;
}

/**
 * A resolved media reference as the public site consumes it: the absolute CDN
 * URL plus the asset's alt text (`media_assets.alt`, §3.2 — the a11y floor of
 * §14.2 depends on it reaching the renderer).
 */
export interface MediaRef {
  url: string;
  alt: string | null;
}

/**
 * Resolve a media lookup map of `media_id → s3_key` (as stored in a published or
 * draft document) to `media_id → { url, alt }` for a read-time response. `alts`
 * comes from a read-time media_assets lookup; ids absent there resolve with a
 * null alt (e.g. the asset row was deleted after publish).
 */
export function resolveMediaMap(
  cdnDomain: string,
  keyMap: Record<string, string>,
  alts: Record<string, string | null> = {}
): Record<string, MediaRef> {
  const resolved: Record<string, MediaRef> = {};
  for (const [id, key] of Object.entries(keyMap)) {
    resolved[id] = { url: toCdnUrl(cdnDomain, key), alt: alts[id] ?? null };
  }
  return resolved;
}
