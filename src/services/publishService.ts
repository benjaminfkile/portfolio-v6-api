import { Knex } from "knex";
import { getDb } from "../db/db";
import {
  SECTION_DATA_SCHEMAS,
  ITEM_SCHEMAS,
  SECTION_TYPES,
  SectionType,
  pageSchema,
} from "../schemas";
import { SectionWithItems, getWorkingSet } from "./sectionsService";
import { listPages, PageRow } from "./pagesService";
import { getBlogSlugs } from "./blogsService";
import { getAllPostIds, resolvePublishedPostRefs } from "./postsService";
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

export type PublishFailureCode =
  | "not_found"
  | "validation"
  | "bad_request"
  // The working set is well-formed but a portfolio item's `skill_refs` points at
  // a skills item that does not resolve to a visible skill (§Skill Refs v1.8).
  // Distinct from `validation` so the router can map it to 422 (unprocessable)
  // rather than 400 (malformed) — the content is valid, the reference is not.
  | "ref_validation";

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
 * A serialized page inside a published/draft document — §3.10 / §4.1. Carries the
 * page's identity + nav metadata and its ordered, VISIBLE sections. `nav_label`
 * is null for a page that is served at its slug but absent from the nav (§3.10).
 */
export interface SerializedPage {
  id: string;
  slug: string;
  title: string;
  nav_label: string | null;
  nav_position: number;
  sections: SerializedSection[];
}

/**
 * The stored `page_versions.document` (v1.1 pages shape, §3.10). References media
 * by id and carries a lookup map of `media_id → s3_key` (§6.8) — never absolute
 * URLs, so the document stays domain-agnostic. `version`/`published_at` are
 * echoed inside the document as well as held in their own columns.
 */
export interface PageDocument {
  version: number;
  published_at: string | null;
  pages: SerializedPage[];
  media: Record<string, string>;
}

/**
 * A pre-v1.1 stored document (§3.10 back-compat): a flat top-level `sections`
 * array instead of `pages`. Only encountered when restoring / serving a version
 * published before the pages model landed; normalized into a single `home` page.
 */
export interface LegacyPageDocument {
  version: number;
  published_at: string | null;
  sections: SerializedSection[];
  media: Record<string, string>;
}

type StoredDocument = PageDocument | LegacyPageDocument;

/**
 * The read-time `/api/content` (and preview) response shape (§4.1): the document
 * with its `media` map resolved to absolute CDN URLs (§6.8). Media *within*
 * section / item `data` is still referenced by id; the resolved `media` map is
 * how a consumer turns those ids into URLs.
 */
export interface ContentResponse {
  version: number;
  published_at: string | null;
  pages: SerializedPage[];
  media: Record<string, MediaRef>;
}

const PAGES = "pages";

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

// ---- Skill-ref resolution (§Skill Refs v1.8) --------------------------------

/**
 * The set of skills `section_items.id`s a portfolio `skill_refs` entry is allowed
 * to reference: every NON-HIDDEN item of a NON-HIDDEN `skills` section, across
 * ALL pages (skills sections may live on any page). A ref to a hidden item, an
 * item of a hidden skills section, or a non-existent id is not in this set and
 * blocks publish. Built once from the entire working set before per-page
 * validation, since a portfolio item on one page may legitimately reference a
 * skill on another.
 */
function collectVisibleSkillItemIds(workingSet: SectionWithItems[]): Set<string> {
  const ids = new Set<string>();
  for (const section of workingSet) {
    if (section.type !== "skills" || section.is_hidden) continue;
    for (const item of section.items) {
      if (!item.is_hidden) ids.add(item.id);
    }
  }
  return ids;
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
  sections: SectionWithItems[],
  visibleSkillItemIds: Set<string>,
  existingBlogSlugs: Set<string>,
  existingPostIds: Set<string>
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

    // Blogs v1.13: a `blog` section may pin itself to one named blog via
    // `data.blog` (a slug). Draft-lenient accepts any string; at publish the slug
    // must resolve to an existing blog. A dangling reference is a `ref_validation`
    // (→ 422 naming the section), distinct from malformed content (400).
    if (section.type === "blog") {
      const blogSlug = (parsedSection.data as { blog?: unknown }).blog;
      if (
        typeof blogSlug === "string" &&
        blogSlug.length > 0 &&
        !existingBlogSlugs.has(blogSlug)
      ) {
        return fail(
          "ref_validation",
          `Blog section ${section.id} references blog "${blogSlug}" which does not exist`
        );
      }
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

      // Skill Refs v1.8 enforcement gate: every `skill_refs` entry on a portfolio
      // item must resolve to a visible skills item (non-hidden item of a
      // non-hidden skills section). A dangling or hidden ref is a named issue
      // (portfolio item title + offending id) that 422s the publish. Hidden
      // portfolio items are checked too — a hidden-but-invalid item still blocks.
      if (section.type === "portfolio") {
        const data = parsedItem.data as {
          title?: unknown;
          skill_refs?: unknown;
          post_refs?: unknown;
        };
        const refs = Array.isArray(data.skill_refs) ? data.skill_refs : [];
        const title = typeof data.title === "string" ? data.title : item.id;
        for (const ref of refs) {
          if (!visibleSkillItemIds.has(ref as string)) {
            return fail(
              "ref_validation",
              `Portfolio item "${title}" references skill "${ref}" which does not resolve to a visible skills item`
            );
          }
        }

        // Post Refs v1.14 enforcement gate: every `post_refs` entry must exist in
        // the `posts` table. A ref to a deleted/unknown post id is a named issue
        // (portfolio item title + offending id) that 422s the publish. A ref to an
        // existing-but-UNPUBLISHED post is valid — it simply resolves to nothing
        // at read until the post publishes; documents stay id-based, resolution is
        // deferred to read time so a later publish/unpublish never drifts.
        const postRefs = Array.isArray(data.post_refs) ? data.post_refs : [];
        for (const ref of postRefs) {
          if (!existingPostIds.has(ref as string)) {
            return fail(
              "ref_validation",
              `Portfolio item "${title}" references post "${ref}" which does not exist`
            );
          }
        }
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

// ---- Pages: grouping, validation, and legacy normalization (§3.10) ----------

/**
 * Group a flat working set (§4.2, ordered by page then position) into a
 * `page_id → sections` map. Insertion order preserves each page's `position`
 * ordering because the working set already arrives sorted within a page.
 */
function groupSectionsByPage(
  workingSet: SectionWithItems[]
): Map<string, SectionWithItems[]> {
  const byPage = new Map<string, SectionWithItems[]>();
  for (const section of workingSet) {
    const list = byPage.get(section.page_id) ?? [];
    list.push(section);
    byPage.set(section.page_id, list);
  }
  return byPage;
}

/** The page row projected into the shape the canonical `pageSchema` validates. */
function pageToValidatable(page: PageRow): Record<string, unknown> {
  return {
    slug: page.slug,
    title: page.title,
    nav_label: page.nav_label,
    nav_position: page.nav_position,
    is_hidden: page.is_hidden,
  };
}

/**
 * Publish-time page validation (§3.9 / §3.10) — "one level up" from sections.
 * Every page must satisfy the canonical `pageSchema` (valid slug/title/nav), at
 * least one non-hidden page must exist, and a page with slug `home` must exist —
 * a site with no home page cannot be published. Returns a validation failure (the
 * router maps it to 400) or `null` when the page set is publishable.
 */
function validatePages(pages: PageRow[]): PublishResult<null> | null {
  for (const page of pages) {
    const parsed = pageSchema.safeParse(pageToValidatable(page));
    if (!parsed.success) {
      return fail(
        "validation",
        `Invalid page ${page.id} (${page.slug}): ${parsed.error.message}`
      );
    }
  }
  if (!pages.some((p) => !p.is_hidden)) {
    return fail("validation", "at least one non-hidden page is required to publish");
  }
  if (!pages.some((p) => p.slug === "home")) {
    return fail("validation", "a page with slug 'home' is required to publish");
  }
  return null;
}

/**
 * Normalize a stored document to its `pages` array (§3.10 back-compat). A v1.1
 * document already carries `pages`. A pre-v1.1 document carries a flat top-level
 * `sections` array — wrap it into a single `home` page (slug `home`, title
 * `Home`, nav_label `Home`, nav_position 0) so read/restore paths only ever deal
 * with the pages shape. The nil UUID stands in for the legacy page's (absent) id.
 */
const NIL_UUID = "00000000-0000-0000-0000-000000000000";

function documentToPages(doc: StoredDocument): SerializedPage[] {
  if (Array.isArray((doc as PageDocument).pages)) {
    return (doc as PageDocument).pages;
  }
  const legacySections = (doc as LegacyPageDocument).sections ?? [];
  return [
    {
      id: NIL_UUID,
      slug: "home",
      title: "Home",
      nav_label: "Home",
      nav_position: 0,
      sections: legacySections,
    },
  ];
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
  content: unknown
): Promise<Record<string, string>> {
  const ids = new Set<string>();
  collectMediaIds(content, ids);
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

// ---- Post-ref read-time resolution (§Post Refs v1.14) -----------------------

/**
 * Walk every portfolio item across the serialized pages and inject a resolved
 * `posts` array beside its raw `post_refs` (§Post Refs v1.14). Resolution mirrors
 * how media ids resolve to CDN URLs at read: the stored document keeps only the
 * id-based `post_refs`, and `posts: [{id, slug, title, blog}]` is materialized
 * here so a post publish/unpublish after a site publish never drifts. Only
 * currently-published posts resolve; input order is preserved and
 * unpublished/deleted refs are silently omitted.
 */
async function resolvePostRefsIntoPages(pages: SerializedPage[]): Promise<void> {
  const ids: string[] = [];
  const portfolioItems: Array<Record<string, unknown>> = [];
  for (const page of pages) {
    for (const section of page.sections) {
      if (section.type !== "portfolio") continue;
      for (const item of section.items) {
        const data = item.data as Record<string, unknown>;
        portfolioItems.push(data);
        const refs = data.post_refs;
        if (Array.isArray(refs)) {
          for (const r of refs) if (typeof r === "string") ids.push(r);
        }
      }
    }
  }
  if (portfolioItems.length === 0) return;

  const resolved = await resolvePublishedPostRefs(ids);
  for (const data of portfolioItems) {
    const refs = data.post_refs;
    const list = Array.isArray(refs)
      ? (refs
          .map((r) => (typeof r === "string" ? resolved.get(r) : undefined))
          .filter((p) => p !== undefined) as unknown[])
      : [];
    data.posts = list;
  }
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
  // Validate one level up (§3.10): every page passes the canonical pageSchema, a
  // non-hidden page exists, and a `home` page exists.
  const pages = await listPages();
  const pageCheck = validatePages(pages);
  if (pageCheck) return pageCheck as PublishResult<PublishedVersion>;

  // Validate + serialize each page's sections. Hidden pages and hidden sections
  // are still validated (§3.9) but never serialized: only non-hidden pages, each
  // with its non-hidden sections, reach the document.
  const workingSet = await getWorkingSet();
  // Built from the ENTIRE working set (§Skill Refs v1.8): a portfolio item may
  // reference a skills item on a different page, so the allowed-ref set is global,
  // not per-page.
  const visibleSkillItemIds = collectVisibleSkillItemIds(workingSet);
  // Blogs v1.13: the set of existing blog slugs a `blog` section's `data.blog`
  // may reference. Built once before per-page validation (a blog section may
  // live on any page).
  const existingBlogSlugs = await getBlogSlugs();
  // Post Refs v1.14: the set of existing `posts.id`s a portfolio item's
  // `post_refs` may reference. Existence only — unpublished posts are valid refs.
  const existingPostIds = await getAllPostIds();
  const byPage = groupSectionsByPage(workingSet);
  const serializedPages: SerializedPage[] = [];
  for (const page of pages) {
    const validated = validateWorkingSet(
      byPage.get(page.id) ?? [],
      visibleSkillItemIds,
      existingBlogSlugs,
      existingPostIds
    );
    if (!validated.ok) return validated;
    if (!page.is_hidden) {
      serializedPages.push({
        id: page.id,
        slug: page.slug,
        title: page.title,
        nav_label: page.nav_label,
        nav_position: page.nav_position,
        sections: validated.data,
      });
    }
  }

  const db = getDb();
  return db.transaction(async (trx) => {
    // Media collected across ALL serialized pages (§6.8, by media_id key suffix).
    const media = await buildMediaKeyMap(trx as unknown as Knex, serializedPages);
    const version = (await maxVersion(trx as unknown as Knex)) + 1;
    const document: PageDocument = {
      version,
      published_at: publishedAt,
      pages: serializedPages,
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
  const row = await db<{ version: number; document: StoredDocument; published_at: Date }>(
    PAGE_VERSIONS
  )
    .orderBy("version", "desc")
    .first();

  if (!row) {
    return { version: 0, published_at: null, pages: [], media: {} };
  }

  const doc = row.document;
  const keyMap = doc.media ?? {};
  const alts = await fetchAlts(db, Object.keys(keyMap));
  // A pre-v1.1 document (flat `sections`) is normalized to the pages shape so
  // /api/content never serves the legacy shape (§3.10 back-compat).
  const pages = documentToPages(doc);
  // Post Refs v1.14: resolve each portfolio item's `post_refs` to its currently
  // -published `posts` at READ time (the document stays id-based).
  await resolvePostRefsIntoPages(pages);
  return {
    version: doc.version,
    published_at: doc.published_at,
    pages,
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
    const source = await trx<{ version: number; document: StoredDocument }>(PAGE_VERSIONS)
      .where({ version: v })
      .first();
    if (!source) {
      return fail<PublishedVersion>("not_found", `Version ${v} not found`);
    }

    // Normalize the source to the pages shape (§3.10 back-compat): a v1.1
    // document already carries `pages`; a legacy flat document is wrapped into a
    // single `home` page. Either way the rebuild and the re-published document
    // are pages-shaped.
    const restored = source.document;
    const sourcePages = documentToPages(restored);
    const newVersion = (await maxVersion(trx as unknown as Knex)) + 1;

    // Rebuild the working set from the restored document. Delete-then-insert;
    // deleting pages cascades to sections and section_items.
    await trx(SECTION_ITEMS).del();
    await trx(SECTIONS).del();
    await trx(PAGES).del();

    const rebuiltPages: SerializedPage[] = [];
    for (const page of sourcePages) {
      // A v1.1 document carries real page ids — recreate the page with the same
      // id. A legacy-wrapped `home` page uses the nil-UUID placeholder, so let
      // the DB mint a fresh id instead of inserting the sentinel.
      const insertPage: Record<string, unknown> = {
        slug: page.slug,
        title: page.title,
        nav_label: page.nav_label,
        nav_position: page.nav_position,
        is_hidden: false,
      };
      if (page.id && page.id !== NIL_UUID) insertPage.id = page.id;
      const [pageRow] = await trx(PAGES).insert(insertPage as never).returning("id");
      const pageId = (pageRow as { id: string }).id;

      for (let i = 0; i < page.sections.length; i++) {
        const section = page.sections[i];
        await trx(SECTIONS).insert({
          id: section.id,
          type: section.type,
          position: i,
          is_hidden: false,
          data: section.data as never,
          page_id: pageId,
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

      rebuiltPages.push({
        id: pageId,
        slug: page.slug,
        title: page.title,
        nav_label: page.nav_label,
        nav_position: page.nav_position,
        sections: page.sections,
      });
    }

    // Re-publish as a new version — the live site flips immediately. The document
    // is emitted in the v1.1 pages shape even when restoring a legacy version.
    const document: PageDocument = {
      version: newVersion,
      published_at: publishedAt,
      pages: rebuiltPages,
      media: restored.media ?? {},
    };
    await trx(PAGE_VERSIONS).insert({
      version: newVersion,
      document: document as never,
      published_at: publishedAt,
      published_by: publishedBy,
    });

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
  pages: SerializedPage[];
  media: Record<string, MediaRef>;
}> {
  const pages = await listPages();
  const byPage = groupSectionsByPage(await getWorkingSet());

  // Filter hidden pages, sections, and items exactly as publish does, so the
  // preview matches what visitors will see through /api/content (§4.1 shape). The
  // draft is NOT re-validated (§3.9) — invalid drafts must still be previewable.
  const serializedPages: SerializedPage[] = pages
    .filter((p) => !p.is_hidden)
    .map((p) => ({
      id: p.id,
      slug: p.slug,
      title: p.title,
      nav_label: p.nav_label,
      nav_position: p.nav_position,
      sections: (byPage.get(p.id) ?? [])
        .filter((s) => !s.is_hidden)
        .map((s) => ({
          id: s.id,
          type: s.type,
          data: s.data,
          items: s.items
            .filter((item) => !item.is_hidden)
            .map((item) => ({ id: item.id, data: item.data })),
        })),
    }));

  const keyMap = await buildMediaKeyMap(getDb(), serializedPages);
  const alts = await fetchAlts(getDb(), Object.keys(keyMap));
  // Post Refs v1.14: resolve `post_refs` → `posts` at read, exactly as
  // /api/content does, so preview matches what visitors will see (§4.1 parity).
  await resolvePostRefsIntoPages(serializedPages);
  return {
    version: null,
    published_at: null,
    pages: serializedPages,
    media: resolveMediaMap(cdnDomain, keyMap, alts),
  };
}
