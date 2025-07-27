import { getDb } from "../db";

const contentService = {
  getAllContent: async () => {
    const db = getDb();
    const sections = await db("sections").orderBy("display_order");

    for (const section of sections) {
      const items = await db("content_items")
        .where("section_id", section.section_id)
        .orderBy("display_order");

      for (const item of items) {
        item.urls = await db("url_items").where(
          "content_item_id",
          item.content_item_id
        );

        if (item.media_id) {
          item.media = await db("media")
            .select("file_name", "media_type_id")
            .where("media_id", item.media_id)
            .first();
        }
      }

      section.content_items = items;
    }

    return sections;
  },
};

export default contentService;
