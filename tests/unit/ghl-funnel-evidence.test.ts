import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { deriveAppointment, deriveOpportunity } from "../../src/lib/gohighlevel/records.js";
import { classifyStages } from "../../src/lib/gohighlevel/stage-meanings.js";

describe("deriveAppointment", () => {
  it("reads the booking, the schedule and GoHighLevel's status", () => {
    const appointment = deriveAppointment({
      id: "ap1",
      calendarId: "cal1",
      contactId: "c1",
      appointmentStatus: "noshow",
      dateAdded: "2026-04-01T13:33:23.000Z",
      startTime: "2026-04-03T12:30:00-04:00",
      endTime: "2026-04-03T13:00:00-04:00",
    });
    expect(appointment).toMatchObject({ status: "noshow", externalContactId: "c1", calendarExternalId: "cal1" });
    expect(appointment?.bookedAt?.toISOString()).toBe("2026-04-01T13:33:23.000Z");
    expect(appointment?.startsAt?.toISOString()).toBe("2026-04-03T16:30:00.000Z");
  });

  it("falls back to the misspelled status twin only when the real key is absent", () => {
    expect(deriveAppointment({ id: "a", appoinmentStatus: "showed" })?.status).toBe("showed");
    expect(
      deriveAppointment({ id: "a", appointmentStatus: "cancelled", appoinmentStatus: "showed" })?.status,
    ).toBe("cancelled");
  });

  it("never places a zone-less wall-clock time on the timeline", () => {
    // The per-contact read serves times like this, in the calendar's unstated zone.
    const appointment = deriveAppointment({
      id: "a",
      dateAdded: "2026-04-01 09:33:23",
      startTime: "2026-04-03 12:30:00",
    });
    expect(appointment?.bookedAt).toBeNull();
    expect(appointment?.startsAt).toBeNull();
  });
});

describe("deriveOpportunity change dates", () => {
  it("carries GoHighLevel's stage and status change dates, or null", () => {
    const dated = deriveOpportunity({
      id: "o",
      lastStageChangeAt: "2026-05-12T15:27:43.054Z",
      lastStatusChangeAt: "2026-05-12T15:27:45.973Z",
    });
    expect(dated?.stageChangedAt?.toISOString()).toBe("2026-05-12T15:27:43.054Z");
    expect(dated?.statusChangedAt?.toISOString()).toBe("2026-05-12T15:27:45.973Z");

    const undated = deriveOpportunity({ id: "o" });
    expect(undated?.stageChangedAt).toBeNull();
    expect(undated?.statusChangedAt).toBeNull();
  });
});

describe("classifyStages", () => {
  const stages = [
    { pipelineExternalId: "p", pipelineName: "Sales", stageExternalId: "s1", stageName: "Appointment Booked" },
    { pipelineExternalId: "p", pipelineName: "Sales", stageExternalId: "s2", stageName: "Closed Client" },
  ];
  const tracking = { orgId: "o", userId: "u", runId: "r" };

  function answer(json: unknown) {
    vi.stubGlobal("fetch", async () =>
      new Response(
        JSON.stringify({ content: "", json, tokensInput: 1, tokensOutput: 1, model: "claude-haiku-x" }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
  }

  beforeEach(() => {
    process.env.CRM_STAGE_MEANING_CHAT_CONFIG = "anthropic/haiku";
  });
  afterEach(() => vi.unstubAllGlobals());

  it("returns one meaning per stage, in order, with the model", async () => {
    answer({ stages: [{ key: "1", meaning: "sale" }, { key: "0", meaning: "meeting_booked" }] });
    await expect(classifyStages(stages, tracking)).resolves.toEqual({
      meanings: ["meeting_booked", "sale"],
      model: "claude-haiku-x",
    });
  });

  it("refuses a meaning outside the vocabulary", async () => {
    answer({ stages: [{ key: "0", meaning: "booked" }, { key: "1", meaning: "sale" }] });
    await expect(classifyStages(stages, tracking)).rejects.toThrow(/unknown meaning/);
  });

  it("refuses an answer that skips a stage", async () => {
    answer({ stages: [{ key: "0", meaning: "meeting_booked" }] });
    await expect(classifyStages(stages, tracking)).rejects.toThrow(/no answer for key 1/);
  });

  it("refuses an answer that decides a stage twice", async () => {
    answer({ stages: [{ key: "0", meaning: "none" }, { key: "0", meaning: "sale" }, { key: "1", meaning: "sale" }] });
    await expect(classifyStages(stages, tracking)).rejects.toThrow(/answered twice/);
  });

  it("has no model to fall back on when the config is unset", async () => {
    delete process.env.CRM_STAGE_MEANING_CHAT_CONFIG;
    await expect(classifyStages(stages, tracking)).rejects.toThrow(/CRM_STAGE_MEANING_CHAT_CONFIG is required/);
  });
});
