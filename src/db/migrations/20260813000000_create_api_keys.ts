import { Knex } from "knex";

/**
 * API Keys v1.16 — dashboard-minted API keys that replace the (never-activated)
 * Cognito client-credentials machine path from Machine Auth v1.15. Consuming apps
 * (the external posting bot) authenticate with a first-class API key minted from
 * the admin dashboard, so they need zero Cognito/AWS dependencies.
 *
 * Raw, additive SQL so the column types, defaults, and the UNIQUE index match the
 * contract exactly. `gen_random_uuid()` comes from pgcrypto, enabled by the
 * initial migration.
 *
 * A key is `pv6k_` + 32 random bytes base64url. Only its SHA-256 hash is stored
 * (`key_hash`, UNIQUE — the hash is the credential equalizer used for the lookup);
 * `key_prefix` holds the first 12 chars for display. The full key is returned
 * exactly ONCE, in the mint response, and is never retrievable again.
 * `last_used_at` is stamped fire-and-forget on each accepted request; `revoked_at`
 * is set (idempotently) when a key is revoked — an active key is `revoked_at IS
 * NULL`.
 */
export async function up(knex: Knex): Promise<void> {
  await knex.raw(`
    CREATE TABLE api_keys (
      id           uuid        PRIMARY KEY DEFAULT gen_random_uuid(),
      name         text        NOT NULL,
      key_prefix   text        NOT NULL,
      key_hash     text        NOT NULL UNIQUE,
      created_at   timestamptz NOT NULL DEFAULT now(),
      last_used_at timestamptz NULL,
      revoked_at   timestamptz NULL
    );
  `);
}

export async function down(knex: Knex): Promise<void> {
  await knex.raw(`DROP TABLE IF EXISTS api_keys;`);
}
