import { describe, it, expect } from "vitest";
import { normalizeUploadIdsQuery } from "../../src/lib/serve.js";

/**
 * Query-parameter normalization for the per-file serve restriction. Pure —
 * runs in CI without a DB (the SQL behaviour lives in tests/integration/serve.test.ts).
 */
describe("normalizeUploadIdsQuery", () => {
  it("treats an absent param as no restriction", () => {
    expect(normalizeUploadIdsQuery(undefined)).toEqual([]);
    expect(normalizeUploadIdsQuery(null)).toEqual([]);
    expect(normalizeUploadIdsQuery("")).toEqual([]);
  });

  it("splits a comma-separated param and trims", () => {
    expect(normalizeUploadIdsQuery("a, b ,c")).toEqual(["a", "b", "c"]);
  });

  it("accepts a repeated param", () => {
    expect(normalizeUploadIdsQuery(["a", "b"])).toEqual(["a", "b"]);
  });

  it("accepts repeated params that are themselves comma-separated", () => {
    expect(normalizeUploadIdsQuery(["a,b", "c"])).toEqual(["a", "b", "c"]);
  });

  it("drops empty segments instead of emitting blank ids", () => {
    expect(normalizeUploadIdsQuery("a,,b,")).toEqual(["a", "b"]);
    expect(normalizeUploadIdsQuery([" ", "a"])).toEqual(["a"]);
  });
});
