import { z } from "zod";

/**
 * The shared `Link` type — TECH_SPEC_V1.md §3.4.
 *
 * One ordered array replaces v5's two optional `url`/`repo` scalars. Reused by
 * portfolio items (§3.4) and by the blog's `links` block (§3.7). Array order is
 * display order; `type` drives icon/grouping, `label` says *which one* and is
 * required — it is never derived from `type`.
 */
export const LINK_TYPES = [
  "repo",
  "prod",
  "dev",
  "docs",
  "demo",
  "package",
  "article",
  "other",
] as const;

/** Protocols permitted in a Link `url` — §3.4. */
export const ALLOWED_LINK_PROTOCOLS = [
  "http:",
  "https:",
  "mailto:",
  "tel:",
] as const;

/**
 * `z.string().url()` alone accepts `javascript:` URLs, which become stored XSS
 * the moment they are rendered into an `href`. The admin is the only path by
 * which content enters the system, so the protocol allowlist is enforced here:
 * only `http:`, `https:`, `mailto:`, and `tel:` pass — the last two so a
 * contact section can carry an email or phone link. `javascript:`, `data:`,
 * `file:`, etc. are rejected (§3.4).
 */
export const httpUrl = z
  .string()
  .url()
  .refine(
    (value) => {
      let protocol: string;
      try {
        protocol = new URL(value).protocol;
      } catch {
        return false;
      }
      return (ALLOWED_LINK_PROTOCOLS as readonly string[]).includes(protocol);
    },
    { message: "url must use the http, https, mailto, or tel protocol" }
  );

export const linkSchema = z
  .object({
    type: z.enum(LINK_TYPES),
    label: z.string().min(1),
    url: httpUrl,
  })
  .strict();

export type Link = z.infer<typeof linkSchema>;
