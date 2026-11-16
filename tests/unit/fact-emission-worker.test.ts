import { describe, expect, it, vi } from "vitest";

vi.mock("../../src/lib/people/facts.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/people/facts.js")>()),
  emitScopeFacts: vi.fn(async (scope: { id: string }) => ({ emitted: 1, scope: scope.id })),
}));

describe("fact emission worker (MON-PAGE-SPEED-1114)", () => {
  it("runs inline from source: a worker cannot load TypeScript", async () => {
    const { emissionRunsInWorker, emitScopeFactsOffThread } = await import("../../src/lib/people/fact-emission-worker.js");
    expect(emissionRunsInWorker()).toBe(false);
    await expect(emitScopeFactsOffThread({ id: "s1", orgId: "o", brandId: "b" })).resolves.toMatchObject({ emitted: 1, scope: "s1" });
  });

  it("the emitter's emission goes through the worker module, never emitScopeFacts directly", async () => {
    const { readFileSync } = await import("node:fs");
    const src = readFileSync(new URL("../../src/lib/people/fact-emitter.ts", import.meta.url), "utf8");
    expect(src).toContain("emitScopeFactsOffThread(scope)");
    expect(src).not.toMatch(/\bemitScopeFacts\(/);
  });
});
