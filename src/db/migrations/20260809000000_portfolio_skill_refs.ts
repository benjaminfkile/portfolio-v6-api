import { Knex } from "knex";

/**
 * Skill Refs v1.8 — portfolio items REFERENCE skills items instead of carrying
 * their own pasted icon URLs (TECH_SPEC_V1.md §Skill Refs v1.8). The item schema
 * replaces `tech_icons: string[]` (bare, unvalidated image URLs) with
 * `skill_refs: string[]` (ordered `section_items.id` uuids of skills items), so
 * portfolio icons are enforced-by-construction to match the skills sphere.
 *
 * This data-only migration converts every existing portfolio item's legacy
 * `data.tech_icons` URL list into a `data.skill_refs` id list and DELETES
 * `tech_icons`. It follows the `20260806000000_remove_skills_proficiency`
 * data-only pattern (irreversible, documented no-op `down`).
 *
 * Matching is by NORMALIZED KEY, built from the skills items already in the DB:
 *   - a skill's `title` lowercased with non-alphanumerics stripped
 *     ("Node.js" → nodejs, "Microsoft SQL Server" → microsoftsqlserver), and
 *   - the cleaned filename stem of the skill's own `icon_source`
 *     (`react-original-wordmark@v2.17.0.svg` → react).
 * Each legacy URL's stem is cleaned identically and looked up; a small alias map
 * bridges known devicon-stem/title mismatches (csharp → C#, css3 → CSS, …) whose
 * target is then normalized exactly like a title. Unmatched URLs are dropped;
 * matches are deduped preserving first-seen order.
 *
 * Idempotent: items without a `tech_icons` key are left untouched, so a re-run
 * (already-converted rows carry `skill_refs`, not `tech_icons`) is a no-op.
 * Published-document snapshots are intentionally NOT rewritten — the public site
 * keeps a legacy `tech_icons` fallback render until Ben republishes.
 */

/** A title (or alias target) → its normalized index key. */
function normalizeTitle(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9]/g, "");
}

/**
 * Clean a devicon-style URL/filename to its normalized stem key: take the last
 * path segment, drop any query/hash, strip an `@version` suffix (and everything
 * after it, e.g. `@v2.17.0.svg`), strip the file extension, strip trailing
 * `-original|-plain|-line|-wordmark` variant suffixes (possibly several), then
 * lowercase and strip non-alphanumerics.
 */
function cleanStem(input: string): string {
  let s = input.split(/[?#]/)[0];
  s = s.substring(s.lastIndexOf("/") + 1);
  s = s.replace(/@.*$/, "");
  s = s.replace(/\.[a-z0-9]+$/i, "");
  s = s.replace(/(-(original|plain|line|wordmark))+$/i, "");
  return normalizeTitle(s);
}

/**
 * Known devicon-stem → skill-title mismatches. The stem key (already in cleaned,
 * normalized form) maps to the human title, which is then normalized like any
 * title so it matches a skill whose `title` produced the same key.
 */
const STEM_ALIASES: Record<string, string> = {
  csharp: "C#",
  cplusplus: "C++",
  css3: "CSS",
  nodejs: "Node.js",
  microsoftsqlserver: "Microsoft SQL Server",
  amazonwebservices: "Amazon Web Services",
};

export async function up(knex: Knex): Promise<void> {
  // Skills index: every item of every `skills` section, keyed by BOTH its
  // normalized title and its cleaned icon stem. First-seen wins on collision.
  const skillRows = await knex("section_items as si")
    .join("sections as s", "s.id", "si.section_id")
    .where("s.type", "skills")
    .select("si.id as id", "si.data as data");

  const index = new Map<string, string>();
  const addKey = (key: string, id: string): void => {
    if (key && !index.has(key)) index.set(key, id);
  };
  for (const row of skillRows) {
    const data = (row.data ?? {}) as Record<string, unknown>;
    const title = typeof data.title === "string" ? data.title : "";
    const iconSource = typeof data.icon_source === "string" ? data.icon_source : "";
    addKey(normalizeTitle(title), row.id as string);
    addKey(cleanStem(iconSource), row.id as string);
  }

  // Resolve one legacy icon URL to a skills item id (or null if unmatched).
  const resolve = (url: string): string | null => {
    let key = cleanStem(url);
    if (Object.prototype.hasOwnProperty.call(STEM_ALIASES, key)) {
      key = normalizeTitle(STEM_ALIASES[key]);
    }
    return index.get(key) ?? null;
  };

  // Convert every portfolio item's tech_icons → skill_refs.
  const portfolioRows = await knex("section_items as si")
    .join("sections as s", "s.id", "si.section_id")
    .where("s.type", "portfolio")
    .select("si.id as id", "si.data as data");

  for (const row of portfolioRows) {
    const data = { ...((row.data ?? {}) as Record<string, unknown>) };
    // Idempotent: an item with no legacy `tech_icons` (never had one, or already
    // converted) is left exactly as-is.
    if (!Array.isArray(data.tech_icons)) continue;

    const refs: string[] = [];
    const seen = new Set<string>();
    for (const entry of data.tech_icons as unknown[]) {
      if (typeof entry !== "string") continue;
      const id = resolve(entry);
      if (id && !seen.has(id)) {
        seen.add(id);
        refs.push(id);
      }
    }

    data.skill_refs = refs;
    delete data.tech_icons;
    await knex("section_items")
      .where({ id: row.id })
      .update({ data: data as never });
  }
}

export async function down(): Promise<void> {
  // No-op: the original `tech_icons` URLs are discarded and unrecoverable (the
  // ids in `skill_refs` do not carry the source URL back). Matching the repo's
  // convention of an explicit, commented no-op `down` for irreversible data-only
  // migrations.
}
