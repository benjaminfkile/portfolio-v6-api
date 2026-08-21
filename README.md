# portfolio-v6-api

Express + TypeScript API for **Portfolio v6** — serves published content to the public
site (`portfolio-v6`) and the full editing surface to the admin (`portfolio-v6-admin`).
Postgres via Knex, media on S3 behind a CDN, deployed as a Docker container behind the
gateway. The authoritative content-model spec is `TECH_SPEC_V1.md` in the `portfolio-v6`
repo; section references below (§…) point into it.

Base URL through the gateway (path prefix is stripped before it reaches this app):
`https://api.benkile.com/portfolio-v6-api`.

## Auth model (§5)

Four classes of route guard:

| Guard | Accepts | Notes |
|---|---|---|
| none | — | Public reads + `POST /api/beacon`. |
| `requireAdmin()` | Cognito **ID token** whose `cognito:groups` includes `admins` | 401 missing/invalid/expired token, **403** valid token without the group. No users table — identity is the token. Only the api-keys and integrations (incl. legacy `/spotify`) surfaces stay behind this — a machine key must never mint another key or read/write stored credentials. |
| `requireAdminOrMachine()` | Admin ID token **or** an API key (`Authorization: Bearer pv6k_…`) | Guards the full content-editing surface (pages, sections/items, posts, blogs, media, publish/versions/restore, preview-token, analytics, icons). Machine keys are minted/revoked in the admin (API Keys page). Only the SHA-256 hash is stored; `last_used_at` is stamped on use. Key-driven writes that record an actor persist it as `key:<name>`. A `pv6k_` bearer on a `requireAdmin()`-only route gets **401**. |
| `requireAdminOrPreviewToken()` | Admin ID token **or** a short-lived preview token (`?token=`, `?preview=`, or `X-Preview-Token`) | Tokens minted via `POST /api/admin/preview-token`, ~15 min, read-only. |

The two OAuth callback routes (`GET /api/admin/integrations/:key/callback` and the legacy
`GET /api/admin/spotify/callback`) carry no bearer — they are guarded by a single-use
10-minute `state` minted at connect time.

**Response envelope (§4.3):** admin routes wrap results as
`{ "status": "ok", "error": false, "data": { … } }`; errors everywhere are
`{ "status": "error", "error": true, "errorMsg": "…" }`. Public reads return the resource
**raw** (no envelope) — the one exception is `GET /api/health`, which uses the envelope.
Every `/api/admin/*` response is `Cache-Control: no-store`. Express's automatic ETag is
disabled; only `/api/content` and `/api/posts/:slug` set (weak) ETags by hand.

**Optimistic concurrency (§4.5):** every PATCH (pages, sections, items, posts, blogs)
requires `expected_updated_at` — 400 if absent, **409** on mismatch. Reorder and publish
routes are exempt.

**Link URL validation (§3.4):** every `Link.url` — on portfolio items, on the `links`
block, and on the contact section's `links` — is checked against a protocol allowlist.
Only `http:`, `https:`, `mailto:`, and `tel:` pass; `javascript:`, `data:`, `file:`, and
anything else are rejected with a 400. Contact-section email/phone links use `type:
"other"` with `mailto:`/`tel:` URLs (no new `Link.type` enum values). The allowlist is
enforced in `src/schemas/link.ts` and consumed by both frontends via `GET /api/schema` +
`npm run sync:types`.

## Endpoints

### Public — no auth

| Method | Path | Purpose |
|---|---|---|
| GET | `/` | Liveness string (`portfolio-v6-api`). |
| GET | `/api/health` | Liveness, no DB. Envelope response. |
| GET | `/api/schema` | JSON Schema of the whole content model (§8.4) — shapes only, not the HTTP surface. Raw, unauthenticated; `npm run sync:types` in both frontends consumes it. |
| GET | `/api/content` | Latest published document; media refs resolved to CDN URLs; `ETag`/304. |
| GET | `/api/posts` | Published post summaries; keyset pagination via `?cursor=`; filters `?limit=`, `?tag=`, `?blog=`. |
| GET | `/api/posts/:slug` | One published post (`published_body`); `ETag`/304; 404 for drafts. |
| GET | `/api/status` | Curated gateway-health payload, ~30s cache; degrades, never 5xx. |
| GET | `/api/now-playing` | Serves the shared Redis snapshot written by the dealer listener (primary) or the polling fallback lane; degrades to `{playing:false}`. |
| GET | `/api/duolingo` | Streak/course (`?language=`), ~1h cache; degrades to `{available:false}`. |
| GET | `/api/github` | Contribution calendar (`?year=YYYY` or trailing 12 months), ~1h cache; 400 only on invalid year. |
| GET | `/api/ops` | Daily-replay ops report (v1.7): `?date=YYYY-MM-DD` or latest; 400 malformed date, 404 none available. |
| GET | `/api/resume` | Newest confirmed resume PDF as `{available,url,filename,bytes,uploaded_at}` (or `{available:false}`), `Cache-Control: no-store`; degrades, never 5xx. |
| GET | `/api/resume/download` | Streams the newest confirmed resume PDF with `Content-Disposition: attachment` and `Content-Type: application/pdf`; 404 when none. |
| POST | `/api/beacon` | Analytics ingest — **always 204**; tolerant body parsing (mounted before `express.json()` so `text/plain` sendBeacon works); ~60 events/min per-IP. Clients must POST to the **absolute API origin** (a relative path on the frontends hits the SPA rewrite). |

### Admin

Auth column: **A** = `requireAdmin()` only · **A|K** = admin or `pv6k_` API key ·
**A|P** = admin or preview token · **state** = OAuth state only.

| Method | Path | Auth | Purpose |
|---|---|---|---|
| GET | `/api/admin/pages` | A\|K | All pages + nav order. |
| POST | `/api/admin/pages` | A\|K | Create page → 201. |
| PUT | `/api/admin/pages/order` | A\|K | Reorder nav (full ordered id array). |
| PATCH | `/api/admin/pages/:id` | A\|K | Update; requires `expected_updated_at`. |
| DELETE | `/api/admin/pages/:id` | A\|K | Delete page + its sections. |
| GET | `/api/admin/sections` | A\|K | Working set incl. drafts; `?page_id=` filter. |
| POST | `/api/admin/sections` | A\|K | Create section (`page_id` required). |
| PUT | `/api/admin/sections/order` | A\|K | Reorder within a page (`{ page_id, ids }`). |
| PATCH | `/api/admin/sections/:id` | A\|K | Update; requires `expected_updated_at`. |
| DELETE | `/api/admin/sections/:id` | A\|K | Delete (cascades to items). |
| POST | `/api/admin/sections/:id/items` | A\|K | Create item. |
| PUT | `/api/admin/sections/:id/items/order` | A\|K | Reorder items. |
| PATCH | `/api/admin/items/:id` | A\|K | Update item; requires `expected_updated_at`. |
| DELETE | `/api/admin/items/:id` | A\|K | Delete item. |
| POST | `/api/admin/preview-token` | A\|K | Mint ~15-min read-only preview token. |
| GET | `/api/admin/preview` | A\|P | Draft serialized in `/api/content` shape (raw). |
| GET | `/api/admin/preview/posts/:id` | A\|P | A post's draft body (raw). |
| POST | `/api/admin/publish` | A\|K | Validate + snapshot working set → new version; key-driven publishes attribute as `key:<name>`. |
| GET | `/api/admin/versions` | A\|K | Version history. |
| POST | `/api/admin/versions/:v/restore` | A\|K | Re-publish version *v* and rebuild the working set (destroys unpublished edits); key-driven restores attribute as `key:<name>`. |
| POST | `/api/admin/media/upload-url` | A\|K | Presigned S3 PUT + pending asset row → 201. |
| POST | `/api/admin/media/:id/confirm` | A\|K | Confirm the upload landed; finalize the asset. |
| GET | `/api/admin/media` | A\|K | List assets with orphan status. |
| POST | `/api/admin/media/sweep` | A\|K | Run orphan GC on demand (§6.9). |
| DELETE | `/api/admin/media/:id` | A\|K | Hard delete (S3 object + row). |
| POST | `/api/admin/resumes/upload-url` | A\|K | Presigned S3 PUT (application/pdf pinned into the signature, ≤10 MB) + pending resume row → 201. |
| POST | `/api/admin/resumes/:id/confirm` | A\|K | HEAD the object; stamp `confirmed_at` and record the true size. |
| GET | `/api/admin/resumes` | A\|K | All resume versions, newest first, each with a CDN url, filename, bytes, confirmed state. |
| DELETE | `/api/admin/resumes/:id` | A\|K | Hard delete a version (S3 object + row); deleting the newest promotes the next-newest publicly. |
| GET | `/api/admin/posts` | A\|K | All posts, drafts included. |
| POST | `/api/admin/posts` | A\|K | Create post → 201. |
| GET | `/api/admin/posts/:id` | A\|K | One post with `draft_body`. |
| PATCH | `/api/admin/posts/:id` | A\|K | Update metadata / `draft_body`; requires `expected_updated_at`. |
| DELETE | `/api/admin/posts/:id` | A\|K | Delete post. |
| POST | `/api/admin/posts/:id/publish` | A\|K | Re-validate (400 if invalid) then publish; key-driven publishes attribute as `key:<name>`. |
| POST | `/api/admin/posts/:id/unpublish` | A\|K | Null `published_at`, retain `published_body`. |
| GET | `/api/admin/blogs` | A\|K | All blogs with `post_count`. |
| POST | `/api/admin/blogs` | A\|K | Create blog `{slug,name}` → 201. |
| PATCH | `/api/admin/blogs/:id` | A\|K | Update; requires `expected_updated_at`. |
| DELETE | `/api/admin/blogs/:id` | A\|K | Delete; assigned posts get `blog_id = NULL`. |
| POST | `/api/admin/api-keys` | A | Mint key → 201; full `pv6k_…` secret returned **this once only**. |
| GET | `/api/admin/api-keys` | A | List keys (never a hash or full key). |
| POST | `/api/admin/api-keys/:id/revoke` | A | Revoke; idempotent. |
| GET | `/api/admin/analytics` | A\|K | Aggregates; `?days=7\|30\|90` (else 30). |
| GET | `/api/admin/integrations` | A | Status of spotify/github/duolingo (never the stored value). |
| PUT | `/api/admin/integrations/:key/value` | A | Set an api_key/value credential (encrypted at rest). |
| POST | `/api/admin/integrations/:key/connect` | A | Begin OAuth; mints single-use `state`. |
| GET | `/api/admin/integrations/:key/callback` | state | OAuth redirect target. |
| DELETE | `/api/admin/integrations/:key` | A | Remove stored credential. |
| GET/POST/DELETE | `/api/admin/spotify[/status|/connect|/callback]` | A / state | Legacy aliases for the spotify integration. |
| GET | `/api/admin/icons/devicon-manifest` | A\|K | Pinned, slimmed devicon manifest. |
| GET | `/api/admin/icons/simpleicons-manifest` | A\|K | Same for simple-icons. |
| POST | `/api/admin/icons/import` | A\|K | Download a pinned icon SVG server-side → S3 `icons/` → CDN URL. Idempotent. |

## Configuration

`src/config/loadConfig.ts` has two mutually exclusive paths:

- **`IS_LOCAL=true`** — everything from env (`.env`), zero AWS calls (the AWS SDK is never
  imported). Wildcard CORS is enabled in this mode only.
- **deployed** (`IS_LOCAL` unset) — app config from the Secrets Manager secret at
  `AWS_SECRET_ARN` (includes the listen `port`, currently `8000`) and DB
  credentials from `AWS_DB_SECRET_ARN`. No CORS headers from this app — the gateway
  supplies wildcard CORS on proxied traffic.

`.env.example` documents every variable with its default. Migrations: `npm run
migrate:latest` (Knex, env-driven `knexfile.ts`). Deployed containers auto-run migrations
only when `node_env !== 'production'` — **prod migrations are run manually** against the
prod DB before deploying a schema change.

### Now-playing (task #84 shared snapshot + listener series #115-#123)

Multiple API instances per environment would each independently exercise the shared
Spotify credentials and trip Spotify's per-client rate limits. A Redis leader lease
elects exactly one instance per environment as the sole writer of the shared
now-playing snapshot; every other instance serves reads from that snapshot and pushes
updates to browsers through the gateway realtime hub (see `REALTIME.md` in the gateway
repo for the contract). Every variable in the table below is **optional** — leaving
`REDIS_URL` unset falls back to per-instance in-memory caches and opens no Redis
connection (so local dev and CI stay Redis-free).

The now-playing snapshot has two writers on the leader, in strict order:

1. **Dealer listener (primary, event-driven)**. The connect-listener does what the
   Spotify web player does: mints a web-player access token from the stored `sp_dc`
   cookie (see `src/services/listener/webTokenMinter.ts`), holds the account's
   dealer websocket open, and receives cluster (playback state) pushes for every
   device on the account. Each cluster event is curated and written straight to the
   shared snapshot; while a track is playing, the supervisor also re-writes the
   snapshot every 20s with a locally-advanced `progress_ms` so polling-fallback
   viewers see progress move without any extra Spotify traffic. The listener is
   leader-gated (only the leader holds the socket), and stays idle until an admin
   pastes an `sp_dc` cookie into the `spotify_listener` integration; missing
   credential = idle, no dealer connection at all. See
   `src/services/upstream/listenerSupervisor.ts` and
   `src/services/listener/dealerClient.ts`.
2. **Polling fallback (Spotify Web API)**. When the listener is not `connected`
   (no credential, idle, backoff, or credential dead), the leader's Spotify lane
   polls Spotify's `/me/player/currently-playing` endpoint. Cadence is
   viewer-aware and predictive: idle (no viewers) polls at most once every 5min;
   active-and-playing schedules the next fetch at (track end + 2s), floored at
   15s and ceilinged at 60s so long tracks still get one drift-check per minute;
   active-but-idle polls at most once per 60s. On a 429 the lane suspends until
   `Retry-After` (or exponential backoff, capped at 15min), sharing the
   suspension deadline across instances via Redis so a fresh leader honors an
   existing suspension without a fresh trip. A daily Spotify Web API call budget
   (default 4000 calls, resetting at 21:23 UTC) is a belt-and-braces cap that
   suspends further calls once hit until the next window reset. See
   `src/services/upstream/spotifyLane.ts` and `src/services/listener/apiBudget.ts`.
3. **Shared Redis snapshot serving `/api/now-playing`**. Every instance (leader
   included) serves the public endpoint from the Redis snapshot key; no HTTP
   request ever fetches Spotify itself while Redis is reachable. A Redis outage
   falls back to the per-instance in-memory path so public reads never 5xx.

**Admin-granted credentials in `service_tokens`.** Both the OAuth refresh token
(`spotify`) that the polling fallback uses and the `sp_dc` cookie (`spotify_listener`)
the dealer listener uses live in the encrypted `service_tokens` table, minted only
through the admin Integrations page. Neither has any env or secret fallback; a missing
row means the corresponding lane is silently disconnected (zero Spotify traffic).

**Operational note: web-token minting.** The dealer listener mints a web-player
access token by calling Spotify's `get_access_token` endpoint with the stored `sp_dc`
cookie — a reverse-engineered endpoint the official mobile/web clients use, not part
of Spotify's public developer API. If Spotify changes the endpoint URL, expected
headers, or response shape, update the constants at the top of
`src/services/listener/webTokenMinter.ts` (URL, request headers, response parsing).
The listener degrades to `credential_dead` on any 4xx from that endpoint; the polling
fallback continues to operate independently.

| Variable | Default | Purpose |
|---|---|---|
| `REDIS_URL` | *(unset)* | Enables the subsystem when set. Separate deployments MUST NOT share a keyspace (use different DBs, e.g. `/0` and `/1`); keys are also prefixed with the env name. Placeholders only in the repo; the real value lives in the deployed secret. |
| `POLL_INTERVAL_MS` | `10000` | Base tick for the leader poll loop, milliseconds. Prod runs `5000`. Gateway status refreshes every tick; Spotify polling only fires when the listener is not connected AND the Spotify lane's predictive / idle deadline has elapsed; slow-lane (Duolingo, GitHub) keep their long TTLs and refresh only when expired. |
| `SPOTIFY_DAILY_CALL_BUDGET` | `4000` | Hard daily cap on outbound Spotify Web API + token-endpoint calls made by the polling fallback. Suspends polling once reached until the next window reset. |
| `SPOTIFY_BUDGET_RESET_UTC` | `21:23` | UTC time of day (`HH:MM`) the daily Spotify call budget window resets; invalid strings silently fall back to the default. |
| `GATEWAY_INTERNAL_URL` | `http://gateway:8080` | Internal base URL the container uses to reach the gateway's `POST /internal/publish` endpoint (realtime hub). |
| `GATEWAY_REALTIME_TOKEN` | *(unset)* | Shared secret the gateway injects into every service container so the internal publish endpoint can authenticate this API. Sent as the `X-Gateway-Realtime-Token` header. Never returned to any response and never logged. |
| `REALTIME_SERVICE_NAME` | `portfolio-v6-api` | Manifest service name that prefixes every published channel (`{service_name}:{topic}`). MUST match the service the gateway's publish token is scoped to. Defaults to `portfolio-v6-api`; only override if the API is deployed under a different manifest service name (a mismatched prefix is rejected with 403). Also settable via the `realtime_service_name` secret. |

Only the leader publishes; changes are published on `portfolio-v6-api:now-playing` /
`portfolio-v6-api:status` **only when the curated payload differs from the previous
snapshot**, and a lightweight heartbeat rides `portfolio-v6-api:now-playing` roughly
every 30s so clients can detect a stalled stream (per REALTIME.md's polling-floor
pattern). Publish failures are logged and swallowed — they never affect the poll loop
or public HTTP serving. A Redis outage never breaks public reads either: routers fall
back to the per-instance path with the existing in-memory caches.

## Deploy (§11)

`.github/workflows/deploy.yaml` on pushes to `main` (GitHub environment `prod`, service
`portfolio-v6-api`, moving tag `latest`): buildx a multi-arch image, push to ECR under
the moving tag AND an immutable per-build tag `<short-sha>-prod`, then one
authenticated call to the gateway's management API
(`POST /mgmt/services/<service>/deploy` with that same immutable tag). The gateway
resolves the tag to a digest, updates its service manifest, and blue-greens the container
in place — no instance refresh, other services unaffected. Container-internal port is
8000 (from the app secret); host ports are Docker-assigned by the gateway's reconciler.

## Local development

```bash
cp .env.example .env   # fill in; IS_LOCAL=true
npm install
npm run migrate:latest
npm run dev            # → localhost:3002
```

`npm test` runs the Vitest suite offline (AWS and Postgres mocked where needed).
