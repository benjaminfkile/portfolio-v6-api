import knex, { Knex } from "knex";

let db: Knex | null = null;

export function initDatabase(): Knex {
  if (!process.env.DATABASE_URL) {
    throw new Error("DATABASE_URL is not defined in environment variables");
  }

  db = knex({
    client: "pg",
    connection: {
      connectionString: process.env.DATABASE_URL,
      ssl: { rejectUnauthorized: false },
    },
    pool: { min: 2, max: 10 },
    acquireConnectionTimeout: 10000,
  });

  console.log("✅ Database initialized");

  // Set up shutdown hooks
  process.on("SIGINT", async () => {
    await closeDatabase();
    process.exit(0);
  });

  process.on("SIGTERM", async () => {
    await closeDatabase();
    process.exit(0);
  });

  return db;
}

export function getDb(): Knex {
  if (!db) {
    throw new Error("Database not initialized. Call initDatabase() first.");
  }
  return db;
}

export async function closeDatabase(): Promise<void> {
  if (db) {
    console.log("🛑 Closing database connection...");
    await db.destroy();
    console.log("✅ Database connection closed.");
  }
}
