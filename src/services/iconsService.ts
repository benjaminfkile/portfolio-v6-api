import * as s3 from "../aws/s3Service";
import { toCdnUrl } from "../utils/cdn";
import { MEDIA_CACHE_CONTROL } from "../config/media";

/**
 * Icons service — §Icons v1.6 (task #532).
 *
 * Two admin capabilities, both fully server-side:
 *
 *   1. The devicon MANIFEST proxy — fetch `devicon.json` from jsDelivr against a
 *      PINNED devicon release, slim each entry to the contract shape, and cache
 *      it in memory (~24h) so admin traffic never multiplies upstream calls.
 *   2. The icon IMPORT — validate a `{ name, variant }` against that manifest,
 *      download the pinned SVG from jsDelivr, and store it in the site's EXISTING
 *      media S3 bucket under the dedicated `icons/` prefix, returning the
 *      media-CDN URL. Deterministic key + idempotent (existing key → skip upload).
 *
 * The `icons/` prefix lives OUTSIDE the §6.9 media orphan sweep on purpose:
 * imported icons are NOT `media_assets` rows, and the sweep enumerates that table
 * (never the raw bucket), so an icon object is never a sweep candidate. Skills
 * reference icons by URL, not `media_id`, so they must never be swept.
 *
 * NOTHING here runs against real AWS or the network in tests: the S3 client is
 * isolated in `../aws/s3Service` (fully mocked) and the jsDelivr `fetch` is
 * mocked per the repo's offline-test rule (agent-pre-checks §7).
 */

/**
 * PINNED devicon release (§Icons v1.6). The manifest and every imported SVG are
 * fetched at this exact tag so an import is byte-reproducible and the deterministic
 * S3 key (which embeds this version) is stable. Bumping devicon is a one-line
 * change here. Latest stable release of github.com/devicons/devicon at
 * implementation time (2026-08).
 */
export const DEVICON_VERSION = "v2.17.0";

/** jsDelivr URL of `devicon.json` at the pinned release. */
export const DEVICON_MANIFEST_URL = `https://cdn.jsdelivr.net/gh/devicons/devicon@${DEVICON_VERSION}/devicon.json`;

/** In-memory manifest cache TTL (§Icons v1.6 "~24h"). */
export const MANIFEST_CACHE_TTL_MS = 24 * 60 * 60 * 1000;

/** Upstream fetch timeout — a hung jsDelivr must not hang the admin endpoint. */
export const ICONS_UPSTREAM_TIMEOUT_MS = 8_000;

/** S3 key prefix for imported icons — deliberately OUTSIDE `media/` (§6.9). */
export const ICONS_KEY_PREFIX = "icons/devicon";

/** jsDelivr URL of a single icon SVG variant at the pinned release. */
export function deviconSvgUrl(name: string, variant: string): string {
  return `https://cdn.jsdelivr.net/gh/devicons/devicon@${DEVICON_VERSION}/icons/${name}/${name}-${variant}.svg`;
}

/**
 * Deterministic S3 key for an imported icon (§Icons v1.6):
 * `icons/devicon/<name>-<variant>@<version>.svg`. Stable per (name, variant,
 * pinned version), which is what makes the import idempotent.
 */
export function iconS3Key(name: string, variant: string): string {
  return `${ICONS_KEY_PREFIX}/${name}-${variant}@${DEVICON_VERSION}.svg`;
}

/** The contract-shaped manifest entry (a slimmed `devicon.json` row). */
export interface SlimIcon {
  name: string;
  altnames: string[];
  tags: string[];
  /** Available SVG variants (original, plain, line, original-wordmark, …). */
  versions: string[];
  color: string;
}

export interface DeviconManifest {
  version: string;
  icons: SlimIcon[];
}

// ---- Result envelope (mirrors mediaService / sectionsService) ---------------

export type IconFailureCode =
  | "not_found"
  | "validation"
  | "bad_request"
  | "upstream";

export type IconResult<T> =
  | { ok: true; data: T }
  | { ok: false; code: IconFailureCode; message: string };

function fail<T>(code: IconFailureCode, message: string): IconResult<T> {
  return { ok: false, code, message };
}

function ok<T>(data: T): IconResult<T> {
  return { ok: true, data };
}

// ---- Manifest proxy ---------------------------------------------------------

interface ManifestCacheEntry {
  manifest: DeviconManifest;
  expiresAt: number;
}

let manifestCache: ManifestCacheEntry | null = null;

function timeoutSignal(): { signal: AbortSignal; clear: () => void } {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ICONS_UPSTREAM_TIMEOUT_MS);
  return { signal: controller.signal, clear: () => clearTimeout(timer) };
}

function asStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.filter((v): v is string => typeof v === "string")
    : [];
}

/**
 * Slim a raw `devicon.json` array to the contract shape. `versions` is the
 * entry's `versions.svg` list — the authoritative set of downloadable SVG
 * variants (verified: wordmark aliases without an SVG file are NOT listed there,
 * so validating an import against this list can never point at a missing file).
 * Non-object rows and rows without a string `name` are dropped defensively.
 */
export function slimManifest(raw: unknown): SlimIcon[] {
  if (!Array.isArray(raw)) return [];
  const icons: SlimIcon[] = [];
  for (const entry of raw) {
    if (entry == null || typeof entry !== "object") continue;
    const rec = entry as Record<string, unknown>;
    if (typeof rec.name !== "string" || rec.name.length === 0) continue;
    const versionsObj =
      rec.versions && typeof rec.versions === "object"
        ? (rec.versions as Record<string, unknown>)
        : {};
    icons.push({
      name: rec.name,
      altnames: asStringArray(rec.altnames),
      tags: asStringArray(rec.tags),
      versions: asStringArray(versionsObj.svg),
      color: typeof rec.color === "string" ? rec.color : "",
    });
  }
  return icons;
}

/**
 * Fetch + slim the devicon manifest, cached ~24h. Returns the cached copy while
 * fresh; on a miss it fetches jsDelivr at the pinned tag, slims, and caches. Any
 * upstream failure (non-2xx, timeout, network error, unparseable/`non-array`
 * body) is an `upstream` failure the router maps to 502 — a stale cache is never
 * served past its TTL, and a failure never poisons the cache.
 */
export async function getDeviconManifest(
  now: number = Date.now()
): Promise<IconResult<DeviconManifest>> {
  if (manifestCache && manifestCache.expiresAt > now) {
    return ok(manifestCache.manifest);
  }

  const { signal, clear } = timeoutSignal();
  let raw: unknown;
  try {
    const res = await fetch(DEVICON_MANIFEST_URL, {
      headers: { accept: "application/json" },
      signal,
    });
    if (!res.ok) {
      throw new Error(`devicon manifest fetch returned status ${res.status}`);
    }
    raw = await res.json();
  } catch (err) {
    console.error(
      "[iconsService] devicon manifest fetch failed:",
      err instanceof Error ? err.message : err
    );
    return fail(
      "upstream",
      "Could not fetch the devicon manifest from the upstream CDN"
    );
  } finally {
    clear();
  }

  if (!Array.isArray(raw)) {
    return fail("upstream", "The devicon manifest had an unexpected shape");
  }

  const manifest: DeviconManifest = {
    version: DEVICON_VERSION,
    icons: slimManifest(raw),
  };
  manifestCache = { manifest, expiresAt: now + MANIFEST_CACHE_TTL_MS };
  return ok(manifest);
}

/** Test-only: forget the cached manifest so a fresh fetch runs. */
export function _resetIconsCacheForTests(): void {
  manifestCache = null;
}

// ---- Import -----------------------------------------------------------------

export interface ImportIconInput {
  name?: unknown;
  variant?: unknown;
}

export interface ImportIconResult {
  url: string;
}

/**
 * Download the pinned devicon SVG for `{ name, variant }` and store it under the
 * `icons/` prefix, returning its media-CDN URL (§Icons v1.6).
 *
 *   - `name`/`variant` are validated against the (cached) manifest — an unknown
 *     icon or a variant the icon does not publish is a 400 with a named message,
 *     and no download happens.
 *   - the key is deterministic, so the import is IDEMPOTENT: a HEAD that finds the
 *     object already present skips the download+upload and returns the URL.
 *   - a fresh object is fetched from jsDelivr and written with `image/svg+xml`
 *     and a long-lived immutable cache header.
 */
export async function importIcon(
  input: ImportIconInput,
  cdnDomain: string
): Promise<IconResult<ImportIconResult>> {
  const name = typeof input.name === "string" ? input.name.trim() : "";
  const variant = typeof input.variant === "string" ? input.variant.trim() : "";
  if (!name) return fail("bad_request", "name is required");
  if (!variant) return fail("bad_request", "variant is required");

  const manifest = await getDeviconManifest();
  if (!manifest.ok) return fail(manifest.code, manifest.message);

  const icon = manifest.data.icons.find((i) => i.name === name);
  if (!icon) {
    return fail("validation", `unknown icon "${name}"`);
  }
  if (!icon.versions.includes(variant)) {
    return fail(
      "validation",
      `icon "${name}" has no variant "${variant}" (available: ${icon.versions.join(", ")})`
    );
  }

  const key = iconS3Key(name, variant);

  // Idempotency: an already-imported icon (deterministic key present) is served
  // straight from its URL — no re-download, no re-upload.
  const existing = await s3.headObject(key);
  if (existing) {
    return ok({ url: toCdnUrl(cdnDomain, key) });
  }

  const svg = await fetchIconSvg(name, variant);
  if (svg === null) {
    return fail(
      "upstream",
      `Could not download the "${name}-${variant}" SVG from the upstream CDN`
    );
  }

  await s3.putObject({
    key,
    body: svg,
    contentType: "image/svg+xml",
    cacheControl: MEDIA_CACHE_CONTROL,
  });

  return ok({ url: toCdnUrl(cdnDomain, key) });
}

/**
 * Fetch a single icon SVG from jsDelivr at the pinned release. Returns the SVG
 * text on a 200, or `null` on ANY transport failure (non-2xx, timeout, network
 * error) so the caller can map it to a clean 502 rather than throwing a 500.
 */
async function fetchIconSvg(
  name: string,
  variant: string
): Promise<string | null> {
  const { signal, clear } = timeoutSignal();
  try {
    const res = await fetch(deviconSvgUrl(name, variant), {
      headers: { accept: "image/svg+xml" },
      signal,
    });
    if (!res.ok) {
      throw new Error(`devicon svg fetch returned status ${res.status}`);
    }
    return await res.text();
  } catch (err) {
    console.error(
      "[iconsService] devicon svg fetch failed:",
      err instanceof Error ? err.message : err
    );
    return null;
  } finally {
    clear();
  }
}
