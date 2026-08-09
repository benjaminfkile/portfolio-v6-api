import { Knex } from "knex";

/**
 * GitHub Explorer v1.10 — the `github` section is now fully browsable: the client
 * always renders the full returned window and offers a year picker, so the v1.2
 * `weeks` config (how many trailing weeks to render) is obsolete
 * (TECH_SPEC_V1.md §3.5, task #580). The `githubData` schema is now
 * `{ heading?, intro? }` and `.strict()`, so any stored `github` section still
 * carrying `weeks` would fail admin writes AND publish for that draft.
 *
 * This data-only migration strips the removed `weeks` key from every `github`
 * section's JSONB `data`, keeping `heading`/`intro` intact. Same class of
 * data-strip as the ops `window_hours` strip
 * (`20260807000000_create_ops_reports`) and the skills `proficiency` strip
 * (`20260806000000_remove_skills_proficiency`), scoped to `github` sections only.
 *
 * Published-document snapshots are intentionally NOT rewritten: the next publish
 * regenerates them, and public reads of an older snapshot that still contains
 * `weeks` are harmless (the public site ignores unknown keys).
 */
export async function up(knex: Knex): Promise<void> {
  // `jsonb_exists(data, 'weeks')` rather than the `?` operator: knex.raw treats a
  // bare `?` as a positional bind placeholder, so the function form keeps the
  // existence check while staying a single parameterless statement.
  await knex.raw(`
    UPDATE sections
       SET data = data - 'weeks'
     WHERE type = 'github'
       AND jsonb_exists(data, 'weeks');
  `);
}

export async function down(): Promise<void> {
  // No-op: the stripped `weeks` values are unrecoverable. Matching the repo's
  // convention of an explicit, commented no-op down for data-only migrations
  // that cannot be reversed.
}
