import { describe, expect, it } from "vitest";
import { buildRunsInWorker } from "../../src/lib/people/build-worker.js";

describe("people build worker (CRM-BUILD-WORKER-1126)", () => {
  it("stays inline when run from source: a worker cannot load TypeScript", () => {
    expect(buildRunsInWorker()).toBe(false);
  });
});
