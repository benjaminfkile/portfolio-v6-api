import { stripEmptyStrings } from "../utils/draftData";
import { Knex } from "knex";
import { getDb } from "../db/db";
import {
  SECTION_TYPES,
  SECTION_DATA_SCHEMAS,
  DRAFT_SECTION_DATA_SCHEMAS,
  ITEM_SCHEMAS,
  DRAFT_ITEM_SCHEMAS,
  SectionType,
} from "../schemas";

/**
 * Sections & items working-set service — TECH_SPEC_V1.md §4.2, §4.5, §3.9.
 *
 * The `sections` + `section_items` tables are the always-draft working set
 * (§3.2). This service owns their CRUD, the full-array reorder, and the
 * optimistic-concurrency precondition on every PATCH (§4.5). All content `data`
 * blobs are validated against the canonical task-2 Zod schemas on every write
 * (§3.9) so the JSONB columns can never hold garbage that would only surface as
 * a public-site crash.
 *
 * HTTP mapping is left to the router: service functions return a discriminated
 * `ServiceResult` and the router translates the failure `code` to a status
 * (`not_found` → 404, `conflict` → 409, `validation`/`bad_request` → 400).
 */

// ---- Row shapes -------------------------------------------------------------

export interface SectionRow {
  id: string;
  /** Owning page (§3.10). Every section belongs to exactly one page. */
  page_id: string;
  type: SectionType;
  position: number;
  is_hidden: boolean;
  data: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface SectionItemRow {
  id: string;
  section_id: string;
  position: number;
  is_hidden: boolean;
  data: Record<string, unknown>;
  created_at: Date;
  updated_at: Date;
}

export interface SectionWithItems extends SectionRow {
  items: SectionItemRow[];
}

// ---- Result envelope --------------------------------------------------------

export type FailureCode = "not_found" | "conflict" | "validation" | "bad_request";

export type ServiceResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: FailureCode; message: string };

function fail<T>(code: FailureCode, message: string): ServiceResult<T> {
  return { ok: false, code, message };
}

function ok<T>(data: T): ServiceResult<T> {
  return { ok: true, data };
}

const SECTIONS = "sections";
const SECTION_ITEMS = "section_items";
const PAGES = "pages";

// ---- Helpers ----------------------------------------------------------------

/**
 * Resolve the id of the default `home` page, creating it if absent (§3.10).
 *
 * Admin section creates now carry an explicit `page_id` (§4.2 v1.1), so this is
 * no longer on that path. It remains the fallback for the publish/restore
 * pipeline, which must land the working set on the implicit `home` page — the
 * same page the migration backfill adopts a pre-existing working set into — when
 * a legacy (flat-sections) document is restored (§3.10 back-compat). Creating it
 * lazily keeps a fresh database (no backfill ran) writable. Accepts a `Knex` or a
 * transaction so callers inside a publish/restore transaction stay atomic.
 */
export async function resolveDefaultPageId(
  db: Knex | Knex.Transaction
): Promise<string> {
  const existing = await db(PAGES).where({ slug: "home" }).first();
  if (existing) return (existing as { id: string }).id;
  const [row] = await db(PAGES)
    .insert({ slug: "home", title: "Home", nav_label: "Home", nav_position: 0 })
    .returning("id");
  return (row as { id: string }).id;
}

const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/**
 * A page_id arrives from the client as an opaque string. Validating its shape
 * before it reaches a `uuid` column turns a bad value into a clean 400 rather
 * than a Postgres "invalid input syntax for type uuid" 500.
 */
function isUuid(value: unknown): value is string {
  return typeof value === "string" && UUID_RE.test(value);
}

function isKnownSectionType(type: unknown): type is SectionType {
  return (
    typeof type === "string" && (SECTION_TYPES as readonly string[]).includes(type)
  );
}

function isItemBearing(type: SectionType): type is keyof typeof ITEM_SCHEMAS {
  return Object.prototype.hasOwnProperty.call(ITEM_SCHEMAS, type);
}

/**
 * Validate a section `data` blob against its type's DRAFT-LENIENT schema
 * (§3.9: invalid content can reach a draft, never production). Provided fields
 * must be well-typed and unknown keys are rejected, but nothing is required —
 * publish enforces completeness against the canonical schemas.
 */
function validateSectionData(
  type: SectionType,
  data: unknown
): ServiceResult<Record<string, unknown>> {
  const schema = DRAFT_SECTION_DATA_SCHEMAS[type];
  const parsed = schema.safeParse(stripEmptyStrings(data ?? {}));
  if (!parsed.success) {
    return fail("validation", `Invalid data for section type "${type}": ${parsed.error.message}`);
  }
  return ok(parsed.data as Record<string, unknown>);
}

/**
 * Validate a `section_items` `data` blob against the owning section type's item
 * schema (§3.4 / §3.9). Only `timeline`/`skills`/`portfolio` bear items.
 */
function validateItemData(
  sectionType: SectionType,
  data: unknown
): ServiceResult<Record<string, unknown>> {
  if (!isItemBearing(sectionType)) {
    return fail(
      "bad_request",
      `Section type "${sectionType}" does not support items`
    );
  }
  const schema = DRAFT_ITEM_SCHEMAS[sectionType];
  const parsed = schema.safeParse(stripEmptyStrings(data ?? {}));
  if (!parsed.success) {
    return fail(
      "validation",
      `Invalid data for ${sectionType} item: ${parsed.error.message}`
    );
  }
  return ok(parsed.data as Record<string, unknown>);
}

/**
 * Optimistic-concurrency comparison (§4.5). Both operands are compared at the
 * millisecond precision the `pg` client exposes (timestamptz → JS Date), which
 * is exactly the precision a client received when it last read the row, so a
 * round-tripped ISO string compares stably. A malformed `expected` never equals
 * a real timestamp, so it is treated as stale (409) rather than a silent write.
 */
function timestampsMatch(rowUpdatedAt: Date, expected: string): boolean {
  const rowMs = new Date(rowUpdatedAt).getTime();
  const expectedMs = new Date(expected).getTime();
  return Number.isFinite(expectedMs) && rowMs === expectedMs;
}

async function nextPosition(
  qb: Knex.QueryBuilder,
  db: Knex
): Promise<number> {
  const row = await qb.max<{ max: number | null }[]>("position as max").first();
  const max = (row as unknown as { max: number | null })?.max;
  return max === null || max === undefined ? 0 : Number(max) + 1;
}

// ---- Read: full working set (§4.2 GET /api/admin/sections) ------------------

/**
 * The full working set: every section (drafts included) ordered within its page
 * by `position`, each with its `section_items` nested and likewise ordered.
 * `created_at` is a stable tiebreaker so equal positions render deterministically.
 *
 * v1.1 (§3.10): sections belong to pages. Passing `pageId` narrows to a single
 * page (the §4.2 `?page_id=` filter); without it the whole working set is
 * returned, grouped by page so each page's sections stay contiguous and ordered.
 */
export async function getWorkingSet(pageId?: string): Promise<SectionWithItems[]> {
  const db = getDb();
  const query = db<SectionRow>(SECTIONS).select("*");
  if (pageId !== undefined) query.where({ page_id: pageId });
  const sections = await query.orderBy([
    { column: "page_id", order: "asc" },
    { column: "position", order: "asc" },
    { column: "created_at", order: "asc" },
  ]);
  const items = await db<SectionItemRow>(SECTION_ITEMS)
    .select("*")
    .orderBy([
      { column: "position", order: "asc" },
      { column: "created_at", order: "asc" },
    ]);

  const bySection = new Map<string, SectionItemRow[]>();
  for (const item of items) {
    const list = bySection.get(item.section_id) ?? [];
    list.push(item);
    bySection.set(item.section_id, list);
  }

  return sections.map((s) => ({ ...s, items: bySection.get(s.id) ?? [] }));
}

// ---- Create section (§4.2 POST /api/admin/sections) -------------------------

export interface CreateSectionInput {
  type: unknown;
  data?: unknown;
  is_hidden?: unknown;
  /** Owning page (§3.10, v1.1) — required. */
  page_id?: unknown;
}

export async function createSection(
  input: CreateSectionInput
): Promise<ServiceResult<SectionRow>> {
  if (!isKnownSectionType(input.type)) {
    return fail("validation", `Unknown section type "${String(input.type)}"`);
  }
  // Every section belongs to exactly one page (§3.10, v1.1): page_id is required
  // (400 without) and must reference an existing page (400 if it doesn't).
  if (!isUuid(input.page_id)) {
    return fail("bad_request", "page_id is required");
  }
  const validated = validateSectionData(input.type, input.data);
  if (!validated.ok) return validated;

  if (input.is_hidden !== undefined && typeof input.is_hidden !== "boolean") {
    return fail("validation", "is_hidden must be a boolean");
  }

  const db = getDb();
  const pageId = input.page_id as string;
  const page = await db(PAGES).where({ id: pageId }).first();
  if (!page) return fail("bad_request", `page ${pageId} does not exist`);

  // Position is per-page: append at the end of this page's order (§3.10).
  const position = await nextPosition(
    db<SectionRow>(SECTIONS).where({ page_id: pageId }),
    db
  );
  const [row] = await db<SectionRow>(SECTIONS)
    .insert({
      type: input.type,
      position,
      is_hidden: input.is_hidden === true,
      data: validated.data as never,
      page_id: pageId,
    })
    .returning("*");
  return ok(row);
}

// ---- Update section (§4.2 PATCH + §4.5 precondition) ------------------------

export interface UpdateSectionInput {
  expected_updated_at: string;
  data?: unknown;
  is_hidden?: unknown;
  /** Target page to MOVE this section to (§4.2 v1.1). */
  page_id?: unknown;
}

export async function updateSection(
  id: string,
  input: UpdateSectionInput
): Promise<ServiceResult<SectionRow>> {
  const hasData = input.data !== undefined;
  const hasHidden = input.is_hidden !== undefined;
  const hasPage = input.page_id !== undefined;
  if (!hasData && !hasHidden && !hasPage) {
    return fail(
      "bad_request",
      "Provide at least one of data, is_hidden, or page_id"
    );
  }
  if (hasHidden && typeof input.is_hidden !== "boolean") {
    return fail("validation", "is_hidden must be a boolean");
  }
  if (hasPage && !isUuid(input.page_id)) {
    return fail("validation", "page_id must be a page uuid");
  }

  const db = getDb();
  return db.transaction(async (trx) => {
    const row = await trx<SectionRow>(SECTIONS)
      .where({ id })
      .forUpdate()
      .first();
    if (!row) return fail<SectionRow>("not_found", "Section not found");

    if (!timestampsMatch(row.updated_at, input.expected_updated_at)) {
      // Stale precondition → 409, no write (§4.5).
      return fail<SectionRow>(
        "conflict",
        "Section changed since it was loaded (expected_updated_at mismatch)"
      );
    }

    const patch: Record<string, unknown> = { updated_at: trx.fn.now() };
    if (hasData) {
      const validated = validateSectionData(row.type, input.data);
      if (!validated.ok) return validated;
      patch.data = validated.data;
    }
    if (hasHidden) {
      patch.is_hidden = input.is_hidden as boolean;
    }

    // Move to another page (§4.2 v1.1): append at the end of the target page's
    // order, then close the gap left in the source page. A no-op self-move
    // (page_id equals the current page) skips the repositioning entirely.
    const targetPageId = input.page_id as string | undefined;
    const isMove = hasPage && targetPageId !== row.page_id;
    if (isMove) {
      const target = await trx(PAGES).where({ id: targetPageId }).first();
      if (!target) {
        return fail<SectionRow>("bad_request", `page ${targetPageId} does not exist`);
      }
      patch.page_id = targetPageId;
      patch.position = await nextPosition(
        trx<SectionRow>(SECTIONS).where({ page_id: targetPageId }),
        db
      );
    }

    const [updated] = await trx<SectionRow>(SECTIONS)
      .where({ id })
      .update(patch as never)
      .returning("*");

    if (isMove) {
      await resequencePage(trx, row.page_id);
    }
    return ok(updated);
  });
}

/**
 * Re-number a page's sections to a contiguous 0..n-1 `position` sequence,
 * preserving their current order. Used after a section moves out of a page so
 * the source page has no gap (§4.2 v1.1).
 */
async function resequencePage(
  trx: Knex.Transaction,
  pageId: string
): Promise<void> {
  const remaining = await trx<SectionRow>(SECTIONS)
    .where({ page_id: pageId })
    .orderBy([
      { column: "position", order: "asc" },
      { column: "created_at", order: "asc" },
    ])
    .forUpdate();
  for (let i = 0; i < remaining.length; i++) {
    if (remaining[i].position !== i) {
      await trx<SectionRow>(SECTIONS)
        .where({ id: remaining[i].id })
        .update({ position: i });
    }
  }
}

// ---- Delete section (§4.2 DELETE — cascades to items via FK) ----------------

export async function deleteSection(id: string): Promise<ServiceResult<null>> {
  const db = getDb();
  // ON DELETE CASCADE on section_items.section_id removes the children (§3.2).
  const count = await db<SectionRow>(SECTIONS).where({ id }).del();
  if (count === 0) return fail("not_found", "Section not found");
  return ok(null);
}

// ---- Reorder sections (§4.2 PUT /order — full array, txn, idempotent) -------

/**
 * Full-array reorder WITHIN a page (§4.2 v1.1 / §4.5). The client sends the
 * page's id and the complete ordered id array of THAT page's sections; each id's
 * `position` is set to its index inside one transaction. The array must be
 * exactly the current set of the page's section ids (same members, no
 * duplicates) so a stale array can't silently drop or duplicate a section, or
 * reach across pages. Idempotent; exempt from the `expected_updated_at`
 * precondition (§4.5).
 */
export async function reorderSections(
  pageId: unknown,
  order: string[]
): Promise<ServiceResult<SectionWithItems[]>> {
  if (!isUuid(pageId)) {
    return fail("bad_request", "page_id is required");
  }
  const db = getDb();
  return db.transaction(async (trx) => {
    const existing = await trx<SectionRow>(SECTIONS)
      .where({ page_id: pageId })
      .select("id")
      .forUpdate();
    const check = validateReorderArray(order, existing.map((r) => r.id));
    if (check) return fail<SectionWithItems[]>(check.code, check.message);

    for (let i = 0; i < order.length; i++) {
      await trx<SectionRow>(SECTIONS)
        .where({ id: order[i], page_id: pageId })
        .update({ position: i });
    }
    return ok(await getWorkingSetTrx(trx, pageId as string));
  });
}

// ---- Create item (§4.2 POST /api/admin/sections/:id/items) ------------------

export interface CreateItemInput {
  data?: unknown;
  is_hidden?: unknown;
}

export async function createItem(
  sectionId: string,
  input: CreateItemInput
): Promise<ServiceResult<SectionItemRow>> {
  if (input.is_hidden !== undefined && typeof input.is_hidden !== "boolean") {
    return fail("validation", "is_hidden must be a boolean");
  }
  const db = getDb();
  const section = await db<SectionRow>(SECTIONS)
    .where({ id: sectionId })
    .first();
  if (!section) return fail("not_found", "Section not found");

  const validated = validateItemData(section.type, input.data);
  if (!validated.ok) return validated;

  const position = await nextPosition(
    db<SectionItemRow>(SECTION_ITEMS).where({ section_id: sectionId }),
    db
  );
  const [row] = await db<SectionItemRow>(SECTION_ITEMS)
    .insert({
      section_id: sectionId,
      position,
      is_hidden: input.is_hidden === true,
      data: validated.data as never,
    })
    .returning("*");
  return ok(row);
}

// ---- Update item (§4.2 PATCH /api/admin/items/:id + §4.5) -------------------

export interface UpdateItemInput {
  expected_updated_at: string;
  data?: unknown;
  is_hidden?: unknown;
}

export async function updateItem(
  id: string,
  input: UpdateItemInput
): Promise<ServiceResult<SectionItemRow>> {
  const hasData = input.data !== undefined;
  const hasHidden = input.is_hidden !== undefined;
  if (!hasData && !hasHidden) {
    return fail("bad_request", "Provide at least one of data or is_hidden");
  }
  if (hasHidden && typeof input.is_hidden !== "boolean") {
    return fail("validation", "is_hidden must be a boolean");
  }

  const db = getDb();
  return db.transaction(async (trx) => {
    const row = await trx<SectionItemRow>(SECTION_ITEMS)
      .where({ id })
      .forUpdate()
      .first();
    if (!row) return fail<SectionItemRow>("not_found", "Item not found");

    if (!timestampsMatch(row.updated_at, input.expected_updated_at)) {
      return fail<SectionItemRow>(
        "conflict",
        "Item changed since it was loaded (expected_updated_at mismatch)"
      );
    }

    const patch: Record<string, unknown> = { updated_at: trx.fn.now() };
    if (hasData) {
      const section = await trx<SectionRow>(SECTIONS)
        .where({ id: row.section_id })
        .first();
      if (!section) return fail<SectionItemRow>("not_found", "Owning section not found");
      const validated = validateItemData(section.type, input.data);
      if (!validated.ok) return validated;
      patch.data = validated.data;
    }
    if (hasHidden) {
      patch.is_hidden = input.is_hidden as boolean;
    }

    const [updated] = await trx<SectionItemRow>(SECTION_ITEMS)
      .where({ id })
      .update(patch as never)
      .returning("*");
    return ok(updated);
  });
}

// ---- Delete item (§4.2 DELETE /api/admin/items/:id) -------------------------

export async function deleteItem(id: string): Promise<ServiceResult<null>> {
  const db = getDb();
  const count = await db<SectionItemRow>(SECTION_ITEMS).where({ id }).del();
  if (count === 0) return fail("not_found", "Item not found");
  return ok(null);
}

// ---- Reorder items (§4.2 PUT /api/admin/sections/:id/items/order) -----------

export async function reorderItems(
  sectionId: string,
  order: string[]
): Promise<ServiceResult<SectionItemRow[]>> {
  const db = getDb();
  return db.transaction(async (trx) => {
    const section = await trx<SectionRow>(SECTIONS)
      .where({ id: sectionId })
      .forUpdate()
      .first();
    if (!section) return fail<SectionItemRow[]>("not_found", "Section not found");

    const existing = await trx<SectionItemRow>(SECTION_ITEMS)
      .where({ section_id: sectionId })
      .select("id")
      .forUpdate();
    const check = validateReorderArray(order, existing.map((r) => r.id));
    if (check) return fail<SectionItemRow[]>(check.code, check.message);

    for (let i = 0; i < order.length; i++) {
      await trx<SectionItemRow>(SECTION_ITEMS)
        .where({ id: order[i], section_id: sectionId })
        .update({ position: i });
    }
    const items = await trx<SectionItemRow>(SECTION_ITEMS)
      .where({ section_id: sectionId })
      .orderBy([
        { column: "position", order: "asc" },
        { column: "created_at", order: "asc" },
      ]);
    return ok(items);
  });
}

// ---- Shared reorder validation ----------------------------------------------

/**
 * A reorder array must be the exact current id set: same length, no duplicates,
 * every provided id present, and no extra ids. Returns a failure descriptor or
 * null when valid.
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

async function getWorkingSetTrx(
  trx: Knex.Transaction,
  pageId?: string
): Promise<SectionWithItems[]> {
  const query = trx<SectionRow>(SECTIONS).select("*");
  if (pageId !== undefined) query.where({ page_id: pageId });
  const sections = await query.orderBy([
    { column: "page_id", order: "asc" },
    { column: "position", order: "asc" },
    { column: "created_at", order: "asc" },
  ]);
  const items = await trx<SectionItemRow>(SECTION_ITEMS)
    .select("*")
    .orderBy([
      { column: "position", order: "asc" },
      { column: "created_at", order: "asc" },
    ]);
  const bySection = new Map<string, SectionItemRow[]>();
  for (const item of items) {
    const list = bySection.get(item.section_id) ?? [];
    list.push(item);
    bySection.set(item.section_id, list);
  }
  return sections.map((s) => ({ ...s, items: bySection.get(s.id) ?? [] }));
}
