import { ZodError } from "zod";

/**
 * Render a `ZodError` as a compact, human-readable one-line summary.
 *
 * Zod's default `error.message` is the raw serialized issue array (a multi-line
 * JSON blob) — useless in a 400 envelope. This flattens each issue to
 * `path: message`, joined by `; `, so a validation failure reads like
 * `sphere_detail: Number must be less than or equal to 4` instead of a JSON
 * dump. A root-level issue (empty path) is labelled `(root)`.
 */
export function formatZodError(error: ZodError): string {
  return error.issues
    .map((i) => `${i.path.join(".") || "(root)"}: ${i.message}`)
    .join("; ");
}
