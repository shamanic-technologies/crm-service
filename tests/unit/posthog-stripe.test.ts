import { describe, it, expect } from "vitest";
import { deriveKeyEvent, derivePosthogContact, deriveVisit, visitId } from "../../src/lib/posthog/records.js";
import { lit, ts } from "../../src/lib/posthog/client.js";
import {
  deriveCharge,
  deriveRefund,
  deriveStripeCustomer,
  deriveSubscription,
  majorAmount,
} from "../../src/lib/stripe/records.js";
import { restrictedKeyMode } from "../../src/lib/stripe/client.js";
import { resolvePersonState, resolveStripeState, type StripeStandingInput } from "../../src/lib/people/state.js";
import { clusterPeople, type Presence } from "../../src/lib/people/identity.js";

const standing = (over: Partial<StripeStandingInput>): StripeStandingInput => ({
  customerId: "cus_1",
  subscriptionStatuses: [],
  paidCharges: 0,
  refundedCharges: 0,
  netPaidMinor: {},
  ...over,
});

describe("PostHog derivation", () => {
  it("an identified person keeps PostHog's id and a lower-cased email; no email = not a contact", () => {
    expect(
      derivePosthogContact({
        id: "p1",
        email: " Alice@X.com ",
        name: null,
        first_name: "Alice",
        last_name: "M",
        created_at: "2026-09-01T00:00:00Z",
      }),
    ).toMatchObject({
      externalId: "p1",
      primaryEmail: "alice@x.com",
      fullName: "Alice M",
      sourceCreatedAt: new Date("2026-09-01T00:00:00Z"),
    });
    expect(derivePosthogContact({ id: "p2", email: "" })).toBeNull();
    expect(derivePosthogContact({ id: "p3", email: null })).toBeNull();
  });

  it("a visit is one session of one person, named by its entry page", () => {
    const row = {
      session_id: "s1",
      person_id: "p1",
      started_at: "2026-09-02T10:00:00Z",
      ended_at: "2026-09-02T10:05:00Z",
      entry_url: "https://brand.com/pricing",
      entry_path: "/pricing",
      pageviews: 3,
      paths: ["/pricing", "/signup", ""],
      referrer: "$direct",
    };
    expect(visitId(row)).toBe("s1:p1");
    expect(deriveVisit(row)).toMatchObject({
      kind: "visit",
      externalId: "s1:p1",
      externalPersonId: "p1",
      name: "/pricing",
      pageviews: 3,
      detail: { sessionId: "s1", paths: ["/pricing", "/signup"], referrer: "$direct" },
    });
  });

  it("a key event keeps its own name, verbatim", () => {
    expect(
      deriveKeyEvent({
        id: "e1",
        event: "signup_completed",
        timestamp: "2026-09-02T10:01:00Z",
        person_id: "p1",
        url: "https://x/",
        path: "/",
      }),
    ).toMatchObject({ kind: "event", externalId: "e1", name: "signup_completed" });
  });

  it("HogQL literals are escaped", () => {
    expect(lit("a'b\\c")).toBe("'a\\'b\\\\c'");
    expect(ts(new Date("2026-09-02T10:01:00.123Z"))).toBe("toDateTime64('2026-09-02 10:01:00.123', 3, 'UTC')");
  });
});

describe("Stripe derivation", () => {
  it("only restricted keys are read-only keys", () => {
    expect(restrictedKeyMode("rk_live_abc")).toBe("live");
    expect(restrictedKeyMode("rk_test_abc")).toBe("test");
    expect(restrictedKeyMode("sk_live_abc")).toBeNull();
    expect(restrictedKeyMode("pk_live_abc")).toBeNull();
  });

  it("a customer, a charge, a refund and a subscription, verbatim", () => {
    expect(
      deriveStripeCustomer({
        id: "cus_1",
        email: "Alice@X.com",
        phone: "+33 6 12 34 56 78",
        name: "Alice",
        created: 1_780_000_000,
      }),
    ).toMatchObject({
      externalId: "cus_1",
      primaryEmail: "alice@x.com",
      phone: "+33 6 12 34 56 78",
    });
    expect(deriveStripeCustomer({ id: "cus_2", deleted: true })).toBeNull();

    expect(
      deriveCharge({
        id: "ch_1",
        customer: "cus_1",
        amount: 9900,
        currency: "usd",
        status: "succeeded",
        created: 1_780_000_100,
        refunded: false,
        amount_refunded: 0,
      }),
    ).toMatchObject({
      kind: "payment",
      externalCustomerId: "cus_1",
      amountMinor: 9900,
      currency: "usd",
      status: "succeeded",
    });

    expect(
      deriveRefund(
        {
          id: "re_1",
          charge: "ch_1",
          amount: 1000,
          currency: "usd",
          status: "succeeded",
          created: 1_780_000_200,
          reason: "requested_by_customer",
        },
        (c) => (c === "ch_1" ? "cus_1" : null),
      ),
    ).toMatchObject({ kind: "refund", externalCustomerId: "cus_1", amountMinor: 1000 });

    const sub = deriveSubscription({
      id: "sub_1",
      customer: "cus_1",
      status: "active",
      currency: "usd",
      start_date: 1_780_000_000,
      canceled_at: null,
      items: {
        data: [
          {
            quantity: 2,
            price: { id: "price_1", unit_amount: 4900, currency: "usd", recurring: { interval: "month" } },
          },
        ],
      },
    });
    expect(sub).toMatchObject({
      kind: "subscription",
      amountMinor: 9800,
      status: "active",
      detail: { interval: "month", canceledAt: null },
    });

    // A metered price has no unit amount: the period amount is unknown, never guessed.
    expect(
      deriveSubscription({
        id: "sub_2",
        customer: "cus_1",
        status: "active",
        start_date: 1,
        items: { data: [{ price: { unit_amount: null } }] },
      })!.amountMinor,
    ).toBeNull();
  });

  it("zero-decimal currencies are not divided", () => {
    expect(majorAmount(9900, "usd")).toBe(99);
    expect(majorAmount(500, "jpy")).toBe(500);
    expect(majorAmount(null, "usd")).toBeNull();
  });
});

describe("Stripe state", () => {
  it("live subscription > paid > refunded > canceled > nothing", () => {
    expect(resolveStripeState([standing({ subscriptionStatuses: ["canceled", "past_due"], paidCharges: 3 })])).toBe(
      "subscription_past_due",
    );
    expect(resolveStripeState([standing({ subscriptionStatuses: ["canceled"], paidCharges: 1 })])).toBe("paid");
    expect(resolveStripeState([standing({ refundedCharges: 1 })])).toBe("refunded");
    expect(resolveStripeState([standing({ subscriptionStatuses: ["canceled"] })])).toBe("subscription_canceled");
    expect(resolveStripeState([standing({ subscriptionStatuses: ["incomplete"] })])).toBeNull();
    expect(resolveStripeState([])).toBeNull();
  });

  const base = { leadObservations: [], ghlDeals: [], stripe: [], matrixStatuses: [], instantly: null };

  it("outranks a CRM deal, never lead-service", () => {
    const paying = [standing({ subscriptionStatuses: ["active"] })];
    expect(
      resolvePersonState({
        ...base,
        stripe: paying,
        ghlDeals: [{ status: "open", pipelineName: null, stageName: null, updatedAt: null }],
      }),
    ).toMatchObject({ state: "subscription_active", stateSource: "stripe" });
    expect(
      resolvePersonState({
        ...base,
        stripe: paying,
        leadObservations: [
          {
            found: true,
            email: "a@x.com",
            standing: { state: "customer" },
            leadCampaignId: "lc",
            leadId: null,
            campaignId: null,
            campaignIds: [],
          },
        ],
      }),
    ).toMatchObject({ state: "customer", stateSource: "lead_service" });
    // A customer record stating nothing falls through to the next source.
    expect(resolvePersonState({ ...base, stripe: [standing({})], matrixStatuses: ["new"] })).toMatchObject({
      stateSource: "matrix",
    });
  });
});

describe("PostHog and Stripe in the merge", () => {
  const presence = (over: Partial<Presence>): Presence => ({
    source: "posthog",
    sourceRef: "x",
    displayName: null,
    company: null,
    emails: [],
    phones: [],
    firstActivityAt: null,
    lastActivityAt: null,
    messageCount: null,
    inboundCount: null,
    outboundCount: null,
    detail: {},
    ...over,
  });

  it("the same email on PostHog and Stripe is one person; a Stripe phone ties a WhatsApp thread", () => {
    const out = clusterPeople(
      [
        presence({ source: "posthog", sourceRef: "ph1", emails: ["alice@x.com"] }),
        presence({ source: "stripe", sourceRef: "st1", emails: ["alice@x.com"], phones: ["+33612345678"] }),
        presence({ source: "matrix", sourceRef: "mx1", phones: ["+33612345678"] }),
        presence({ source: "posthog", sourceRef: "ph2", emails: ["dave@z.com"] }),
      ],
      [],
    );
    expect(out.map((p) => [p.personKey, p.presences.map((x) => x.source).sort()])).toEqual([
      ["email:alice@x.com", ["matrix", "posthog", "stripe"]],
      ["email:dave@z.com", ["posthog"]],
    ]);
  });
});
