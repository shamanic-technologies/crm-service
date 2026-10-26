import { describe, expect, it } from "vitest";
import { SUPPORT_RUNS } from "../../src/lib/runs-client.js";

// LEDGER-CRM-UNDECLARED-1027: every crm-service spend that produces no outcome by design sits on its own task, marked at
// creation; the people build keeps only the lead judgments (lead_identified), identity resolution rides people.identity.
describe("SUPPORT_RUNS", () => {
  it("names one distinct crm-service task per support function", () => {
    const tasks = Object.values(SUPPORT_RUNS).map((t) => t.taskName);
    expect(new Set(tasks).size).toBe(tasks.length);
    for (const t of Object.values(SUPPORT_RUNS)) {
      expect(t.serviceName).toBe("crm-service");
      expect(t.support.reason.length).toBeGreaterThan(0);
    }
  });

  it("files identity resolution apart from the build's lead judgments", () => {
    expect(SUPPORT_RUNS.identityResolution).toMatchObject({ taskName: "people.identity", support: { kind: "product_feature" } });
    expect(Object.values(SUPPORT_RUNS).map((t) => t.taskName)).not.toContain("people.build");
    expect(Object.values(SUPPORT_RUNS).map((t) => t.taskName)).not.toContain("matrix.sync");
  });
});
