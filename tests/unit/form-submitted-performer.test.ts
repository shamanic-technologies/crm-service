import { describe, it, expect } from "vitest";
import { formSubmittedBatchBody, formSubmittedPerformer } from "../../src/lib/gohighlevel/form-submitted.js";
import { performerConflictRunsOf, RunsServiceError } from "../../src/lib/runs-client.js";

/** OUTCOME-PERFORMER-1106: every form_submitted occurrence names WHO performed it: the brand's CRM, never a guessed script. */
describe("form_submitted performer (OUTCOME-PERFORMER-1106)", () => {
  it("names the CRM that recorded the form, never a script", () => {
    expect(formSubmittedPerformer("gohighlevel")).toEqual({ kind: "crm", name: "gohighlevel" });
    expect(formSubmittedPerformer("gohighlevel")).not.toHaveProperty("workflowSlug");
  });

  it("every produced occurrence of the batch body states it", () => {
    const body = formSubmittedBatchBody([
      { runId: "r1", leadId: "l1", submittedAt: new Date("2026-10-15T11:00:00Z"), source: "gohighlevel" },
      { runId: "r2", leadId: "l2", submittedAt: new Date("2026-10-16T11:00:00Z"), source: "gohighlevel" },
    ]);
    for (const entry of body) for (const o of entry.produced ?? []) expect(o.performer).toEqual({ kind: "crm", name: "gohighlevel" });
  });

  it("reads the runs a 409 performer_conflict names, and nothing else", () => {
    const err = (status: number, body: unknown) =>
      new RunsServiceError({ kind: "http", status, path: "/v1/platform-runs/outcomes/batch", method: "POST", body: JSON.stringify(body), message: "x" });
    expect(performerConflictRunsOf(err(409, { error: "performer_conflict", conflicts: [{ runId: "AB" }, { runId: "ab" }] }))).toEqual(["ab"]);
    expect(performerConflictRunsOf(err(409, { error: "run_outcomes_voided", conflicts: [] }))).toBeNull();
    expect(performerConflictRunsOf(err(422, { error: "performer_conflict", conflicts: [] }))).toBeNull();
    expect(performerConflictRunsOf(new Error("x"))).toBeNull();
  });
});

describe("a runs-service that does not serve the performer yet is never read as having stored it", () => {
  it("only an answer carrying performerStatedCount acknowledges it", async () => {
    const { performerAcknowledged } = await import("../../src/lib/gohighlevel/form-submitted.js");
    expect(performerAcknowledged({ performerStatedCount: 0 })).toBe(true);
    expect(performerAcknowledged({ performerStatedCount: 3 })).toBe(true);
    expect(performerAcknowledged({})).toBe(false);
  });
});
