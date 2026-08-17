/**
 * Reduce an arbitrary client-supplied filename to a single safe path segment.
 *
 * Strips any directory components (both `/` and `\`) so a generated S3 key
 * cannot escape its intended `{prefix}/{uuid}/` — with a well-formed key
 * template this makes the concatenated key exactly `{prefix}/{uuid}/{filename}`
 * (§6.4 / task #92). An empty or whitespace-only filename falls back to `"file"`
 * so the object still lands under a non-empty last segment.
 *
 * Shared by the media upload flow (§6.7) and the resume upload flow (task #92);
 * factored out so both services enforce identical rules.
 */
export function safeFilename(filename: string): string {
  const base = filename.split(/[\\/]/).pop() ?? "";
  const trimmed = base.trim();
  return trimmed.length > 0 ? trimmed : "file";
}
