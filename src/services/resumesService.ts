import { randomUUID } from "crypto";
import { getDb } from "../db/db";
import * as s3 from "../aws/s3Service";
import { safeFilename } from "../utils/safeFilename";
import { toCdnUrl } from "../utils/cdn";
import {
  RESUME_CACHE_CONTROL,
  RESUME_MAX_BYTES,
  RESUME_MIME,
  RESUME_UPLOAD_URL_TTL_SECONDS,
} from "../config/resumes";

/**
 * Resume versions service — task #92.
 *
 * The admin uploads resume PDFs (every version is kept) and the public site
 * always serves the newest confirmed one. Mirrors the media upload flow (§6.7)
 * but for PDFs only: presigned PUT → confirm → newest-confirmed lookup, all
 * scoped to the `resumes` table and the `resumes/{uuid}/{filename}` S3 prefix.
 *
 * Resumes are deliberately NOT `media_assets` rows: the §6.9 media orphan
 * sweep's reference scan and tagging is scoped to the `media_assets` table
 * only, so a resume object under its own prefix is invisible to that pass and
 * can never be swept out from under the public /api/resume endpoint. Business
 * logic and DB access are here; the router only shapes the envelope and maps
 * `ResumeResult` failure codes to HTTP status.
 */

const RESUMES = "resumes";

// ---- Result envelope (mirrors mediaService) ---------------------------------

export type ResumeFailureCode = "not_found" | "validation" | "bad_request";

export type ResumeResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: ResumeFailureCode; message: string };

function fail<T>(code: ResumeFailureCode, message: string): ResumeResult<T> {
  return { ok: false, code, message };
}

function ok<T>(data: T): ResumeResult<T> {
  return { ok: true, data };
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

// ---- Row / view shapes ------------------------------------------------------

interface ResumeRow {
  id: string;
  s3_key: string;
  filename: string;
  bytes: string | number;
  confirmed_at: Date | null;
  created_at: Date;
  uploaded_by: string;
}

/** Admin-list view of a resume version (task #92). */
export interface ResumeAdminView {
  id: string;
  s3_key: string;
  filename: string;
  bytes: number;
  confirmed_at: string | null;
  created_at: string;
  uploaded_by: string;
  confirmed: boolean;
  /** CDN URL for this version (§6.8 CDN resolution, per-version). */
  url: string;
}

/** Public view of the newest confirmed resume version (task #92). */
export interface ResumePublicView {
  available: true;
  url: string;
  filename: string;
  bytes: number;
  uploaded_at: string;
}

export interface ResumePublicUnavailable {
  available: false;
}

function iso(value: Date | string | null): string | null {
  if (value === null || value === undefined) return null;
  return new Date(value).toISOString();
}

function toAdminView(row: ResumeRow, cdnDomain: string): ResumeAdminView {
  return {
    id: row.id,
    s3_key: row.s3_key,
    filename: row.filename,
    bytes: Number(row.bytes),
    confirmed_at: iso(row.confirmed_at),
    created_at: iso(row.created_at) as string,
    uploaded_by: row.uploaded_by,
    confirmed: row.confirmed_at != null,
    url: toCdnUrl(cdnDomain, row.s3_key),
  };
}

// ---- Upload URL (POST /api/admin/resumes/upload-url) ------------------------

export interface ResumeUploadUrlInput {
  filename?: unknown;
  size?: unknown;
}

export interface ResumeUploadUrlResult {
  id: string;
  s3_key: string;
  upload_url: string;
  /** Headers the client must send byte-for-byte on the PUT (§6.7 gotcha). */
  upload_headers: Record<string, string>;
  expires_in: number;
}

/**
 * POST /api/admin/resumes/upload-url (task #92 / §6.7). Validates the filename
 * and size (application/pdf implicit, ≤ 10 MB), generates
 * `resumes/{uuid}/{filename}`, mints a 15-min presigned PUT with
 * `Content-Type: application/pdf` and `Cache-Control` pinned into the
 * signature, and inserts a `resumes` row with `confirmed_at = null`. The
 * declared size is recorded provisionally; confirm later overwrites `bytes`
 * with the true object size.
 *
 * NOTE: unlike the media flow this does NOT tag the object `state=pending` —
 * there is no lifecycle rule for the `resumes/` prefix (the row is the source
 * of truth for whether a version is confirmed), so the signature only pins
 * `Content-Type` + `Cache-Control`.
 */
export async function createResumeUploadUrl(
  input: ResumeUploadUrlInput,
  uploadedBy: string
): Promise<ResumeResult<ResumeUploadUrlResult>> {
  const filename =
    typeof input.filename === "string" ? input.filename.trim() : "";
  const size =
    typeof input.size === "number" ? input.size : Number(input.size);

  if (!filename) return fail("bad_request", "filename is required");
  if (!Number.isFinite(size) || size <= 0) {
    return fail("bad_request", "size must be a positive number of bytes");
  }
  if (size > RESUME_MAX_BYTES) {
    return fail(
      "validation",
      `size ${size} exceeds the ${RESUME_MAX_BYTES}-byte resume upload cap`
    );
  }
  // Only PDFs. `.pdf` is checked case-insensitively; anything else is refused
  // before a URL is minted. The MIME type is ALSO pinned into the signature
  // below, so a browser that lies about the extension still cannot upload a
  // non-PDF payload with these credentials.
  const safe = safeFilename(filename);
  if (!/\.pdf$/i.test(safe)) {
    return fail(
      "validation",
      `filename "${filename}" is not a .pdf — only application/pdf uploads are allowed`
    );
  }

  const key = s3.buildResumeKey(randomUUID(), safe);
  const presigned = await s3.generatePresignedUploadUrl({
    key,
    contentType: RESUME_MIME,
    cacheControl: RESUME_CACHE_CONTROL,
    expiresInSeconds: RESUME_UPLOAD_URL_TTL_SECONDS,
  });

  const [row] = await getDb()<ResumeRow>(RESUMES)
    .insert({
      s3_key: key,
      filename: safe,
      bytes: Math.floor(size),
      confirmed_at: null,
      uploaded_by: uploadedBy,
    })
    .returning(["id"]);

  return ok({
    id: row.id,
    s3_key: key,
    upload_url: presigned.url,
    upload_headers: {
      "Content-Type": presigned.headers["Content-Type"] ?? RESUME_MIME,
      "Cache-Control":
        presigned.headers["Cache-Control"] ?? RESUME_CACHE_CONTROL,
    },
    expires_in: RESUME_UPLOAD_URL_TTL_SECONDS,
  });
}

// ---- Confirm (POST /api/admin/resumes/:id/confirm) --------------------------

/**
 * POST /api/admin/resumes/:id/confirm (task #92 / §6.7). HEADs the object to
 * verify it landed, records the true byte size, and stamps `confirmed_at`. A
 * missing object (never PUT) is a 404; the row is left pending so the client
 * can retry the upload.
 */
export async function confirmResumeUpload(
  id: string,
  cdnDomain: string
): Promise<ResumeResult<ResumeAdminView>> {
  if (!UUID_RE.test(id)) return fail("bad_request", "invalid resume id");

  const db = getDb();
  const row = await db<ResumeRow>(RESUMES).where({ id }).first();
  if (!row) return fail("not_found", `resume ${id} not found`);

  const head = await s3.headObject(row.s3_key);
  if (!head) {
    return fail("not_found", `object for resume ${id} has not been uploaded`);
  }

  await db(RESUMES)
    .where({ id })
    .update({
      bytes: head.contentLength,
      confirmed_at: new Date().toISOString(),
    });

  const updated = await db<ResumeRow>(RESUMES).where({ id }).first();
  return ok(toAdminView(updated as ResumeRow, cdnDomain));
}

// ---- List (GET /api/admin/resumes) ------------------------------------------

/**
 * GET /api/admin/resumes (task #92). Every version, newest first, each with a
 * CDN url, filename, bytes, uploaded_by, created_at, and confirmed state so
 * the admin library can surface which versions are live vs pending.
 */
export async function listResumes(
  cdnDomain: string
): Promise<ResumeAdminView[]> {
  const rows = await getDb()<ResumeRow>(RESUMES)
    .select("*")
    .orderBy("created_at", "desc");
  return rows.map((r) => toAdminView(r, cdnDomain));
}

// ---- Delete (DELETE /api/admin/resumes/:id) ---------------------------------

/**
 * DELETE /api/admin/resumes/:id (task #92). Removes the S3 object and the
 * row. If this was the newest confirmed version, the next-newest confirmed
 * version is promoted publicly by simple virtue of being the next hit on the
 * newest-confirmed lookup — no explicit "promotion" step required.
 */
export async function deleteResume(id: string): Promise<ResumeResult<null>> {
  if (!UUID_RE.test(id)) return fail("bad_request", "invalid resume id");

  const db = getDb();
  const row = await db<ResumeRow>(RESUMES).where({ id }).first();
  if (!row) return fail("not_found", `resume ${id} not found`);

  await s3.deleteObject(row.s3_key);
  await db(RESUMES).where({ id }).del();
  return ok(null);
}

// ---- Newest confirmed (public GET /api/resume) ------------------------------

/**
 * The newest confirmed resume row, or `null` when no version has ever been
 * confirmed. Used by both public endpoints — the metadata endpoint resolves
 * this to a CDN url, and the download endpoint streams the row's S3 object.
 */
async function getNewestConfirmedRow(): Promise<ResumeRow | null> {
  const row = await getDb()<ResumeRow>(RESUMES)
    .whereNotNull("confirmed_at")
    .orderBy("created_at", "desc")
    .first();
  return row ?? null;
}

/**
 * GET /api/resume (task #92). The newest CONFIRMED version resolved to a
 * public CDN URL, or `{available:false}` when none. Raw response per §4.3;
 * `Cache-Control: no-store` (a new upload must go live immediately) is set by
 * the router. Degrades — an unexpected DB error is the router's problem, not
 * this function's, but callers are expected to swallow any thrown error into
 * `{available:false}` so the endpoint never 5xxes.
 */
export async function getNewestConfirmedResume(
  cdnDomain: string
): Promise<ResumePublicView | ResumePublicUnavailable> {
  const row = await getNewestConfirmedRow();
  if (!row) return { available: false };
  return {
    available: true,
    url: toCdnUrl(cdnDomain, row.s3_key),
    filename: row.filename,
    bytes: Number(row.bytes),
    uploaded_at: iso(row.confirmed_at) as string,
  };
}

// ---- Download (public GET /api/resume/download) -----------------------------

export interface ResumeDownloadStream {
  filename: string;
  contentLength: number | null;
  body: NodeJS.ReadableStream;
}

/**
 * The newest confirmed resume streamed straight from S3 (task #92). Returns
 * `null` when either no confirmed version exists or the S3 object for the
 * newest row is missing — in both cases the router serves 404. The CDN cannot
 * force `Content-Disposition: attachment` cross-origin, so the download always
 * flows through this endpoint (which sets attachment + the stored filename).
 */
export async function streamNewestResumeForDownload(): Promise<ResumeDownloadStream | null> {
  const row = await getNewestConfirmedRow();
  if (!row) return null;
  const object = await s3.getObjectStream(row.s3_key);
  if (!object) return null;
  return {
    filename: row.filename,
    contentLength: object.contentLength,
    body: object.body,
  };
}
