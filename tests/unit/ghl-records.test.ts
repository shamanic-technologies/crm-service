import { describe, it, expect } from "vitest";
import {
  canonicalHash,
  deriveContact,
  deriveFormName,
  deriveFormSubmission,
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
    expect(contact).toMatchObject({
      externalId: "ocQHyuzHvysMo5N5VsXc",
      primaryEmail: "john.deo@gmail.com",
      phoneE164: "+33612345678",
      firstName: "John",
      lastName: "Deo",
      fullName: "John Deo",
      unsubscribed: false,
    });
  });

  it("lifts the company, the place and the record's provenance", () => {
    // The shape of a real prod record (2026-09-22), trimmed to the fields read.
    const contact = deriveContact({
      id: "V5m8Ae7nFZ4wdNmKR3EN",
      email: "shahab@docdinners.com",
      companyName: "Doc",
      website: "https://docdinners.com",
      city: "Lahore",
      state: "Punjab",
      country: "PK",
      postalCode: "46000",
      address1: "12 Mall Road",
      source: "STripe Test ",
      type: "lead",
      tags: ["vip", "trial"],
      dateAdded: "2026-08-19T15:23:58.577Z",
      dateUpdated: "2026-08-19T15:24:06.360Z",
      attributions: [
        { isLast: true, medium: "referral", url: "https://later", referrer: "https://later.ref" },
        {
          isFirst: true,
          medium: "order_form",
          url: "https://sites.leadconnectorhq.com/preview/x",
          referrer: "https://app.gohighlevel.com",
          ip: "151.158.212.9",
          userAgent: "Mozilla/5.0",
        },
      ],
    });
    expect(contact).toMatchObject({
      companyName: "Doc",
      website: "https://docdinners.com",
      city: "Lahore",
      stateRegion: "Punjab",
      country: "PK",
      postalCode: "46000",
      streetAddress: "12 Mall Road",
      // Trimmed but otherwise verbatim — the customer's own words, unmapped.
      leadSource: "STripe Test",
      contactType: "lead",
      tags: ["vip", "trial"],
      // FIRST touch, not the last one, and never the ip or the user agent.
      originMedium: "order_form",
      originUrl: "https://sites.leadconnectorhq.com/preview/x",
      originReferrer: "https://app.gohighlevel.com",
    });
    expect(contact?.sourceCreatedAt?.toISOString()).toBe("2026-08-19T15:23:58.577Z");
    expect(contact?.sourceUpdatedAt?.toISOString()).toBe("2026-08-19T15:24:06.360Z");
  });

  it("states absence rather than defaulting it", () => {
    const contact = deriveContact({
      id: "a",
      companyName: null,
      website: "",
      city: "   ",
      country: undefined,
    });
    expect(contact).toMatchObject({
      companyName: null,
      website: null,
      city: null,
      stateRegion: null,
      country: null,
      postalCode: null,
      streetAddress: null,
      leadSource: null,
      contactType: null,
      // No tags FIELD at all is null; an empty tags field is [] — those differ.
      tags: null,
      originMedium: null,
      originUrl: null,
      originReferrer: null,
      sourceCreatedAt: null,
      sourceUpdatedAt: null,
    });
  });

  it("distinguishes an empty tag list from no tag field", () => {
    expect(deriveContact({ id: "a", tags: [] })?.tags).toEqual([]);
    expect(deriveContact({ id: "a" })?.tags).toBeNull();
  });

  it("takes the first attribution when none is flagged isFirst", () => {
    const contact = deriveContact({
      id: "a",
      attributions: [{ medium: "paid", pageUrl: "https://p" }, { medium: "organic" }],
    });
    expect(contact?.originMedium).toBe("paid");
    // `pageUrl` is GoHighLevel's other spelling of the same thing.
    expect(contact?.originUrl).toBe("https://p");
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

describe("deriveFormSubmission", () => {
  // Captured verbatim from GoHighLevel's /forms/submissions (Doc Dinners, 2026-09-25), trimmed.
  const real = {
    id: "6ab6546b879e3cd4e4510b77",
    contactId: "YYp46bgLHtNZWLCKmdJ7",
    formId: "rfJqRLuLSDXDxfbEcA1T",
    name: "Kelly Robinson",
    email: "kt8787@yahoo.com",
    createdAt: "2026-09-25T11:00:59.547Z",
    external: false,
    others: { ip: "2600::1", phone: "+14049986757" },
  };

  it("lifts the submission, its form, its contact and GoHighLevel's own date", () => {
    expect(deriveFormSubmission(real)).toEqual({
      externalId: "6ab6546b879e3cd4e4510b77",
      formExternalId: "rfJqRLuLSDXDxfbEcA1T",
      externalContactId: "YYp46bgLHtNZWLCKmdJ7",
      submittedAt: new Date("2026-09-25T11:00:59.547Z"),
    });
  });

  it("never places a zone-less timestamp on a timeline", () => {
    expect(deriveFormSubmission({ ...real, createdAt: "2026-09-25 11:00:59" })?.submittedAt).toBeNull();
    expect(deriveFormSubmission({ ...real, createdAt: undefined })?.submittedAt).toBeNull();
  });

  it("skips a record without an id", () => {
    expect(deriveFormSubmission({ ...real, id: undefined })).toBeNull();
  });

  it("reads a form's name verbatim", () => {
    expect(deriveFormName({ id: "f1", name: "Meta Ads" })).toEqual({ externalId: "f1", name: "Meta Ads" });
    expect(deriveFormName({ id: "f2" })).toEqual({ externalId: "f2", name: null });
  });
});
