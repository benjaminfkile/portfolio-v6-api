import { z } from "zod";
import { zodToJsonSchema } from "zod-to-json-schema";

import { linkSchema } from "./link";
import { blockSchema, blockArraySchema } from "./blocks";
import { ITEM_SCHEMAS } from "./items";
import { SECTION_DATA_SCHEMAS } from "./sections";
import { postSchema, postMetadataSchema } from "./posts";

export * from "./link";
export * from "./blocks";
export * from "./items";
export * from "./sections";
export * from "./posts";

/**
 * The canonical schema surface — TECH_SPEC_V1.md §3.9 / §8.4.
 *
 * Every section-type `data` schema, every item schema, the block union and the
 * post schema are gathered under one root so a single derived JSON Schema
 * document describes the whole content model. `GET /api/schema` serves this;
 * the frontends' `sync:types` fetches it and generates `content.ts`, so there
 * is one source of truth for the content types across all three repos.
 */
export const contentRootSchema = z
  .object({
    link: linkSchema,
    block: blockSchema,
    blockArray: blockArraySchema,
    sectionData: z.object(SECTION_DATA_SCHEMAS),
    itemData: z.object(ITEM_SCHEMAS),
    postMetadata: postMetadataSchema,
    post: postSchema,
  })
  .strict();

/**
 * Derive the JSON Schema document from the Zod definitions. Shared types (Link,
 * Block) are emitted once under `$defs`/`definitions` and referenced, so the
 * generated frontend types don't duplicate them.
 */
export function buildContentJsonSchema(): Record<string, unknown> {
  return zodToJsonSchema(contentRootSchema, {
    name: "PortfolioV6Content",
    definitions: {
      Link: linkSchema,
      Block: blockSchema,
    },
  }) as Record<string, unknown>;
}
