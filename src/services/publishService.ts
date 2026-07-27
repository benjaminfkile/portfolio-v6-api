import { Knex } from "knex";
import { getDb } from "../db/db";
import {
  SECTION_DATA_SCHEMAS,
  ITEM_SCHEMAS,
  SECTION_TYPES,
  SectionType,
} from "../schemas";
import {
  SectionWithItems,
  getWorkingSet,
} from "./sectionsService";
import { resolveMediaMap, MediaRef } from "../utils/cdn";

/**
 * Publish pipeline — TECH_SPEC_V1.md §3.3, §3.9, §4.1, §4.2, §6.8.
 *
 * The `sections` + `section_items` tables are the always-draft working set. This
 * service snapshots that working set into `page_versions` (publish), serves the
 * latest snapshot to the public (`/api/content`), lists version history, restores
 * an old version (re-publish + working-set rebuild in one transaction), and
 * serializes the current draft in the exact `/api/content` shape (preview).
 *
 * Why snapshots (§3.3): publish is one INSERT of one document, so it is atomic by
 * construction; the public read is one row / one query; caching is a version
 * number; rollback is re-publishing an old document; the audit trail is inherent.
 * Retention is the most recent 50 versions, pruned beyond that.
 */

// ---- Result envelope (mirrors sectionsService) ------------------------------

export type PublishFailureCode = "not_found" | "validation" | "bad_request";

export type PublishResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: PublishFailureCode; message: string };

function fail<T>(code: PublishFailureCode, message: string): PublishResult<T> {
  return { ok: false, code, message };
}

function ok<T>(data: T): PublishResult<T> {
  return { ok: true, data };
}

// ---- Document shapes --------------------------------------------------------

/** A serialized item inside a published/draft document — §4.1. */
export interface SerializedItem {
  id: string;
  data: Record<string, unknown>;
}

/** A serialized section inside a published/draft document — §4.1. */
export interface SerializedSection {
  id: string;
  type: SectionType;
  data: Record<string, unknown>;
  items: SerializedItem[];
}

/**
 * The stored `page_versions.document`. References media by id and carries a
 * lookup map of `media_id → s3_key` (§6.8) — never absolute URLs, so the
 * document stays domain-agnostic. `version`/`published_at` are echoed inside the
 * document as well as held in their own columns.
 */
export interface PageDocument {
  version: number;
  published_at: string | null;
  sections: SerializedSection[];
  media: Record<string, string>;
}

/**
 * The read-time `/api/content` (and preview) response shape: the document with
 * its `media` map resolved to absolute CDN URLs (§6.8). Media *within* section /
 * item `data` is still referenced by id; the resolved `media` map is how a
 * consumer turns those ids into URLs.
 */
export interface ContentResponse {
  version: number;
  published_at: string | null;
  sections: SerializedSection[];
  media: Record<string, MediaRef>;
}

const SECTIONS = "sections";
const SECTION_ITEMS = "section_items";
const PAGE_VERSIONS = "page_versions";
const MEDIA_ASSETS = "media_assets";

/** Retention: keep the most recent N versions, prune beyond (§3.3). */
export const VERSION_RETENTION = 50;

// ---- Media id collection (§6.8) ---------------------------------------------

/**
 * Every media reference in the content model is a UUID stored under a key whose
 * name ends in `media_id` — `background_media_id` on the hero section, `media_id`
 * on timeline/portfolio items. Collecting by key suffix (rather than hard-coding
 * each path) means a new media-bearing field is covered automatically once its
 * schema lands. Non-UUID / empty values are ignored.
 */
function collectMediaIds(value: unknown, acc: Set<string>): void {
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

// ---- Validation of the whole working set (§3.9) -----------------------------

function isKnownSectionType(type: unknown): type is SectionType {
  return (
    typeof type === "string" && (SECTION_TYPES as readonly string[]).includes(type)
  );
}

/**
 * Re-validate the ENTIRE working set against the canonical Zod schemas (§3.9) —
 * hidden sections and items included — and, on success, serialize only the
 * VISIBLE content into the snapshot. A single validation failure anywhere refuses
 * the whole publish: invalid content can reach a draft but must never reach
 * production. Hidden rows (`is_hidden`) are still validated (a hidden-but-invalid
 * section blocks publish) but are excluded from the serialized document, which
 * carries exactly `{ id, type, data, items }` — no `is_hidden` — because the
 * public site never renders hidden content (§4.1 shape). The stored `data` is the
 * Zod-parsed value, so the snapshot holds exactly what the schema admits.
 */
function validateWorkingSet(
  sections: SectionWithItems[]
): PublishResult<SerializedSection[]> {
  const serialized: SerializedSection[] = [];
  for (const section of sections) {
    if (!isKnownSectionType(section.type)) {
      return fail(
        "validation",
        `Unknown section type "${String(section.type)}" (section ${section.id})`
      );
    }
    const sectionSchema = SECTION_DATA_SCHEMAS[section.type];
    const parsedSection = sectionSchema.safeParse(section.data ?? {});
    if (!parsedSection.success) {
      return fail(
        "validation",
        `Invalid data for section ${section.id} (${section.type}): ${parsedSection.error.message}`
      );
    }

    const itemSchema = ITEM_SCHEMAS[section.type as keyof typeof ITEM_SCHEMAS];
    const items: SerializedItem[] = [];
    for (const item of section.items) {
      if (!itemSchema) {
        // A row exists under a section type that bears no items — malformed
        // working set; refuse rather than silently drop it.
        return fail(
          "validation",
          `Section type "${section.type}" does not support items but item ${item.id} exists`
        );
      }
      const parsedItem = itemSchema.safeParse(item.data ?? {});
      if (!parsedItem.success) {
        return fail(
          "validation",
          `Invalid data for item ${item.id} (${section.type}): ${parsedItem.error.message}`
        );
      }
      if (!item.is_hidden) {
        items.push({ id: item.id, data: parsedItem.data as Record<string, unknown> });
      }
    }

    if (!section.is_hidden) {
      serialized.push({
        id: section.id,
        type: section.type,
        data: parsedSection.data as Record<string, unknown>,
        items,
      });
    }
  }
  return ok(serialized);
}

// ---- Media key map (§6.8) ---------------------------------------------------

/**
 * Build the `media_id → s3_key` lookup for every media id referenced by the
 * serialized sections. Unknown ids (no `media_assets` row) are simply absent
 * from the map — a dangling reference resolves to nothing rather than a broken
 * URL, and the publish is not blocked by it.
 */
async function buildMediaKeyMap(
  qb: Knex,
  sections: SerializedSection[]
): Promise<Record<string, string>> {
  const ids = new Set<string>();
  collectMediaIds(sections, ids);
  if (ids.size === 0) return {};

  const rows = await qb<{ id: string; s3_key: string; alt: string | null }>(
    MEDIA_ASSETS
  )
    .whereIn("id", Array.from(ids))
    .select("id", "s3_key", "alt");

  const map: Record<string, string> = {};
  for (const row of rows) {
    map[row.id] = row.s3_key;
  }
  return map;
}

/** Read-time alt lookup for a set of media ids (deleted rows resolve to null). */
async function fetchAlts(
  qb: Knex,
  ids: string[]
): Promise<Record<string, string | null>> {
  if (ids.length === 0) return {};
  const rows = await qb<{ id: string; alt: string | null }>(MEDIA_ASSETS)
    .whereIn("id", ids)
    .select("id", "alt");
  const map: Record<string, string | null> = {};
  for (const row of rows) map[row.id] = row.alt;
  return map;
}

// ---- Publish (§3.3, §4.2 POST /api/admin/publish) ---------------------------

export interface PublishedVersion {
  version: number;
  published_at: string;
  document: PageDocument;
}

async function maxVersion(qb: Knex): Promise<number> {
  const row = await qb(PAGE_VERSIONS).max<{ max: number | null }[]>("version as max").first();
  const max = (row as unknown as { max: number | null })?.max;
  return max === null || max === undefined ? 0 : Number(max);
}

/**
 * Prune retained versions to the most recent {@link VERSION_RETENTION} (§3.3).
 * The keep-set is computed by version desc so it is correct regardless of any
 * gaps left by earlier pruning.
 */
async function pruneVersions(trx: Knex.Transaction): Promise<void> {
  const keep = trx(PAGE_VERSIONS)
    .select("version")
    .orderBy("version", "desc")
    .limit(VERSION_RETENTION);
  await trx(PAGE_VERSIONS).whereNotIn("version", keep).del();
}

/**
 * POST /api/admin/publish (§4.2). Validates the entire working set (§3.9), and
 * on success snapshots it into `page_versions` as `version = max + 1`, records
 * `published_by`, and prunes to the most recent 50. No optimistic-concurrency
 * precondition — publish snapshots whatever the working set is at that moment
 * (§4.5), and preview exists to check that state first.
 */
export async function publish(
  publishedBy: string,
  publishedAt: string = new Date().toISOString()
): Promise<PublishResult<PublishedVersion>> {
  const workingSet = await getWorkingSet();
  const validated = validateWorkingSet(workingSet);
  if (!validated.ok) return validated;

  const db = getDb();
  return db.transaction(async (trx) => {
    const media = await buildMediaKeyMap(trx as unknown as Knex, validated.data);
    const version = (await maxVersion(trx as unknown as Knex)) + 1;
    const document: PageDocument = {
      version,
      published_at: publishedAt,
      sections: validated.data,
      media,
    };

    await trx(PAGE_VERSIONS).insert({
      version,
      document: document as never,
      published_at: publishedAt,
      published_by: publishedBy,
    });

    await pruneVersions(trx);

    return ok<PublishedVersion>({ version, published_at: publishedAt, document });
  });
}

// ---- Public content (§4.1 GET /api/content) ---------------------------------

/**
 * Resolve the latest published document into the `/api/content` response shape,
 * with the `media` map's keys resolved to absolute CDN URLs (§6.8). Returns the
 * empty-state document (version 0, no sections) when nothing was ever published,
 * so the public site renders an empty page rather than a 404 (§4.1).
 */
export async function getLatestContent(cdnDomain: string): Promise<ContentResponse> {
  const db = getDb();
  const row = await db<{ version: number; document: PageDocument; published_at: Date }>(
    PAGE_VERSIONS
  )
    .orderBy("version", "desc")
    .first();

  if (!row) {
    return { version: 0, published_at: null, sections: [], media: {} };
  }

  const doc = row.document;
  const keyMap = doc.media ?? {};
  const alts = await fetchAlts(db, Object.keys(keyMap));
  return {
    version: doc.version,
    published_at: doc.published_at,
    sections: doc.sections,
    media: resolveMediaMap(cdnDomain, keyMap, alts),
  };
}

// ---- Version history (§4.2 GET /api/admin/versions) -------------------------

export interface VersionSummary {
  version: number;
  published_at: string;
  published_by: string;
}

/** GET /api/admin/versions — the version history, newest first (§4.2). */
export async function listVersions(): Promise<VersionSummary[]> {
  const db = getDb();
  const rows = await db<{ version: number; published_at: Date; published_by: string }>(
    PAGE_VERSIONS
  )
    .select("version", "published_at", "published_by")
    .orderBy("version", "desc");
  return rows.map((r) => ({
    version: r.version,
    published_at: new Date(r.published_at).toISOString(),
    published_by: r.published_by,
  }));
}

// ---- Restore (§4.2 POST /api/admin/versions/:v/restore) ---------------------

/**
 * Restore version `v` (§4.2). In ONE transaction: re-publish version `v`'s
 * document as a NEW version (the live site changes immediately) AND replace the
 * entire working set — `sections` / `section_items` are deleted and rebuilt from
 * the restored document. The rebuild is not optional: without it the admin would
 * still hold the newer draft, and the next publish would silently undo the
 * restore. Unpublished edits are therefore lost on restore (the admin UI warns
 * and confirms before calling this). Media referenced only by the discarded
 * draft simply becomes unreferenced and is handled by the normal GC pass (§6.9).
 */
export async function restoreVersion(
  v: number,
  publishedBy: string,
  publishedAt: string = new Date().toISOString()
): Promise<PublishResult<PublishedVersion>> {
  if (!Number.isInteger(v)) {
    return fail("bad_request", "version must be an integer");
  }

  const db = getDb();
  return db.transaction(async (trx) => {
    const source = await trx<{ version: number; document: PageDocument }>(PAGE_VERSIONS)
      .where({ version: v })
      .first();
    if (!source) {
      return fail<PublishedVersion>("not_found", `Version ${v} not found`);
    }

    const restored = source.document;
    const newVersion = (await maxVersion(trx as unknown as Knex)) + 1;
    const document: PageDocument = {
      version: newVersion,
      published_at: publishedAt,
      sections: restored.sections ?? [],
      media: restored.media ?? {},
    };

    // 1. Re-publish as a new version — the live site flips immediately.
    await trx(PAGE_VERSIONS).insert({
      version: newVersion,
      document: document as never,
      published_at: publishedAt,
      published_by: publishedBy,
    });

    // 2. Rebuild the working set from the restored document. Delete-then-insert;
    //    section_items cascade away with their parent sections.
    await trx(SECTION_ITEMS).del();
    await trx(SECTIONS).del();

    for (let i = 0; i < document.sections.length; i++) {
      const section = document.sections[i];
      await trx(SECTIONS).insert({
        id: section.id,
        type: section.type,
        position: i,
        is_hidden: false,
        data: section.data as never,
      });
      for (let j = 0; j < section.items.length; j++) {
        const item = section.items[j];
        await trx(SECTION_ITEMS).insert({
          id: item.id,
          section_id: section.id,
          position: j,
          is_hidden: false,
          data: item.data as never,
        });
      }
    }

    await pruneVersions(trx);

    return ok<PublishedVersion>({
      version: newVersion,
      published_at: publishedAt,
      document,
    });
  });
}

// ---- Draft preview (§4.2 GET /api/admin/preview) ----------------------------

/**
 * Serialize the current DRAFT working set in exactly the `/api/content` shape
 * (§4.2 / §7) — the public site renders it through its normal component tree
 * inside the preview iframe. `version` is null and `published_at` is null because
 * a draft is not a published version; every other key matches the content shape,
 * including the `media` map resolved to absolute CDN URLs (§6.8).
 *
 * The draft is NOT re-validated here — invalid content can exist in a draft and
 * the author must be able to preview it before the publish-time validation
 * refuses it (§3.9). Serialization mirrors the publish serializer's shape.
 */
export async function getDraftContent(cdnDomain: string): Promise<{
  version: null;
  published_at: null;
  sections: SerializedSection[];
  media: Record<string, MediaRef>;
}> {
  const workingSet = await getWorkingSet();
  // Filter hidden sections/items exactly as publish does, so the preview matches
  // what visitors will see through /api/content (§4.1 shape). The draft is not
  // re-validated (§3.9) — invalid drafts must still be previewable.
  const sections: SerializedSection[] = workingSet
    .filter((s) => !s.is_hidden)
    .map((s) => ({
      id: s.id,
      type: s.type,
      data: s.data,
      items: s.items
        .filter((item) => !item.is_hidden)
        .map((item) => ({ id: item.id, data: item.data })),
    }));

  const keyMap = await buildMediaKeyMap(getDb(), sections);
  const alts = await fetchAlts(getDb(), Object.keys(keyMap));
  return {
    version: null,
    published_at: null,
    sections,
    media: resolveMediaMap(cdnDomain, keyMap, alts),
  };
}
