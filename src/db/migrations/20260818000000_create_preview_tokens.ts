import { Knex } from "knex";

/**
 * `preview_tokens` — task #105. The admin's preview iframe (§7) mints a
 * 15-minute opaque token; the public site fetches use it to read draft-only
 * content. The store used to be a per-container in-memory Map, which was fine
 * while the API ran as one container but broke ~50% of preview fetches once
 * the gateway fleet went multi-instance (2026-08-17): a token minted on
 * instance A does not exist on instance B, so every fetch that round-robins
 * to the other node returned 401 and the preview page fell back to published
 * content. The fix follows the same shared-record-is-authoritative philosophy
 * used by the Spotify suspension work (task #97) — any instance validates any
 * token by looking up a shared row.
 *
 * We store `token_hash` (sha256 hex of the raw token) as the primary key, so
 * a database dump alone never leaks a usable preview URL; the raw token only
 * ever exists in memory of the minting request and in the caller's browser.
 * `expires_at` is enforced at read time; expired rows are cleaned up
 * opportunistically on mint / on a failed lookup — no background timer needed
 * at this volume.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE preview_tokens (
      token_hash text        PRIMARY KEY,
      expires_at timestamptz NOT NULL,
      created_at timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS preview_tokens;`);
}
