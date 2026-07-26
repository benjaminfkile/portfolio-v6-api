import knex, { Knex } from "knex";
import path from "path";
import { IDbConnection } from "../interfaces";
import { LoadedConfig } from "../config/loadConfig";
import health from "./health";
import { ExtensionAgnosticMigrationSource } from "./migrationSource";

let db: Knex | null = null;

/**
 * Resolve the Postgres connection from loaded config. `db_name` / credentials
 * come from the config (env under IS_LOCAL, Secrets Manager otherwise); host,
 * port and ssl always come from the environment — matching the manual migration
 * command in TECH_SPEC_V1.md §9.1 (DB_HOST / DB_SSL=true against RDS).
 */
export function buildDbConnection(config: LoadedConfig): IDbConnection {
  return {
    host: process.env.DB_HOST || "localhost",
    port: parseInt(process.env.DB_PORT || "5432", 10),
    user: config.dbSecrets.username,
    password: config.dbSecrets.password,
    database: config.appSecrets.db_name,
    ssl: process.env.DB_SSL === "true",
  };
}

export interface InitDbOptions {
  runMigrations: boolean;
}

// Pattern ported from file-manager-api/src/db/db.ts.
export async function initDb(
  connection: IDbConnection,
  options: InitDbOptions
): Promise<Knex> {
  if (db) return db;

  db = knex({
    client: "pg",
    connection: {
      host: connection.host,
      user: connection.user,
      password: connection.password,
      database: connection.database,
      port: connection.port,
      ssl: connection.ssl ? { rejectUnauthorized: false } : false,
    },
    migrations: {
      migrationSource: new ExtensionAgnosticMigrationSource(
        path.join(__dirname, "migrations")
      ),
    },
  });

  const dbHealth = await health.getDBConnectionHealth(db, true);
  console.log(dbHealth.logs);

  if (options.runMigrations) {
    await db.migrate.latest();
  }

  return db;
}

export function getDb(): Knex {
  if (!db) {
    throw new Error("Database has not been initialized. Call initDb() first.");
  }
  return db;
}

// Test/teardown helper: close the pool and reset the singleton.
export async function closeDb(): Promise<void> {
  if (db) {
    await db.destroy();
    db = null;
  }
}
