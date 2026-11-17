import { describe, it, expect } from "vitest";
import { parseExcludeSources } from "../../src/lib/people/timeline.js";

describe("timeline excludeSources (TIMELINE-EXCLUDE-SOURCES-1117)", () => {
  it("reads a comma list of people sources, trimmed and deduplicated", () => {
    expect(parseExcludeSources("api, copilot,api")).toEqual({ sources: ["api", "copilot"], unknown: [] });
  });
  it("absent or blank = nothing left out (every source, unchanged)", () => {
    expect(parseExcludeSources(undefined)).toEqual({ sources: [], unknown: [] });
    expect(parseExcludeSources(" , ")).toEqual({ sources: [], unknown: [] });
  });
  it("names unknown sources apart (the route answers 400)", () => {
    expect(parseExcludeSources("api,mcp")).toEqual({ sources: ["api"], unknown: ["mcp"] });
  });
});
