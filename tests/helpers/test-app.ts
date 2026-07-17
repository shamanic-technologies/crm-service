import express from "express";
import healthRoutes from "../../src/routes/health.js";

/** Minimal app exercising only the no-DB surfaces (health + apiKeyAuth). */
export function createHealthApp() {
  const app = express();
  app.use(express.json());
  app.use(healthRoutes);
  app.use((_req, res) => res.status(404).json({ error: "Not found" }));
  return app;
}
