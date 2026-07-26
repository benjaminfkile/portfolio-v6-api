import { Knex } from "knex";
import { IDBHealth } from "../interfaces";

// Ported from file-manager-api/src/db/health.ts.
const health = {
  getDBConnectionHealth: async (
    db: Knex,
    verbose: boolean = false
  ): Promise<IDBHealth> => {
    const messages: string[] = [];
    const timestamp = new Date().toISOString();

    try {
      await db.raw("SELECT 1+1 AS result");

      const host = db.client.config.connection.host;
      const connectionUsesProxy = host?.includes("proxy") ?? false;

      if (verbose) {
        messages.push("Database connection successful");
        messages.push(`Host: ${host}`);
        messages.push(`Using proxy: ${connectionUsesProxy}`);
      }

      return {
        connected: true,
        connectionUsesProxy,
        ...(verbose && { logs: { messages, host, timestamp } }),
      };
    } catch (err: any) {
      if (verbose) {
        messages.push("Database connection failed");
        messages.push(`Error: ${err.message || String(err)}`);
      }

      return {
        connected: false,
        connectionUsesProxy: false,
        ...(verbose && {
          logs: {
            messages,
            timestamp,
            error: err.message || String(err),
          },
        }),
      };
    }
  },
};

export default health;
