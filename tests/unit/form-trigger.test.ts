import { describe, it, expect } from "vitest";
import { isCalendarBookingForm, submissionAnswers, submissionPerson } from "../../src/lib/form-trigger/submission.js";
import { pickOffer } from "../../src/lib/form-trigger/offer.js";
import { burstFacts, offerChoice, pickHeldOffer, pickReachedOffer } from "../../src/lib/offer-pick.js";
import { occurrenceBody } from "../../src/lib/form-trigger/campaign-client.js";
import { nextAttemptDue } from "../../src/lib/form-trigger/watch.js";

/** The shape GoHighLevel served for a Meta Ads form fill on 2026-10-07 (identity made up). */
const META_ADS = {
  id: "6ac6586d00db83258b99de3f",
  name: "Jane Doe",
  email: "Jane.Doe@Example.com",
  formId: "rfJqRLuLSDXDxfbEcA1T",
  contactId: "gI9vezTMfelEsjhOymtt",
  createdAt: "2026-10-07T14:34:21.802Z",
  others: {
    formId: "rfJqRLuLSDXDxfbEcA1T",
    phone: "+1 (212) 664-7665",
    full_name: "Jane Doe",
    eventData: { medium: "form", parentName: "Meta Ads" },
    sessionId: "98e8ce2c",
    fieldsOriSequance: ["MfQa5Fl4DCvkUHR3wZrE", "button", "header"],
    MfQa5Fl4DCvkUHR3wZrE: "Chiropractor",
  },
};

/** A calendar's booking form fill (same day): the booking itself. */
const CALENDAR = {
  id: "6ac66d827ce1d36fe8cc0c2e",
  name: "John Roe",
  formId: "2zxohOKaAPBeQivGIHSM",
  contactId: "SaPbt5gvXddhugfwbtKW",
  createdAt: "2026-10-07T16:04:18.035Z",
  others: {
    internalSource: { id: "zJEXTXZCVIai1P1Dai3c", type: "calendars" },
    fieldsOriSequance: ["full_name", "email", "phone", "QujQFnuvbysspMQoOdC0", "terms_and_conditions", "button", "html"],
    QujQFnuvbysspMQoOdC0: "We are looking to schedule a presentation.",
    terms_and_conditions: "100% Secure. We value your privacy.",
  },
};

describe("submission", () => {
  it("reads the person off the record, phone in E.164 and email lower-cased", () => {
    expect(submissionPerson(META_ADS)).toEqual({
      fullName: "Jane Doe",
      email: "jane.doe@example.com",
      phone: "+12126647665",
      sourceContactId: "gI9vezTMfelEsjhOymtt",
    });
  });

  it("answers in the form's own order, labelled, without identity keys or form elements", () => {
    const labels = new Map([["MfQa5Fl4DCvkUHR3wZrE", "Which profession best describes you?"]]);
    expect(submissionAnswers(META_ADS, labels)).toEqual([
      { key: "MfQa5Fl4DCvkUHR3wZrE", label: "Which profession best describes you?", value: "Chiropractor" },
    ]);
    expect(submissionAnswers(CALENDAR, new Map())).toEqual([
      { key: "QujQFnuvbysspMQoOdC0", label: null, value: "We are looking to schedule a presentation." },
    ]);
  });

  it("a record with no field order answers nothing (never its metadata)", () => {
    expect(submissionAnswers({ others: { ip: "1.2.3.4", sessionId: "x" } }, new Map())).toEqual([]);
  });

  it("a calendar's booking form is the booking: by a mirrored calendar's formId, or the record's own source", () => {
    expect(isCalendarBookingForm(CALENDAR, new Set())).toBe(true);
    expect(isCalendarBookingForm({ ...CALENDAR, others: {} }, new Set(["2zxohOKaAPBeQivGIHSM"]))).toBe(true);
    expect(isCalendarBookingForm({ ...CALENDAR, others: {} }, new Set())).toBe(false);
    expect(isCalendarBookingForm(META_ADS, new Set(["2zxohOKaAPBeQivGIHSM"]))).toBe(false);
  });
});

describe("pickOffer", () => {
  const A = { offerId: "a", name: "A", status: "active" };
  const B = { offerId: "b", name: "B", status: "active" };
  const OLD = { offerId: "c", name: "C", status: "archived" };

  it("the only active offer, when the brand has one", () => {
    expect(pickOffer("f1", [], [A, OLD])).toEqual({ offerId: "a", basis: "only_offer" });
  });
  it("a stated form offer wins, then the brand-wide statement", () => {
    expect(pickOffer("f1", [{ formId: "*", offerId: "b" }, { formId: "f1", offerId: "a" }], [A, B])).toEqual({ offerId: "a", basis: "stated_for_form" });
    expect(pickOffer("f2", [{ formId: "*", offerId: "b" }, { formId: "f1", offerId: "a" }], [A, B])).toEqual({ offerId: "b", basis: "stated_for_brand" });
  });
  it("several offers and no statement: unknown, never a guess", () => {
    const r = pickOffer("f1", [], [A, B]);
    expect(r.offerId).toBeNull();
    expect(r).toMatchObject({ reason: "offer_unknown" });
    expect(pickOffer("f1", [], [OLD])).toMatchObject({ offerId: null, detail: "the brand has no active offer" });
  });
});

describe("pickReachedOffer (FORM-OFFER-PICK-1108)", () => {
  const ev = (ref: string) => ({ via: "audience_served" as const, ref, at: "x" });
  it("the earliest offer that reached the person, among the brand's active offers", () => {
    const active = new Set(["a", "b"]);
    expect(
      pickReachedOffer(
        [
          { offerId: "b", at: new Date("2026-10-02"), evidence: ev("2") },
          { offerId: "a", at: new Date("2026-10-01"), evidence: ev("1") },
        ],
        active,
      ),
    ).toEqual({ offerId: "a", evidence: ev("1") });
  });
  it("an archived offer or an offer-less audience reached nobody for this pick", () => {
    expect(pickReachedOffer([{ offerId: "c", at: new Date(0), evidence: ev("c") }, { offerId: null, at: new Date(0), evidence: ev("n") }], new Set(["a"]))).toBeNull();
    expect(pickReachedOffer([], new Set(["a"]))).toBeNull();
  });
});

describe("offerChoice (FORM-OFFER-PICK-1108)", () => {
  it("one option per offer, each with what it sells and its audience text; the answers as question / answer", () => {
    const { state, question, keyToOffer } = offerChoice(
      { name: "Doc Dinners", website: "docdinners.com", description: null },
      [
        { offerId: "a", name: "Restaurants", whatWeOffer: "Dinners", audienceId: "aud-a", audienceText: "Restaurant owners" },
        { offerId: "b", name: "Doctors", whatWeOffer: null, audienceId: null, audienceText: null },
      ],
      {
        what: "A person just filled a form of this brand.",
        facts: { formName: "Meta Ads", answers: [{ question: "Which profession best describes you?", answer: "Chiropractor" }, { question: "k2", answer: "x" }] },
      },
    );
    expect(question.type).toBe("choice");
    expect(Object.keys(question.criteria)).toEqual(["o0", "o1"]);
    expect(question.criteria.o0).toContain("Restaurant owners");
    expect(question.criteria.o0).toContain("Dinners");
    expect(question.criteria.o1).toContain("No audience text");
    expect([...keyToOffer]).toEqual([["o0", "a"], ["o1", "b"]]);
    expect(question.instructions.startsWith("A person just filled a form of this brand.")).toBe(true);
    expect(state.whatHappened).toBe("A person just filled a form of this brand.");
    expect(state.occurrence).toEqual({
      formName: "Meta Ads",
      answers: [{ question: "Which profession best describes you?", answer: "Chiropractor" }, { question: "k2", answer: "x" }],
    });
  });
  it("the same question for a number given or a message: only what happened and the evidence differ (OFFER-PICK-ALL-1108)", () => {
    const offers = [{ offerId: "a", name: "A", whatWeOffer: null, audienceId: null, audienceText: "Doctors" }];
    const { question } = offerChoice({ name: "B", website: null, description: null }, offers, { what: "A person just wrote to this brand on whatsapp.", facts: { messages: [] } });
    expect(question.instructions.startsWith("A person just wrote to this brand on whatsapp.")).toBe(true);
    expect(question.criteria.o0).toContain("Doctors");
  });
});

describe("pickHeldOffer (OFFER-PICK-ALL-1108)", () => {
  it("the ACTIVE tagged offer Jev is most sure of; an archived or unknown tag places nothing", () => {
    const active = new Set(["a", "b"]);
    expect(pickHeldOffer([], null, active)).toBeNull();
    expect(pickHeldOffer(["a", "b"], { a: 0.6, b: 0.9 }, active)).toBe("b");
    expect(pickHeldOffer(["b", "a"], null, active)).toBe("a");
    expect(pickHeldOffer(["z", "a"], { z: 0.99, a: 0.1 }, active)).toBe("a");
    expect(pickHeldOffer(["z"], null, active)).toBeNull();
  });
});

describe("burstFacts (OFFER-PICK-ALL-1108)", () => {
  it("when and what they wrote; empty texts and non-arrays dropped", () => {
    expect(burstFacts([{ eventId: "$1", at: "t1", text: "Hello", photo: {} }, { at: "t2", text: "  " }])).toEqual([{ at: "t1", text: "Hello" }]);
    expect(burstFacts(null)).toEqual([]);
  });
});

describe("occurrenceBody", () => {
  it("names the trigger, the scope, the submission's own idempotency key, the person and the form", () => {
    const body = occurrenceBody({
      orgId: "o", userId: "u", runId: "r", brandId: "b", offerId: "of",
      source: "gohighlevel", submissionId: "s1", submittedAt: new Date("2026-10-07T14:34:21.802Z"),
      person: { fullName: "Jane Doe", email: "jane@x.com", phone: "+12126647665", sourceContactId: "c1", crmContactId: null },
      form: { formId: "f1", formName: "Meta Ads", answers: [{ key: "k", label: "L", value: "v" }] },
    });
    expect(body).toMatchObject({
      triggerId: "form_submitted",
      brandId: "b",
      offerId: "of",
      idempotencyKey: "crm:gohighlevel:form_submission:s1",
      occurredAt: "2026-10-07T14:34:21.802Z",
    });
    expect(body.person).toEqual({ email: "jane@x.com", name: "Jane Doe", phone: "+12126647665", crmContact: { provider: "gohighlevel", contactId: "c1" } });
    expect(body.item).toMatchObject({ formName: "Meta Ads", submissionId: "s1", crmContactId: null, answers: [{ key: "k", label: "L", value: "v" }] });
  });

  it("names a fill with no email by its E.164 phone, never a made-up email (REPLY-PHONE-ONLY-1015)", () => {
    const base = {
      orgId: "o", userId: "u", runId: "r", brandId: "b", offerId: "of",
      source: "gohighlevel", submissionId: "s2", submittedAt: new Date("2026-10-07T14:34:21.802Z"),
      form: { formId: "f1", formName: "Meta Ads", answers: [] },
    };
    const body = occurrenceBody({ ...base, person: { fullName: "Jane Doe", email: null, phone: "+1 (212) 664-7665", sourceContactId: null, crmContactId: null } });
    expect(body.person).toEqual({ name: "Jane Doe", phone: "+12126647665" });
  });
});

describe("nextAttemptDue", () => {
  it("doubles from one minute, capped at an hour", () => {
    const t = new Date(0);
    expect(nextAttemptDue(0, null)).toBe(0);
    expect(nextAttemptDue(1, t)).toBe(60_000);
    expect(nextAttemptDue(3, t)).toBe(240_000);
    expect(nextAttemptDue(20, t)).toBe(3_600_000);
  });
});
