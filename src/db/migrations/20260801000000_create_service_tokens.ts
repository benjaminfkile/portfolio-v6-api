import { Knex } from "knex";

/**
 * `service_tokens` — encrypted per-service credentials written by the admin
 * reconnect flows (currently only Spotify, §4.6).
 *
 * Spotify's June 2026 policy change expires user refresh tokens 180 days after
 * the original authorization, so the token can no longer be a set-and-forget
 * secret: the admin "reconnect" flow re-authorizes in the browser and the API
 * stores the freshly minted refresh token here. The token is stored ONLY as
 * AES-256-GCM ciphertext (see src/services/spotifyTokenStore.ts) so a database
 * dump alone never reveals it; `authorized_at` records when the user authorized
 * so the admin UI can show when the 180-day window ends.
 *
 * Keyed by `service` (one row per integration) rather than a Spotify-specific
 * table so a future integration reuses the same shape.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE service_tokens (
      service          text        PRIMARY KEY,
      token_ciphertext text        NOT NULL,
      authorized_at    timestamptz NOT NULL DEFAULT now(),
      updated_at       timestamptz NOT NULL DEFAULT now()
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS service_tokens;`);
}
