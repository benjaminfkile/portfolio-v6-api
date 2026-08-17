import { Knex } from "knex";

/**
 * Resume versions — task #92. The admin uploads resume PDFs (every version is
 * kept); the public site always serves the newest confirmed one.
 *
 * Resumes are deliberately NOT `media_assets` rows and live under their own
 * `resumes/{uuid}/{filename}` prefix in the existing bucket, so the §6.9 media
 * orphan sweep never touches them. Raw SQL matches the surrounding migrations'
 * style so the column types, defaults and index are pinned exactly.
 *
 * `uploaded_by` records who minted the upload URL — either an admin sub or the
 * `key:<name>` attribution used elsewhere (§4.5) — so the admin list can show
 * provenance for every retained version.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE resumes (
      id            uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      s3_key        text        NOT NULL UNIQUE,
      filename      text        NOT NULL,
      bytes         bigint      NOT NULL,
      confirmed_at  timestamptz,
      created_at    timestamptz NOT NULL DEFAULT now(),
      uploaded_by   text        NOT NULL
    );
  `);
  // Newest-first admin list + newest-confirmed public lookup both order by
  // created_at DESC; a partial index over the confirmed subset makes the
  // per-request public lookup a single index scan.
  await knex.raw(
    `CREATE INDEX idx_resumes_confirmed_created_at ON resumes (created_at DESC)
       WHERE confirmed_at IS NOT NULL;`
  );
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS resumes;`);
}
