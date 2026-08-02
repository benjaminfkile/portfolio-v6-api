import { z } from "zod";
import { Knex } from "knex";
import { getDb } from "../db/db";
import {
  pageSlugSchema,
  RESERVED_PAGE_SLUGS,
} from "../schemas/pages";
import {
  FailureCode,
  ServiceResult,
} from "./sectionsService";

/**
 * Pages working-set service — TECH_SPEC_V1.md §3.10, §4.2 (v1.1 rows), §4.5.
 *
 * v1.1 makes pages first-class content (§3.10): the admin composes any number of
 * pages, each owning an ordered list of `sections` (`sections.page_id`). This
 * service owns the `pages` table CRUD, the full-array nav reorder, and the
 * optimistic-concurrency precondition on PATCH (§4.5) — mirroring
 * `sectionsService` exactly (thin router, service owns logic, `ServiceResult`
 * discriminated union mapped to HTTP by the router).
 *
 * Slug rules (§3.10): lowercase `[a-z0-9-]+`, unique, and never a reserved slug
 * (`blog`/`api`/`admin`). `home` is NOT reserved — it is the slug that renders at
 * `/`. Validation reuses the canonical `pageSlugSchema`/`pageSchema` (§3.9) so the
 * same rules apply on write here as at publish.
 */

// ---- Result envelope (shared vocabulary with sectionsService) ---------------

function fail<T>(code: FailureCode, message: string): ServiceResult<T> {
  return { ok: false, code, message };
}

function ok<T>(data: T): ServiceResult<T> {
  return { ok: true, data };
}

const PAGES = "pages";

// ---- Row shape --------------------------------------------------------------

export interface PageRow {
  id: string;
  slug: string;
  title: string;
  /** null = served at its slug but absent from the nav (§3.10). */
  nav_label: string | null;
  nav_position: number;
  is_hidden: boolean;
  created_at: Date;
  updated_at: Date;
}

// ---- Validation schemas -----------------------------------------------------

/**
 * Create payload (§4.2 POST /api/admin/pages). `slug` and `title` are required —
 * a page always has a URL segment and a title — while `nav_label`/`nav_position`
 * are optional (defaulting to "not in the nav" / append at the end). `.strict()`
 * rejects unknown keys, and `pageSlugSchema` folds in the reserved-slug and
 * format rules (§3.10).
 */
const createPageSchema = z
  .object({
    slug: pageSlugSchema,
    title: z.string().min(1),
    nav_label: z.string().min(1).nullable().optional(),
    nav_position: z.number().int().optional(),
  })
  .strict();

/**
 * Update payload (§4.2 PATCH /api/admin/pages/:id) — draft-lenient (§3.9): every
 * provided field must be well-typed but nothing is required, so the admin can
 * touch a single field. `expected_updated_at` is handled separately (§4.5) and is
 * not part of this schema.
 */
const updatePageSchema = z
  .object({
    slug: pageSlugSchema.optional(),
    title: z.string().min(1).optional(),
    nav_label: z.string().min(1).nullable().optional(),
    nav_position: z.number().int().optional(),
    is_hidden: z.boolean().optional(),
  })
  .strict();

// ---- Helpers ----------------------------------------------------------------

/**
 * Optimistic-concurrency comparison (§4.5) — identical semantics to
 * `sectionsService`: compare at millisecond precision, a malformed `expected` is
 * treated as stale (409) rather than a silent overwrite.
 */
function timestampsMatch(rowUpdatedAt: Date, expected: string): boolean {
  const rowMs = new Date(rowUpdatedAt).getTime();
  const expectedMs = new Date(expected).getTime();
  return Number.isFinite(expectedMs) && rowMs === expectedMs;
}

async function nextNavPosition(db: Knex): Promise<number> {
  const row = await db(PAGES).max<{ max: number | null }[]>("nav_position as max").first();
  const max = (row as unknown as { max: number | null })?.max;
  return max === null || max === undefined ? 0 : Number(max) + 1;
}

/** Render a Zod issue list into the same one-line message style as sections. */
function zodMessage(error: z.ZodError): string {
  return error.message;
}

// ---- Read: all pages (§4.2 GET /api/admin/pages) ----------------------------

/** All pages ordered by `nav_position` (§4.2); `created_at` breaks ties. */
export async function listPages(): Promise<PageRow[]> {
  const db = getDb();
  return db<PageRow>(PAGES)
    .select("*")
    .orderBy([
      { column: "nav_position", order: "asc" },
      { column: "created_at", order: "asc" },
    ]);
}

// ---- Create page (§4.2 POST /api/admin/pages) -------------------------------

export interface CreatePageInput {
  slug?: unknown;
  title?: unknown;
  nav_label?: unknown;
  nav_position?: unknown;
}

export async function createPage(
  input: CreatePageInput
): Promise<ServiceResult<PageRow>> {
  const parsed = createPageSchema.safeParse(input ?? {});
  if (!parsed.success) {
    return fail("validation", `Invalid page: ${zodMessage(parsed.error)}`);
  }
  const { slug, title, nav_label, nav_position } = parsed.data;

  const db = getDb();
  // Duplicate slug → 400 validation (the UNIQUE constraint also protects, but a
  // pre-check gives a clean, deterministic message — single-admin, no race).
  const clash = await db<PageRow>(PAGES).where({ slug }).first();
  if (clash) {
    return fail("validation", `slug "${slug}" already exists`);
  }

  const position =
    nav_position === undefined ? await nextNavPosition(db) : nav_position;
  const [row] = await db<PageRow>(PAGES)
    .insert({
      slug,
      title,
      nav_label: nav_label === undefined ? null : nav_label,
      nav_position: position,
    })
    .returning("*");
  return ok(row);
}

// ---- Update page (§4.2 PATCH + §4.5 precondition) ---------------------------

export interface UpdatePageInput {
  expected_updated_at: string;
  slug?: unknown;
  title?: unknown;
  nav_label?: unknown;
  nav_position?: unknown;
  is_hidden?: unknown;
}

export async function updatePage(
  id: string,
  input: UpdatePageInput
): Promise<ServiceResult<PageRow>> {
  // Pull only the mutable fields (drop expected_updated_at) and validate the ones
  // that were actually provided.
  const fields: Record<string, unknown> = {};
  for (const key of ["slug", "title", "nav_label", "nav_position", "is_hidden"] as const) {
    if (input[key] !== undefined) fields[key] = input[key];
  }
  if (Object.keys(fields).length === 0) {
    return fail(
      "bad_request",
      "Provide at least one of slug, title, nav_label, nav_position, or is_hidden"
    );
  }
  const parsed = updatePageSchema.safeParse(fields);
  if (!parsed.success) {
    return fail("validation", `Invalid page: ${zodMessage(parsed.error)}`);
  }
  const patchFields = parsed.data;

  const db = getDb();
  return db.transaction(async (trx) => {
    const row = await trx<PageRow>(PAGES).where({ id }).forUpdate().first();
    if (!row) return fail<PageRow>("not_found", "Page not found");

    if (!timestampsMatch(row.updated_at, input.expected_updated_at)) {
      // Stale precondition → 409, no write (§4.5).
      return fail<PageRow>(
        "conflict",
        "Page changed since it was loaded (expected_updated_at mismatch)"
      );
    }

    // A slug change must not collide with another page's slug.
    if (patchFields.slug !== undefined && patchFields.slug !== row.slug) {
      const clash = await trx<PageRow>(PAGES)
        .where({ slug: patchFields.slug })
        .andWhereNot({ id })
        .first();
      if (clash) {
        return fail<PageRow>("validation", `slug "${patchFields.slug}" already exists`);
      }
    }

    const [updated] = await trx<PageRow>(PAGES)
      .where({ id })
      .update({ ...patchFields, updated_at: trx.fn.now() } as never)
      .returning("*");
    return ok(updated);
  });
}

// ---- Delete page (§4.2 DELETE — cascades to sections + items via FK) --------

export async function deletePage(id: string): Promise<ServiceResult<null>> {
  const db = getDb();
  // ON DELETE CASCADE on sections.page_id (and section_items.section_id
  // transitively) removes the page's whole subtree (§3.10).
  const count = await db<PageRow>(PAGES).where({ id }).del();
  if (count === 0) return fail("not_found", "Page not found");
  return ok(null);
}

// ---- Reorder pages (§4.2 PUT /api/admin/pages/order) ------------------------

/**
 * Full-array nav reorder (§4.2 / §4.5 reorder exemption). The client sends the
 * complete ordered id array; each id's `nav_position` becomes its index inside
 * one transaction. The array must be exactly the current set of page ids (same
 * members, no duplicates). Idempotent and precondition-free.
 */
export async function reorderPages(
  order: unknown
): Promise<ServiceResult<PageRow[]>> {
  const db = getDb();
  return db.transaction(async (trx) => {
    const existing = await trx<PageRow>(PAGES).select("id").forUpdate();
    const check = validateReorderArray(order, existing.map((r) => r.id));
    if (check) return fail<PageRow[]>(check.code, check.message);

    const ids = order as string[];
    for (let i = 0; i < ids.length; i++) {
      await trx<PageRow>(PAGES).where({ id: ids[i] }).update({ nav_position: i });
    }
    const pages = await trx<PageRow>(PAGES)
      .select("*")
      .orderBy([
        { column: "nav_position", order: "asc" },
        { column: "created_at", order: "asc" },
      ]);
    return ok(pages);
  });
}

// ---- Shared reorder validation ----------------------------------------------

/**
 * A reorder array must be the exact current id set: same length, no duplicates,
 * every provided id present, and no extra ids. (Mirrors the sections reorder
 * check.) Returns a failure descriptor or null when valid.
 */
function validateReorderArray(
  order: unknown,
  existingIds: string[]
): { code: FailureCode; message: string } | null {
  if (!Array.isArray(order) || order.some((v) => typeof v !== "string")) {
    return { code: "bad_request", message: "order must be an array of id strings" };
  }
  const provided = order as string[];
  if (new Set(provided).size !== provided.length) {
    return { code: "bad_request", message: "order contains duplicate ids" };
  }
  const existingSet = new Set(existingIds);
  if (provided.length !== existingSet.size) {
    return {
      code: "bad_request",
      message: "order must contain exactly the current set of ids",
    };
  }
  for (const id of provided) {
    if (!existingSet.has(id)) {
      return { code: "bad_request", message: `unknown id in order: ${id}` };
    }
  }
  return null;
}

// Re-export for callers/tests that want the reserved list alongside the service.
export { RESERVED_PAGE_SLUGS };
