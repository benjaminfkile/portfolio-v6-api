import { randomUUID } from "crypto";
import { Knex } from "knex";
import { getDb } from "../db/db";
import * as s3 from "../aws/s3Service";
import { collectMediaIds } from "../utils/mediaRefs";
import { safeFilename } from "../utils/safeFilename";
import {
  GC_GRACE_PERIOD_DAYS,
  MEDIA_CACHE_CONTROL,
  MEDIA_MAX_BYTES,
  ORPHAN_DELETION_WINDOW_DAYS,
  ORPHANED_TAG_VALUE,
  PENDING_TAGGING,
  STATE_TAG_KEY,
  UPLOAD_URL_TTL_SECONDS,
  isAllowedMime,
} from "../config/media";

/**
 * Media service — TECH_SPEC_V1.md §6.7 (upload path), §6.8 (URL resolution),
 * §6.9 (lifecycle & garbage collection).
 *
 * Owns the presigned-upload / confirm flow, the admin media library listing,
 * hard deletes, and the application-level GC pass. All S3 access goes through
 * `../aws/s3Service` (isolated + fully mocked in tests); this service is pure
 * DB + orchestration. HTTP mapping is left to the router: functions return a
 * discriminated `MediaResult` and the router maps the failure `code` to a status.
 */

const MEDIA_ASSETS = "media_assets";
const SECTIONS = "sections";
const SECTION_ITEMS = "section_items";
const PAGE_VERSIONS = "page_versions";
const POSTS = "posts";

// ---- Result envelope (mirrors sectionsService / publishService) -------------

export type MediaFailureCode = "not_found" | "validation" | "bad_request";

export type MediaResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: MediaFailureCode; message: string };

function fail<T>(code: MediaFailureCode, message: string): MediaResult<T> {
  return { ok: false, code, message };
}

function ok<T>(data: T): MediaResult<T> {
  return { ok: true, data };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- Row / view shapes ------------------------------------------------------

interface MediaAssetRow {
  id: string;
  s3_key: string;
  mime: string;
  bytes: string | number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  alt: string | null;
  confirmed_at: Date | null;
  unreferenced_at: Date | null;
  created_at: Date;
}

/** Admin-library view of an asset (§4.2 GET /api/admin/media). */
export interface MediaAssetView {
  id: string;
  s3_key: string;
  mime: string;
  bytes: number;
  width: number | null;
  height: number | null;
  duration_ms: number | null;
  alt: string | null;
  confirmed_at: string | null;
  unreferenced_at: string | null;
  created_at: string;
  /** True once the GC pass has tagged this asset `state=orphaned` (§6.9). */
  orphaned: boolean;
  /**
   * When an orphaned object is scheduled to be lifecycle-deleted:
   * `unreferenced_at` + 7 days (§6.9). Null while the asset is still referenced.
   */
  scheduled_deletion_at: string | null;
}

function iso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value).toISOString();
}

function toView(row: MediaAssetRow): MediaAssetView {
  const unreferencedAt = iso(row.unreferenced_at);
  let scheduledDeletionAt: string | null = null;
  if (unreferencedAt) {
    const base = new Date(unreferencedAt).getTime();
    scheduledDeletionAt = new Date(
      base + ORPHAN_DELETION_WINDOW_DAYS * 24 * 60 * 60 * 1000
    ).toISOString();
  }
  return {
    id: row.id,
    s3_key: row.s3_key,
    mime: row.mime,
    bytes: Number(row.bytes),
    width: row.width ?? null,
    height: row.height ?? null,
    duration_ms: row.duration_ms ?? null,
    alt: row.alt ?? null,
    confirmed_at: iso(row.confirmed_at),
    unreferenced_at: unreferencedAt,
    created_at: iso(row.created_at) as string,
    orphaned: row.unreferenced_at != null,
    scheduled_deletion_at: scheduledDeletionAt,
  };
}

// ---- Upload URL (§6.7 POST /api/admin/media/upload-url) ---------------------

export interface UploadUrlInput {
  filename?: unknown;
  mime?: unknown;
  size?: unknown;
}

export interface UploadUrlResult {
  id: string;
  s3_key: string;
  upload_url: string;
  /** Headers the client must send byte-for-byte on the PUT (§6.7). */
  upload_headers: Record<string, string>;
  expires_in: number;
}

/**
 * POST /api/admin/media/upload-url (§6.7). Validates mime against the allowlist
 * and size against the cap, generates `media/{uuid}/{filename}`, mints a 15-min
 * presigned PUT with Cache-Control / Content-Type / `Tagging: state=pending`
 * pinned into the signature, and inserts a `media_assets` row with
 * `confirmed_at = null`. The declared size is recorded provisionally; confirm
 * later overwrites `bytes` with the true object size.
 */
export async function createUploadUrl(
  input: UploadUrlInput
): Promise<MediaResult<UploadUrlResult>> {
  const filename = typeof input.filename === "string" ? input.filename.trim() : "";
  const mime = typeof input.mime === "string" ? input.mime.trim() : "";
  const size =
    typeof input.size === "number" ? input.size : Number(input.size);

  if (!filename) return fail("bad_request", "filename is required");
  if (!mime) return fail("bad_request", "mime is required");
  if (!isAllowedMime(mime)) {
    return fail("validation", `mime "${mime}" is not an allowed media type`);
  }
  if (!Number.isFinite(size) || size <= 0) {
    return fail("bad_request", "size must be a positive number of bytes");
  }
  if (size > MEDIA_MAX_BYTES) {
    return fail(
      "validation",
      `size ${size} exceeds the ${MEDIA_MAX_BYTES}-byte upload cap`
    );
  }

  const key = s3.buildMediaKey(randomUUID(), safeFilename(filename));
  const presigned = await s3.generatePresignedUploadUrl({
    key,
    contentType: mime,
    cacheControl: MEDIA_CACHE_CONTROL,
    tagging: PENDING_TAGGING,
    expiresInSeconds: UPLOAD_URL_TTL_SECONDS,
  });

  const [row] = await getDb()<MediaAssetRow>(MEDIA_ASSETS)
    .insert({
      s3_key: key,
      mime,
      bytes: Math.floor(size),
      confirmed_at: null,
    })
    .returning(["id"]);

  return ok({
    id: row.id,
    s3_key: key,
    upload_url: presigned.url,
    upload_headers: presigned.headers,
    expires_in: UPLOAD_URL_TTL_SECONDS,
  });
}

// ---- Confirm (§6.7 POST /api/admin/media/:id/confirm) -----------------------

/**
 * POST /api/admin/media/:id/confirm (§6.7). HEADs the object to verify it landed,
 * records the true byte size, removes the `state=pending` tag (so the object
 * leaves the `expire-pending-uploads` lifecycle rule's scope), and stamps
 * `confirmed_at`. A missing object (never PUT, or already lifecycle-expired) is a
 * 404; the row is left pending so the client can retry the upload.
 */
export async function confirmUpload(
  id: string
): Promise<MediaResult<MediaAssetView>> {
  if (!UUID_RE.test(id)) return fail("bad_request", "invalid media id");

  const db = getDb();
  const row = await db<MediaAssetRow>(MEDIA_ASSETS).where({ id }).first();
  if (!row) return fail("not_found", `media ${id} not found`);

  const head = await s3.headObject(row.s3_key);
  if (!head) {
    return fail("not_found", `object for media ${id} has not been uploaded`);
  }

  // Removing the pending tag takes the object out of the expire-pending-uploads
  // rule; only one state=pending tag exists so clearing the set is the removal.
  await s3.deleteObjectTags(row.s3_key);

  await db(MEDIA_ASSETS)
    .where({ id })
    .update({ bytes: head.contentLength, confirmed_at: new Date().toISOString() });

  const updated = await db<MediaAssetRow>(MEDIA_ASSETS).where({ id }).first();
  return ok(toView(updated as MediaAssetRow));
}

// ---- List (§4.2 GET /api/admin/media) ---------------------------------------

/**
 * GET /api/admin/media (§4.2). Every asset, newest first, each carrying its
 * orphan status and — when orphaned — the scheduled S3 deletion date (§6.9), so
 * the admin library can surface "deletes in N days, re-reference to rescue".
 */
export async function listAssets(): Promise<MediaAssetView[]> {
  const rows = await getDb()<MediaAssetRow>(MEDIA_ASSETS)
    .select("*")
    .orderBy("created_at", "desc");
  return rows.map(toView);
}

// ---- Delete (§4.2 DELETE /api/admin/media/:id) ------------------------------

/**
 * DELETE /api/admin/media/:id (§4.2). Removes the S3 object and the row. This is
 * an immediate hard delete (distinct from GC's lifecycle-based expiry) for an
 * asset the admin explicitly discards.
 */
export async function deleteAsset(id: string): Promise<MediaResult<null>> {
  if (!UUID_RE.test(id)) return fail("bad_request", "invalid media id");

  const db = getDb();
  const row = await db<MediaAssetRow>(MEDIA_ASSETS).where({ id }).first();
  if (!row) return fail("not_found", `media ${id} not found`);

  await s3.deleteObject(row.s3_key);
  await db(MEDIA_ASSETS).where({ id }).del();
  return ok(null);
}

// ---- Garbage collection (§6.9) ----------------------------------------------

export interface GcSummary {
  /** Assets newly tagged orphaned this pass. */
  orphaned: string[];
  /** Re-referenced assets whose orphan state was cleared this pass. */
  rescued: string[];
  /** Rows removed because their S3 object had lifecycle-expired. */
  deleted: string[];
}

/**
 * Build the reference set from ALL FOUR sources (§6.9) — omitting any of them
 * would let the next GC pass orphan and then delete media that is still in use:
 *
 *   1. the current working set (`sections.data` / `section_items.data`),
 *   2. every retained `page_versions.document` (the last 50, §3.3),
 *   3. every post's `draft_body` AND `published_body`,
 *   4. every post's `cover_media_id`.
 *
 * The post sources are the easy-to-forget ones (§6.9): blog media lives in a
 * different table from page media and must be scanned explicitly, or publishing
 * a post would delete its own images on the next sweep.
 */
export async function collectReferenceSet(db: Knex): Promise<Set<string>> {
  const refs = new Set<string>();

  // 1. Working set.
  for (const row of await db(SECTIONS).select("data")) {
    collectMediaIds((row as { data: unknown }).data, refs);
  }
  for (const row of await db(SECTION_ITEMS).select("data")) {
    collectMediaIds((row as { data: unknown }).data, refs);
  }

  // 2. Every retained published version.
  for (const row of await db(PAGE_VERSIONS).select("document")) {
    collectMediaIds((row as { document: unknown }).document, refs);
  }

  // 3 + 4. Posts: draft body, published body, and cover image.
  const posts = await db(POSTS).select(
    "draft_body",
    "published_body",
    "cover_media_id"
  );
  for (const row of posts as Array<{
    draft_body: unknown;
    published_body: unknown;
    cover_media_id: string | null;
  }>) {
    collectMediaIds(row.draft_body, refs);
    collectMediaIds(row.published_body, refs);
    if (row.cover_media_id) refs.add(row.cover_media_id);
  }

  return refs;
}

/**
 * The GC pass (§6.9). For every asset, given the reference set:
 *
 *   - referenced + currently orphaned → RESCUE: clear `unreferenced_at` and drop
 *     the `state=orphaned` tag. Re-referencing an asset rescues it within the
 *     7-day undo window.
 *   - unreferenced + already orphaned → if the object HEADs 404 the S3 lifecycle
 *     rule has expired it, so delete the now-dangling row.
 *   - unreferenced + confirmed + older than the 30-day grace → ORPHAN: stamp
 *     `unreferenced_at` and tag the object `state=orphaned` (arming the 7-day
 *     `expire-orphaned-media` rule).
 *
 * Pending (unconfirmed) uploads are left to the pure-S3 `expire-pending-uploads`
 * rule (§6.9) and never orphaned here. The grace period is measured from upload
 * (`created_at`), so media added and removed within one session is far too young
 * to be touched.
 */
export async function runGc(now: Date = new Date()): Promise<GcSummary> {
  const db = getDb();
  const refs = await collectReferenceSet(db);

  const assets = await db<MediaAssetRow>(MEDIA_ASSETS).select(
    "id",
    "s3_key",
    "confirmed_at",
    "unreferenced_at",
    "created_at"
  );

  const graceMs = GC_GRACE_PERIOD_DAYS * 24 * 60 * 60 * 1000;
  const summary: GcSummary = { orphaned: [], rescued: [], deleted: [] };

  for (const asset of assets) {
    const referenced = refs.has(asset.id);
    const isOrphaned = asset.unreferenced_at != null;

    if (referenced) {
      if (isOrphaned) {
        await db(MEDIA_ASSETS)
          .where({ id: asset.id })
          .update({ unreferenced_at: null });
        await s3.deleteObjectTags(asset.s3_key);
        summary.rescued.push(asset.id);
      }
      continue;
    }

    if (isOrphaned) {
      // Already tagged in an earlier pass — reap the row once S3 has expired the
      // object (detected via a HEAD 404, §6.9).
      const head = await s3.headObject(asset.s3_key);
      if (!head) {
        await db(MEDIA_ASSETS).where({ id: asset.id }).del();
        summary.deleted.push(asset.id);
      }
      continue;
    }

    if (asset.confirmed_at == null) continue; // pending → handled by S3 alone.

    const ageMs = now.getTime() - new Date(asset.created_at).getTime();
    if (ageMs < graceMs) continue; // still inside the 30-day grace period.

    await db(MEDIA_ASSETS)
      .where({ id: asset.id })
      .update({ unreferenced_at: now.toISOString() });
    await s3.putObjectTags(asset.s3_key, { [STATE_TAG_KEY]: ORPHANED_TAG_VALUE });
    summary.orphaned.push(asset.id);
  }

  return summary;
}

/**
 * Run the GC pass but never let it break the caller. Publishing hooks this in
 * the same request after a successful snapshot (§6.9) — a sweep failure there
 * must not fail an already-committed publish, so errors are logged and swallowed.
 */
export async function runGcSafely(): Promise<void> {
  try {
    await runGc();
  } catch (err) {
    console.error("[GC] post-publish media sweep failed", err);
  }
}
