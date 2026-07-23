import * as Sentry from "@sentry/node";
import express from "express";
import cors from "cors";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getSql } from "./db/index.js";
import healthRoutes from "./routes/health.js";
import contactsRoutes from "./routes/contacts.js";
import internalRoutes from "./routes/internal.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const openapiPath = join(__dirname, "..", "openapi.json");

const app = express();
const PORT = process.env.PORT || 3010;

app.use(cors());
// JSON body parsing. Multipart (CSV upload) is handled by multer in the route,
// so express.json only touches application/json requests.
app.use(express.json({ limit: "2mb" }));

app.get("/openapi.json", (_req, res) => {
  if (existsSync(openapiPath)) {
    res.json(JSON.parse(readFileSync(openapiPath, "utf-8")));
  } else {
    res.status(404).json({
      type: "not_found",
      error: "OpenAPI spec not generated. Run: pnpm generate:openapi",
    });
  }
});

app.use(healthRoutes);
app.use(contactsRoutes);
app.use(internalRoutes);

app.use((_req, res) => {
  res.status(404).json({ type: "not_found", error: "Not found" });
});

Sentry.setupExpressErrorHandler(app);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[crm-service] Unhandled error:", err);
  res.status(500).json({ type: "internal", error: "Internal server error" });
});

if (process.env.NODE_ENV !== "test") {
  const dbUrl = process.env.CRM_SERVICE_DATABASE_URL;

  const startServer = () => {
    app.listen(Number(PORT), "::", () => {
      console.log(`[crm-service] running on port ${PORT}`);
    });
  };

  if (dbUrl) {
    const migrateDb = drizzle(getSql());
    migrate(migrateDb, { migrationsFolder: "./drizzle" })
      .then(() => {
        console.log("[crm-service] Migrations complete");
        startServer();
      })
      .catch((err) => {
        console.error("[crm-service] Migration failed:", err);
        process.exit(1);
      });
  } else {
    console.warn("[crm-service] CRM_SERVICE_DATABASE_URL not set, skipping migrations");
    startServer();
  }
}

export default app;
