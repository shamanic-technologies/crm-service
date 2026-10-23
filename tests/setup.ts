import { beforeAll, afterAll } from "vitest";

// Env must be set BEFORE any src module is imported (auth.ts crashes at import
// if CRM_SERVICE_API_KEY is missing).
process.env.NODE_ENV = "test";
process.env.CRM_SERVICE_API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";
process.env.CRM_SERVICE_DATABASE_URL =
  process.env.CRM_SERVICE_DATABASE_URL || "postgresql://mock:mock@localhost:5432/mock";
process.env.RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "http://localhost:9999";
process.env.RUNS_SERVICE_API_KEY = process.env.RUNS_SERVICE_API_KEY || "test-runs-key";
process.env.CHAT_SERVICE_URL = process.env.CHAT_SERVICE_URL || "http://localhost:9998";
process.env.CHAT_SERVICE_API_KEY = process.env.CHAT_SERVICE_API_KEY || "test-chat-key";
// The form and phone watchers resolve the brand's token through key-service
// (stubbed at fetch in the tests). Without a URL they refuse before the stub,
// so a local run without CI's env reported 8 false failures (2026-10-23).
process.env.KEY_SERVICE_URL = process.env.KEY_SERVICE_URL || "http://localhost:9997";
process.env.KEY_SERVICE_API_KEY = process.env.KEY_SERVICE_API_KEY || "test-key-service-key";

beforeAll(() => console.log("Test suite starting..."));
afterAll(() => console.log("Test suite complete."));
