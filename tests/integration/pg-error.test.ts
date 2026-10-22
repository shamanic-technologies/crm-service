import { describe, it, expect, afterAll } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { pgErrorOf, isUniqueViolation } from "../../src/lib/pg-error.js";

// A real duplicate key through the real driver + drizzle: pins that the unique-violation
// branches (which catch and answer the race winner) still see the Postgres error now that
// drizzle-orm >= 0.44 wraps it in DrizzleQueryError.
const TABLE = "pg_error_probe_sec2";

// Gated on CRM_TEST_DB like the other DB-backed suites (CI sets it; the default URL is a mock).
const RUN = !!process.env.CRM_TEST_DB;

describe.skipIf(!RUN)("pgErrorOf + restored message against a real Postgres unique violation", () => {
  afterAll(async () => {
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${TABLE}`));
  });

  it("finds code 23505 + the constraint name behind drizzle's wrapper", async () => {
    await db.execute(sql.raw(`DROP TABLE IF EXISTS ${TABLE}`));
    await db.execute(sql.raw(`CREATE TABLE ${TABLE} (k text, CONSTRAINT ${TABLE}_k_uniq UNIQUE (k))`));
    await db.execute(sql.raw(`INSERT INTO ${TABLE} (k) VALUES ('a')`));
    let caught: unknown;
    try {
      await db.execute(sql.raw(`INSERT INTO ${TABLE} (k) VALUES ('a')`));
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeDefined();
    // drizzle's wrapper carries no SQLSTATE itself: reading `err.code` directly would miss it.
    expect((caught as { code?: unknown }).code).toBeUndefined();
    expect(pgErrorOf(caught).code).toBe("23505");
    // The db client restores the database's own message: no SQL text, no bound values.
    expect((caught as Error).message).toMatch(/^duplicate key value violates unique constraint/);
    expect((caught as Error).message).not.toContain("Failed query");
    expect(isUniqueViolation(caught, `${TABLE}_k_uniq`)).toBe(true);
    expect(isUniqueViolation(caught, "some_other_index")).toBe(false);
  });
});
