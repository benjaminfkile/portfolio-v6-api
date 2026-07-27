import { z } from "zod";
import { linkSchema } from "./link";

/**
 * Post body block model — TECH_SPEC_V1.md §3.7.
 *
 * `draft_body` / `published_body` hold an ordered array of blocks: a
 * discriminated union on `type`, mirroring the section registry so the same
 * rendering and validation approach applies one level down. All eight block
 * types are defined here; the public site's `BLOCK_REGISTRY` renders unknown
 * types as nothing rather than crashing.
 */

/**
 * Languages the client highlighter loads — the exported allowlist referenced by
 * §3.7's `code` block. This is used by the client to decide highlighting and by
 * `isSupportedLanguage()` below; it is deliberately NOT used to *reject* a code
 * block. An unrecognised language is a validation-level pass-through: it
 * validates fine and renders as plain text client-side (§3.7). So the schema
 * accepts any non-empty `language` string and this list drives rendering only.
 */
export const CODE_LANGUAGES = [
  "plaintext",
  "bash",
  "shell",
  "json",
  "yaml",
  "markdown",
  "html",
  "css",
  "javascript",
  "jsx",
  "typescript",
  "tsx",
  "python",
  "go",
  "rust",
  "java",
  "c",
  "cpp",
  "csharp",
  "ruby",
  "php",
  "sql",
  "graphql",
  "docker",
  "toml",
  "diff",
] as const;

export type CodeLanguage = (typeof CODE_LANGUAGES)[number];

/** True when `language` is in the highlighter allowlist (client-side decision). */
export function isSupportedLanguage(language: string): language is CodeLanguage {
  return (CODE_LANGUAGES as readonly string[]).includes(language);
}

export const headingBlockSchema = z
  .object({
    type: z.literal("heading"),
    level: z.union([z.literal(2), z.literal(3), z.literal(4)]),
    text: z.string(),
  })
  .strict();

export const paragraphBlockSchema = z
  .object({
    type: z.literal("paragraph"),
    // Constrained inline markdown (bold/italic/inline-code/links). Stored as a
    // plain string; raw HTML is never stored or rendered (§3.7).
    text: z.string(),
  })
  .strict();

export const codeBlockSchema = z
  .object({
    type: z.literal("code"),
    // Validated against CODE_LANGUAGES as a pass-through allowlist: any
    // non-empty string is accepted; unknown languages render as plain text.
    language: z.string().min(1),
    code: z.string(),
    filename: z.string().min(1).optional(),
  })
  .strict();

export const mediaBlockSchema = z
  .object({
    type: z.literal("media"),
    media_id: z.string().uuid(),
    caption: z.string().optional(),
  })
  .strict();

export const listBlockSchema = z
  .object({
    type: z.literal("list"),
    ordered: z.boolean(),
    items: z.array(z.string()),
  })
  .strict();

export const quoteBlockSchema = z
  .object({
    type: z.literal("quote"),
    text: z.string(),
    attribution: z.string().optional(),
  })
  .strict();

export const linksBlockSchema = z
  .object({
    type: z.literal("links"),
    links: z.array(linkSchema),
  })
  .strict();

export const dividerBlockSchema = z
  .object({
    type: z.literal("divider"),
  })
  .strict();

export const blockSchema = z.discriminatedUnion("type", [
  headingBlockSchema,
  paragraphBlockSchema,
  codeBlockSchema,
  mediaBlockSchema,
  listBlockSchema,
  quoteBlockSchema,
  linksBlockSchema,
  dividerBlockSchema,
]);

export type Block = z.infer<typeof blockSchema>;

/** An ordered array of blocks — the shape of `draft_body`/`published_body`. */
export const blockArraySchema = z.array(blockSchema);
export type BlockArray = z.infer<typeof blockArraySchema>;

/**
 * Draft-lenient block union (§3.9: invalid content can reach a draft, never
 * production). The `type` discriminator stays required so every block is
 * routable/renderable; every other field is optional but must be well-typed
 * when present (unknown keys still rejected via .strict()). Draft WRITES
 * (post create/PATCH) validate against this; publish uses the canonical
 * union above and enforces completeness.
 */
export const draftBlockSchema = z.discriminatedUnion("type", [
  headingBlockSchema.partial().required({ type: true }),
  paragraphBlockSchema.partial().required({ type: true }),
  codeBlockSchema.partial().required({ type: true }),
  mediaBlockSchema.partial().required({ type: true }),
  listBlockSchema.partial().required({ type: true }),
  quoteBlockSchema.partial().required({ type: true }),
  linksBlockSchema.partial().required({ type: true }),
  dividerBlockSchema.partial().required({ type: true }),
]);

export const draftBlockArraySchema = z.array(draftBlockSchema);
export type DraftBlockArray = z.infer<typeof draftBlockArraySchema>;
