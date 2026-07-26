import dotenv from "dotenv";
dotenv.config();

import http from "http";
import morgan from "morgan";
import app from "./src/app";
import { loadConfig } from "./src/config/loadConfig";
import { buildDbConnection, initDb } from "./src/db/db";

process.on("uncaughtException", (err) => {
  console.error("[Fatal] Uncaught exception:", err);
  console.log("Node NOT Exiting...");
});

// Boot pattern (v5 / file-manager-api): secrets -> initDb -> listen. Under
// IS_LOCAL=true, loadConfig() sources everything from env and makes NO AWS call.
export async function start(): Promise<http.Server> {
  const config = await loadConfig();
  const { appSecrets } = config;

  app.set("secrets", appSecrets);

  const morganFormat = appSecrets.node_env === "production" ? "tiny" : "common";
  app.use(morgan(morganFormat));

  const port = parseInt(appSecrets.port, 10) || 3002;

  await initDb(buildDbConnection(config), {
    runMigrations: appSecrets.node_env !== "production",
  });

  const server = http.createServer(app);

  process.on("SIGINT", () => {
    server.close(() => {
      console.log("Server closed (SIGINT)");
      process.exit(0);
    });
  });

  process.on("SIGTERM", () => {
    server.close(() => {
      console.log("Server closed (SIGTERM)");
      process.exit(0);
    });
  });

  await new Promise<void>((resolve) => server.listen(port, resolve));
  console.log(`⚡️[server]: Running at http://localhost:${port}`);

  return server;
}

if (require.main === module) {
  start().catch((err) => {
    console.error("Failed to start server:", err);
    process.exit(1);
  });
}
