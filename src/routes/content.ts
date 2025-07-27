import express from "express";
import contentService from "../services/contentService";
import { ISection, IBaseAPIResponse } from "@benkile/portfolio-v6-shared-types/src/index";

const contentRouter = express.Router();

contentRouter.get("/content", async (req, res) => {
  try {
    const data: ISection[] = await contentService.getAllContent();
    const response: IBaseAPIResponse<ISection[]> = {
      data,
      error: null,
    };
    res.json(response);
  } catch (err) {
    console.error("Error fetching content:", err);
    const response: IBaseAPIResponse<null> = {
      data: null,
      error: "Failed to fetch content.",
    };
    res.status(500).json(response);
  }
});

export default contentRouter;
