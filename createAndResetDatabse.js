require("dotenv").config();
const { Client } = require("pg");

const client = new Client({
  connectionString: process.env.DATABASE_URL,
  ssl: { rejectUnauthorized: false },
});

async function resetDatabase() {
  try {
    await client.connect();
    console.log("🧨 Dropping all tables...");

    await client.query(`
      DROP TABLE IF EXISTS url_items;
      DROP TABLE IF EXISTS content_items;
      DROP TABLE IF EXISTS sections;
      DROP TABLE IF EXISTS media;
      DROP TABLE IF EXISTS media_types;
    `);

    console.log("🧱 Recreating schema...");

    await client.query(`
      CREATE TABLE media_types (
        media_type_id SERIAL PRIMARY KEY,
        mime_type TEXT NOT NULL
      );

      CREATE TABLE media (
        media_id SERIAL PRIMARY KEY,
        media_type_id INT REFERENCES media_types(media_type_id),
        file_name TEXT NOT NULL
      );

      CREATE TABLE sections (
        section_id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        display_order INT
      );

      CREATE TABLE content_items (
        content_item_id SERIAL PRIMARY KEY,
        section_id INT REFERENCES sections(section_id) ON DELETE CASCADE,
        parent_id INT REFERENCES content_items(content_item_id) ON DELETE CASCADE,
        title TEXT,
        text TEXT,
        media_id INT REFERENCES media(media_id) ON DELETE SET NULL,
        display_order INT
      );

      CREATE TABLE url_items (
        url_item_id SERIAL PRIMARY KEY,
        title TEXT NOT NULL,
        url TEXT NOT NULL,
        content_item_id INT REFERENCES content_items(content_item_id) ON DELETE CASCADE
      );
    `);

    console.log("🌱 Inserting seed data...");

    await client.query(`
      INSERT INTO media_types (mime_type) VALUES
        ('image/png'),
        ('image/jpeg'),
        ('video/mp4');

      INSERT INTO media (media_type_id, file_name) VALUES
        (1, 'bk-logo.png'),
        (2, 'portrait.jpg');

      INSERT INTO sections (title, display_order) VALUES
        ('About', 1),
        ('Portfolio', 2),
        ('Contact', 3);

      INSERT INTO content_items (section_id, title, text, media_id, display_order) VALUES
        (1, 'Welcome', 'Hi, I''m Ben.', 1, 1),
        (2, 'Project 1', 'Built a cool app.', 2, 1);

      INSERT INTO url_items (title, url, content_item_id) VALUES
        ('GitHub', 'https://github.com/benjaminfkile', 2);
    `);

    console.log("✅ Database reset and seeded.");
  } catch (err) {
    console.error("❌ Failed:", err);
  } finally {
    await client.end();
  }
}

resetDatabase();
