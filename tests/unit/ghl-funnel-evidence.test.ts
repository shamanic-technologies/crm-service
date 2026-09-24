import { afterEach, describe, expect, it, vi } from "vitest";
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
  const pipelines = { Sales: ["Appointment Booked", "Closed Client"] };
  const tracking = { orgId: "o", userId: "u", runId: "r" };
  let sent: { url: string; body: Record<string, unknown> } | null = null;

  function answer(answers: Record<string, unknown>) {
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      sent = { url: String(url), body: JSON.parse(String(init.body)) };
      return new Response(
        JSON.stringify({ model: "jev-1.13.0", answers, usage: { inputTokens: 1, outputTokens: 1 } }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    });
  }
  const choice = (meaning: string, confidence = 1) => ({
    type: "choice",
    choice: meaning,
    confidence,
    probabilities: { [meaning]: confidence },
  });

  afterEach(() => vi.unstubAllGlobals());

  it("asks one choice question per stage, against every pipeline, through /orgs/judgments", async () => {
    answer({ s0: choice("meeting_booked"), s1: choice("sale", 0.9) });
    const result = await classifyStages(stages, pipelines, tracking);
    expect(result).toEqual({
      model: "jev-1.13.0",
      decisions: [
        { meaning: "meeting_booked", confidence: 1, probabilities: { meeting_booked: 1 } },
        { meaning: "sale", confidence: 0.9, probabilities: { sale: 0.9 } },
      ],
    });
    expect(sent!.url).toMatch(/\/orgs\/judgments$/);
    expect(sent!.body.state).toEqual({ pipelines });
    const questions = sent!.body.questions as Record<string, { type: string; criteria: object }>;
    expect(Object.keys(questions)).toEqual(["s0", "s1"]);
    expect(questions.s0.type).toBe("choice");
    expect(Object.keys(questions.s0.criteria).sort()).toEqual(
      ["deal_lost", "meeting_attended", "meeting_booked", "meeting_not_held", "none", "sale"],
    );
  });

  it("refuses a meaning outside the vocabulary", async () => {
    answer({ s0: choice("booked"), s1: choice("sale") });
    await expect(classifyStages(stages, pipelines, tracking)).rejects.toThrow(/unknown meaning/);
  });

  it("refuses an answer that skips a stage", async () => {
    answer({ s0: choice("meeting_booked") });
    await expect(classifyStages(stages, pipelines, tracking)).rejects.toThrow(/no answer for stage s1/);
  });

  it("refuses an answer whose confidence went missing", async () => {
    answer({ s0: { type: "choice", choice: "sale", probabilities: {} }, s1: choice("sale") });
    await expect(classifyStages(stages, pipelines, tracking)).rejects.toThrow(/without a confidence/);
  });
});
