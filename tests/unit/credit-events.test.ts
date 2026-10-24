import { describe, it, expect } from "vitest";
import {
  ACCOUNT_EVENT_TRIGGER,
  creditEventText,
  creditIdempotencyKey,
  creditOccurrenceBody,
  memberEmailsOf,
  parseFeedPage,
  reportOffers,
  reportVerdict,
} from "../../src/lib/credit-events/rules.js";
import { creditCandidateFacts } from "../../src/lib/people/facts.js";

const ORG = "f00c29d0-a41f-41a3-b8b3-471a10c96277";
const EP = "aaaaaaaa-1111-4111-8111-000000000001";

describe("credit events, pure rules (CREDIT-RAN-OUT-UNIBOX-EVENT-1024)", () => {
  it("parses billing's page and refuses a malformed event loud", () => {
    const page = parseFeedPage({
      events: [{ eventId: `${EP}:ran_out`, type: "credit_ran_out", orgId: ORG, episodeId: EP, at: "2026-10-02T10:00:00.000Z" }],
      nextCursor: "c1",
      hasMore: false,
    });
    expect(page).toEqual({
      events: [{ eventId: `${EP}:ran_out`, type: "credit_ran_out", orgId: ORG, episodeId: EP, at: "2026-10-02T10:00:00.000Z" }],
      nextCursor: "c1",
      hasMore: false,
    });
    expect(() => parseFeedPage({ events: [{ eventId: "x", type: "credit_paused", orgId: ORG, episodeId: EP, at: "2026-10-02" }], hasMore: false })).toThrow(/unknown type/);
    expect(() => parseFeedPage({ events: [], nextCursor: null })).toThrow(/hasMore/);
  });

  it("people = every member address, normalized, staff dropped", () => {
    expect(memberEmailsOf(["Jane@Acme.io", "jane@acme.io", "kevin@distribute.you", "kevin.lourd+x@gmail.com", null, "bob@acme.io"])).toEqual([
      "bob@acme.io",
      "jane@acme.io",
    ]);
  });

  it("words on the thread", () => {
    expect(creditEventText("credit_ran_out", "Olive")).toBe("Credit ran out · Olive");
    expect(creditEventText("credit_restored", null)).toBe("Credit restored");
  });

  it("never history: before the first pass or older than 24 h is never reported", () => {
    const watch = new Date("2026-10-24T12:00:00Z");
    const now = Date.parse("2026-10-24T13:00:00Z");
    expect(reportVerdict(new Date("2026-10-18T09:00:00Z"), watch, now)).toEqual({ status: "skipped", reason: "before_watch" });
    expect(reportVerdict(new Date("2026-10-24T12:30:00Z"), watch, now)).toEqual({ status: "pending" });
    expect(reportVerdict(new Date("2026-10-24T12:30:00Z"), watch, now + 25 * 3600_000)).toEqual({ status: "skipped", reason: "stale" });
  });

  it("offers: the person's tagged active offers, else every active offer", () => {
    expect(reportOffers(["o2", "archived"], ["o1", "o2"])).toEqual(["o2"]);
    expect(reportOffers([], ["o2", "o1"])).toEqual(["o1", "o2"]);
    expect(reportOffers(["o1"], [])).toEqual([]);
  });

  it("the door body: the GENERIC account_event trigger, the credit kind in item, one key per (event, address, offer)", () => {
    const body = creditOccurrenceBody({
      brandId: "b",
      offerId: "o1",
      email: "jane@acme.io",
      name: "Jane",
      eventId: `${EP}:ran_out`,
      type: "credit_ran_out",
      creditOrgId: ORG,
      episodeId: EP,
      orgLabel: "Acme",
      at: new Date("2026-10-24T12:30:00Z"),
    });
    expect(body).toMatchObject({
      triggerId: ACCOUNT_EVENT_TRIGGER,
      offerId: "o1",
      person: { email: "jane@acme.io", name: "Jane" },
      occurredAt: "2026-10-24T12:30:00.000Z",
      item: { kind: "credit_ran_out", text: "Credit ran out · Acme", accountOrgId: ORG, episodeId: EP },
    });
    expect(body.idempotencyKey).toBe(creditIdempotencyKey(`${EP}:ran_out`, "Jane@Acme.io", "o1"));
    expect(body.idempotencyKey).not.toBe(creditIdempotencyKey(`${EP}:ran_out`, "jane@acme.io", "o2"));
  });

  it("facts: one per (event, member address), history keyed on billing's event id", () => {
    const facts = creditCandidateFacts([
      { eventId: `${EP}:ran_out`, type: "credit_ran_out", creditOrgId: ORG, episodeId: EP, at: new Date("2026-10-02T10:00:00Z"), orgLabel: "Aireena", memberEmails: ["a@x.io", "b@x.io"] },
      { eventId: `${EP}:restored`, type: "credit_restored", creditOrgId: ORG, episodeId: EP, at: new Date("2026-10-03T10:00:00Z"), orgLabel: null, memberEmails: [] },
    ]);
    expect(facts.map((f) => [f.naturalKey, f.type, f.source, f.family, f.occurredAt, f.dateBasis, f.subject.keys])).toEqual([
      [`billing|${EP}:ran_out|a@x.io`, "credit_ran_out", "billing", "billing_credit", "2026-10-02T10:00:00.000Z", "credit_ran_out_at", ["email:a@x.io"]],
      [`billing|${EP}:ran_out|b@x.io`, "credit_ran_out", "billing", "billing_credit", "2026-10-02T10:00:00.000Z", "credit_ran_out_at", ["email:b@x.io"]],
    ]);
    expect(facts[0].subject.standalone).toBe(false);
  });
});
