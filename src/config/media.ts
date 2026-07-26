/**
 * Media upload policy & lifecycle constants — TECH_SPEC_V1.md §6.4, §6.7, §6.9.
 *
 * These are exported as config (task DoD) so the mime allowlist, the size cap,
 * the presigned-URL TTL, the immutable cache header and the GC windows all live
 * in one place rather than being scattered as magic numbers through the service.
 */

/**
 * Allowed upload MIME types (§6.7). Portfolio media is a handful of images and
 * short videos, so the allowlist is deliberately narrow — anything not listed is
 * refused before a presigned URL is ever minted.
 */
export const MEDIA_MIME_ALLOWLIST = [
  "image/jpeg",
  "image/png",
  "image/webp",
  "image/gif",
  "image/avif",
  "video/mp4",
  "video/webm",
  "video/quicktime",
] as const;

/**
 * Upload size cap (§6.7). A single S3 PUT handles up to 5 GB, but portfolio
 * media never approaches that; 500 MiB comfortably covers a short video while
 * bounding accidental or abusive uploads.
 */
export const MEDIA_MAX_BYTES = 500 * 1024 * 1024;

/** Presigned PUT TTL (§6.7): 15 minutes. */
export const UPLOAD_URL_TTL_SECONDS = 15 * 60;

/**
 * Immutable long-cache header pinned onto every object (§6.4). Objects are
 * write-once under a UUID key, so a one-year immutable cache is always safe.
 */
export const MEDIA_CACHE_CONTROL = "public, max-age=31536000, immutable";

/**
 * Object tags that drive the two S3 lifecycle rules (§6.7 / §6.9):
 *   - `state=pending`  → `expire-pending-uploads`  (1 day)
 *   - `state=orphaned` → `expire-orphaned-media`   (7 days)
 * The pending tag is pinned into the presigned PUT signature; confirm removes it
 * and the GC pass applies/removes the orphaned tag.
 */
export const STATE_TAG_KEY = "state";
export const PENDING_TAG_VALUE = "pending";
export const ORPHANED_TAG_VALUE = "orphaned";
/** The exact `x-amz-tagging` string the upload client must echo (§6.7). */
export const PENDING_TAGGING = `${STATE_TAG_KEY}=${PENDING_TAG_VALUE}`;

/** GC grace period, measured from upload/created_at (§6.9): 30 days. */
export const GC_GRACE_PERIOD_DAYS = 30;

/** `expire-orphaned-media` window — deletion date = unreferenced_at + 7d (§6.9). */
export const ORPHAN_DELETION_WINDOW_DAYS = 7;

/** True when `mime` is in the upload allowlist (§6.7). */
export function isAllowedMime(mime: string): boolean {
  return (MEDIA_MIME_ALLOWLIST as readonly string[]).includes(mime);
}
