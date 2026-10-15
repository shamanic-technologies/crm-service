import { describe, it, expect } from "vitest";
import { PHONE_GIVEN_TRIGGER, phoneOccurrenceBody, phoneSkipReason, type PhoneCandidate } from "../../src/lib/phone-trigger/rules.js";
import { nextAttemptDue } from "../../src/lib/phone-trigger/watch.js";
import { derivePosthogContact } from "../../src/lib/posthog/records.js";

const base: PhoneCandidate = {
  contactId: "c1", orgId: "o", brandId: "b", source: "clerk", channel: null, phone: "+447700900001",
  email: "a@example.com", fullName: "A B", sourceContactId: "user_1", artifactId: "art",
};

describe("phone given rules (WA-GIVEN-TRIGGER-1015)", () => {
  it("skips a chat counterpart, staff and the brand's own numbers; reports anyone else", () => {
    expect(phoneSkipReason(base, null)).toBeNull();
    expect(phoneSkipReason({ ...base, channel: "whatsapp" }, null)).toBe("conversation_channel");
    expect(phoneSkipReason({ ...base, email: "kevin@distribute.you" }, null)).toBe("staff");
    // A sending-mailbox +tag identity is no staff address: a test through it stays possible.
    expect(phoneSkipReason({ ...base, email: "k.lourd+probe@trydistribute.com" }, null)).toBeNull();
    expect(phoneSkipReason(base, new Map([["447700900001", "the brand's sales rep phone"]]))).toBe("own_team");
  });

  it("names the person by the number, adds the email when held, omits absent values", () => {
    const at = new Date("2026-10-15T15:00:00Z");
    const body = phoneOccurrenceBody({ brandId: "b", offerId: "o1", phone: "+447700900001", source: "posthog", email: null, fullName: null, contactId: "c1", sourceContactId: "ph-1", detectedAt: at });
    expect(body).toEqual({
      triggerId: PHONE_GIVEN_TRIGGER,
      brandId: "b",
      offerId: "o1",
      idempotencyKey: "crm:phone_given:b:+447700900001",
      occurredAt: at.toISOString(),
      person: { phone: "+447700900001" },
      item: { kind: "phone_given", phone: "+447700900001", source: "posthog", sourceContactId: "ph-1", crmContactId: "c1", givenAt: at.toISOString() },
    });
    expect(phoneOccurrenceBody({ brandId: "b", offerId: "o1", phone: "+1", source: "clerk", email: "a@x.com", fullName: "A", contactId: null, sourceContactId: null, detectedAt: at }).person)
      .toEqual({ phone: "+1", email: "a@x.com", name: "A" });
  });

  it("backs off 1, 2, 4... minutes, capped at 60", () => {
    const t = new Date(0);
    expect(nextAttemptDue(0, null)).toBe(0);
    expect(nextAttemptDue(1, t)).toBe(60_000);
    expect(nextAttemptDue(3, t)).toBe(240_000);
    expect(nextAttemptDue(20, t)).toBe(3_600_000);
  });
});

describe("PostHog person phone", () => {
  it("reads the phone properties; a visitor known by the number alone is phoneOnly (no signup)", () => {
    const anon = derivePosthogContact({ id: "p1", email: null, is_identified: false, prop_phone: "+44 7700 900001", prop_phone_number: "", prop_phoneNumber: null });
    expect(anon).toMatchObject({ phones: ["+44 7700 900001"], phoneOnly: true, primaryEmail: null });
    expect(derivePosthogContact({ id: "p2", email: "a@x.com", prop_phone: "+447700900001" })).toMatchObject({ phoneOnly: false });
    expect(derivePosthogContact({ id: "p3", is_identified: true, prop_phone: "+447700900001" })).toMatchObject({ phoneOnly: false });
    expect(derivePosthogContact({ id: "p4", email: "a@x.com" })).toMatchObject({ phones: [], phoneOnly: false });
  });
});
