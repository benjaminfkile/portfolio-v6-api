import express, { Request, Response } from "express";
import { buildContentJsonSchema } from "../schemas";

/**
 * GET /api/schema — TECH_SPEC_V1.md §8.4.
 *
 * Serves the JSON Schema derived from the canonical Zod definitions. The
 * frontends' `sync:types` fetches this and generates `src/types/content.ts`, so
 * the content types are defined once (here) and never hand-copied across the
 * three repos. Returned as a raw JSON Schema document (not wrapped in the API
 * envelope) so it can be consumed directly by JSON-Schema tooling.
 *
 * The document is derived once at module load — the schemas are static.
 */
const schemaDocument = buildContentJsonSchema();

const schemaRouter = express.Router();

schemaRouter.get("/", (_req: Request, res: Response) => {
  res.status(200).json(schemaDocument);
});

export default schemaRouter;
