import { Knex } from "knex";

/**
 * Ops Replay v1.7 — the public ops page changes from a live trailing window to a
 * DAILY REPLAY (TECH_SPEC_V1.md §3.5, DESIGN.md §5). This migration does two
 * things:
 *
 * 1. Creates `ops_reports` — one immutable report per UTC day. `report_date` (a
 *    `date`, the UTC day the report covers) is the primary key so a day can be
 *    built at most once; `generated_at` records when it was built; `payload`
 *    holds the full widget-shaped report (288-point time series, curated exactly
 *    as the live path did). NO infra identifier is ever stored in `payload` —
 *    the same allowlist stance as the live path (§3.5).
 *
 * 2. Strips the now-removed `window_hours` key from existing `ops` sections'
 *    JSONB `data`. The section-`data` schema is `.strict()`, so any stored `ops`
 *    section still carrying `window_hours` would fail admin writes AND publish
 *    for that draft; the end state of `opsData` is `{ heading?, intro? }`. Same
 *    class of data-strip as the proficiency strip
 *    (`20260806000000_remove_skills_proficiency`), scoped to `ops` sections only.
 *
 * Raw SQL (like the other §3.2 migrations) so the column types/defaults match
 * the spec's schema block verbatim.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE ops_reports (
      report_date   date        PRIMARY KEY,
      generated_at  timestamptz NOT NULL,
      payload       jsonb       NOT NULL
    );
  `);

  // Strip the removed `window_hours` key from every `ops` section's data.
  // `jsonb_exists(data, 'window_hours')` rather than the `?` operator: knex.raw
  // treats a bare `?` as a positional bind placeholder, so the function form
  // keeps the existence check while staying a single parameterless statement.
  await knex.raw(`
    UPDATE sections
       SET data = data - 'window_hours'
     WHERE type = 'ops'
       AND jsonb_exists(data, 'window_hours');
  `);
}

export async function down(knex: Knex): Promise<void> {
  // Dropping the table is reversible; the `window_hours` strip is NOT — the
  // stripped values are unrecoverable, so the data half is a documented no-op
  // (matching the repo's convention for irreversible data-only migrations).
  await knex.raw(`DROP TABLE IF EXISTS ops_reports;`);
}
