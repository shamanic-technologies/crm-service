import { describe, it, expect } from "vitest";
import {
  canonicalHash,
  deriveContact,
  deriveOpportunity,
  derivePipeline,
} from "../../src/lib/gohighlevel/records.js";

describe("canonicalHash", () => {
  it("is stable across key order — the no-churn guard depends on it", () => {
    const a = { id: "x", email: "a@b.com", tags: ["one", "two"] };
    const b = { tags: ["one", "two"], email: "a@b.com", id: "x" };
    expect(canonicalHash(a)).toBe(canonicalHash(b));
  });

  it("changes when any value changes", () => {
    expect(canonicalHash({ id: "x", v: 1 })).not.toBe(canonicalHash({ id: "x", v: 2 }));
  });

  it("is order-sensitive inside arrays (a re-ordered pipeline IS a change)", () => {
    expect(canonicalHash({ s: ["a", "b"] })).not.toBe(canonicalHash({ s: ["b", "a"] }));
  });
});

describe("deriveContact", () => {
  it("lifts the identity fields GoHighLevel reports", () => {
    const contact = deriveContact({
      id: "ocQHyuzHvysMo5N5VsXc",
      email: "  John.Deo@Gmail.com ",
      phone: "+33612345678",
      firstName: "John",
      lastName: "Deo",
      dnd: false,
    });
    expect(contact).toEqual({
      externalId: "ocQHyuzHvysMo5N5VsXc",
      primaryEmail: "john.deo@gmail.com",
      phoneE164: "+33612345678",
      firstName: "John",
      lastName: "Deo",
      fullName: "John Deo",
      unsubscribed: false,
    });
  });

  it("carries GoHighLevel's do-not-disturb flag through as unsubscribed", () => {
    expect(deriveContact({ id: "a", dnd: true })?.unsubscribed).toBe(true);
  });

  it("does not guess a national number into E.164", () => {
    expect(deriveContact({ id: "a", phone: "0612345678" })?.phoneE164).toBeNull();
  });

  it("prefers GoHighLevel's own display name over a composed one", () => {
    const contact = deriveContact({ id: "a", contactName: "Dr. J. Deo", firstName: "John" });
    expect(contact?.fullName).toBe("Dr. J. Deo");
  });

  it("returns null without an id — nothing keyless enters silver", () => {
    expect(deriveContact({ email: "a@b.com" })).toBeNull();
  });
});

describe("derivePipeline", () => {
  it("keeps the stages in the order GoHighLevel lists them", () => {
    const pipeline = derivePipeline({
      id: "p1",
      name: "Sales",
      stages: [
        { id: "s1", name: "New", position: 0 },
        { id: "s2", name: "Won", position: 1 },
      ],
    });
    expect(pipeline?.name).toBe("Sales");
    expect(pipeline?.stages.map((s) => s.id)).toEqual(["s1", "s2"]);
  });

  it("falls back to array order when a stage carries no position", () => {
    const pipeline = derivePipeline({ id: "p1", stages: [{ id: "s1" }, { id: "s2" }] });
    expect(pipeline?.stages.map((s) => s.position)).toEqual([0, 1]);
  });

  it("drops a stage with no id rather than inventing one", () => {
    const pipeline = derivePipeline({ id: "p1", stages: [{ name: "New" }, { id: "s2" }] });
    expect(pipeline?.stages).toHaveLength(1);
  });
});

describe("deriveOpportunity", () => {
  it("stores GoHighLevel's own pipeline, stage, status and value", () => {
    const opportunity = deriveOpportunity({
      id: "o1",
      name: "Wedding, June",
      monetaryValue: 2500.5,
      pipelineId: "p1",
      pipelineStageId: "s2",
      status: "won",
      assignedTo: "u1",
      contactId: "c1",
      createdAt: "2026-08-03T04:55:17.355Z",
      updatedAt: "2026-08-09T04:55:17.355Z",
    });
    expect(opportunity).toMatchObject({
      externalId: "o1",
      name: "Wedding, June",
      monetaryValue: "2500.5",
      pipelineExternalId: "p1",
      stageExternalId: "s2",
      status: "won",
      externalContactId: "c1",
    });
    expect(opportunity?.ghlCreatedAt?.toISOString()).toBe("2026-08-03T04:55:17.355Z");
  });

  it("reads the contact id out of an embedded contact when there is no flat one", () => {
    expect(deriveOpportunity({ id: "o1", contact: { id: "c9" } })?.externalContactId).toBe("c9");
  });

  it("leaves an unparseable timestamp null rather than inventing a date", () => {
    expect(deriveOpportunity({ id: "o1", createdAt: "not a date" })?.ghlCreatedAt).toBeNull();
  });
});
