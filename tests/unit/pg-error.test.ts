import { describe, it, expect } from "vitest";
import { DrizzleQueryError } from "drizzle-orm";
import { pgErrorOf, isUniqueViolation } from "../../src/lib/pg-error.js";

/** The shape postgres.js raises for a unique-index violation. */
function pgUniqueViolation(constraint: string) {
  return Object.assign(new Error(`duplicate key value violates unique constraint "${constraint}"`), {
    code: "23505",
    constraint_name: constraint,
    detail: "Key (x)=(1) already exists.",
  });
}

describe("pgErrorOf / isUniqueViolation (drizzle-orm >= 0.44 wraps driver errors)", () => {
  it("reads the postgres error through drizzle's DrizzleQueryError wrapper", () => {
    const wrapped = new DrizzleQueryError("insert into t values ($1)", [1], pgUniqueViolation("idx_a"));
    expect((wrapped as unknown as { code?: string }).code).toBeUndefined();
    expect(pgErrorOf(wrapped).code).toBe("23505");
    expect(pgErrorOf(wrapped).constraint_name).toBe("idx_a");
    expect(pgErrorOf(wrapped).detail).toBe("Key (x)=(1) already exists.");
    expect(isUniqueViolation(wrapped, "idx_a")).toBe(true);
  });

  it("still reads a raw postgres.js error", () => {
    expect(isUniqueViolation(pgUniqueViolation("idx_a"), "idx_a")).toBe(true);
  });

  it("is narrow: another constraint, another code, or a non-db error is not a match", () => {
    expect(isUniqueViolation(new DrizzleQueryError("q", [], pgUniqueViolation("idx_b")), "idx_a")).toBe(false);
    expect(isUniqueViolation(Object.assign(new Error("fk"), { code: "23503", constraint_name: "idx_a" }), "idx_a")).toBe(false);
    expect(isUniqueViolation(new Error("boom"), "idx_a")).toBe(false);
    expect(isUniqueViolation(undefined, "idx_a")).toBe(false);
    expect(pgErrorOf("not an error")).toEqual({});
  });
});
