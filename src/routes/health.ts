import { Router } from "express";
import { sql } from "drizzle-orm";

const router = Router();

router.get("/health", (_req, res) => {
  res.json({ status: "ok", service: "crm-service" });
});

router.get("/health/debug", async (_req, res) => {
  const dbUrl = process.env.DATABASE_URL;

  let dbStatus = "not configured";
  if (dbUrl) {
    try {
      const { db } = await import("../db/index.js");
      await db.execute(sql`SELECT 1`);
      dbStatus = "connected";
    } catch (e: any) {
      dbStatus = `error: ${e.message}`;
    }
  }

  res.json({
    dbConfigured: !!dbUrl,
    dbStatus,
    runsServiceUrl: process.env.RUNS_SERVICE_URL || "not set",
    chatServiceUrl: process.env.CHAT_SERVICE_URL || "not set",
  });
});

export default router;
