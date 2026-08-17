/**
 * Resume upload policy — task #92.
 *
 * Resume PDFs use the media upload flow (§6.7) but with a PDF-only allowlist
 * and a much smaller size cap: 10 MB, plenty for a typical résumé and a hard
 * ceiling on abusive uploads. The presigned URL TTL matches the media flow's
 * 15 minutes.
 */

/** Only PDFs are accepted. Pinned into the presigned PUT's signature (§6.7). */
export const RESUME_MIME = "application/pdf";

/** Upload size cap — 10 MB (task #92). */
export const RESUME_MAX_BYTES = 10 * 1024 * 1024;

/** Presigned PUT TTL — 15 minutes, mirrors the media flow (§6.7). */
export const RESUME_UPLOAD_URL_TTL_SECONDS = 15 * 60;

/**
 * Immutable long-cache header pinned onto every resume object. Objects are
 * write-once under a UUID key, so a one-year immutable cache is always safe —
 * a new version writes a new key and the public /api/resume points at it.
 */
export const RESUME_CACHE_CONTROL = "public, max-age=31536000, immutable";
