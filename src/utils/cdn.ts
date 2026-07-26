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
 * Resolve a media lookup map of `media_id → s3_key` (as stored in a published or
 * draft document) to `media_id → absolute CDN URL` for a read-time response.
 */
export function resolveMediaMap(
  cdnDomain: string,
  keyMap: Record<string, string>
): Record<string, string> {
  const resolved: Record<string, string> = {};
  for (const [id, key] of Object.entries(keyMap)) {
    resolved[id] = toCdnUrl(cdnDomain, key);
  }
  return resolved;
}
