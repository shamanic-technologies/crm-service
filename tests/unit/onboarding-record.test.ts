import { describe, expect, it } from "vitest";
import { keyWords, recordText, valueLines, type OnboardingRecord } from "../../src/lib/onboarding/record.js";
import { sentByOf, withoutTransactionalCopies, type TimelineItem } from "../../src/lib/people/timeline.js";

const LONG_AUDIENCE =
  "Founders, CEOs and Operations Directors at US-based service businesses and mid-market healthcare agencies with 10 to 100 employees and $2M to $20M in annual revenue, who would commission custom internal tools, client portals or workflow automations.";

const chaim: OnboardingRecord = {
  orgId: "8c043fa7-88b9-4e92-a96b-3dab875cb465",
  orgName: "Beyond Logic",
  userId: "e645d275-0d01-49fc-8894-4dd6c00fa12c",
  email: "chaim@beyondlogic.tech",
  brand: { id: "33211c62-b34b-4d21-b124-4ff16338c800", name: "Beyond Logic", website: "https://beyondlogic.tech" },
  latestChangeAt: "2026-10-27T17:45:34.249Z",
  offers: [
    {
      offerId: "43870a82-f1fb-4ad4-82d9-5909fc84447c",
      name: "Fixed-Price Software Build",
      description: "Custom software development delivered in 30 days for a fixed fee with full code ownership.",
      status: "active",
      fields: [
        { key: "services", value: ["Fixed-price custom software build: $25K, 30 days"], provenance: "confirmed" },
        { key: "giveForFree", value: ["Written project scope, whether or not you hire", "Senior builder scope review within 48 hours"], provenance: "confirmed" },
        { key: "neverGive", value: ["Hourly billing", "Change fees or surprise invoices"], provenance: "confirmed" },
        { key: "targetAudience", value: ["ABA therapy agencies"], provenance: "suggested" },
        { key: "urgency", value: "Every month working around a broken process costs money\nStart now to have it running before the new year", provenance: "confirmed" },
      ],
      clientValueUsd: 50000,
      bookingUrl: "https://calendly.com/chaim-beyondlogic/15-minute-intro",
      destinationUrl: null,
      signals: [
        { id: "s1", title: "Lacks client portal login", question: "Does the company homepage lack any visible client login, patient portal, or member dashboard button?", enabled: true },
        { id: "s2", title: "Hiring software developers", question: "Is the company currently advertising open job postings for software engineers or developers?", enabled: false },
      ],
      audiences: [{ id: "a1", name: "Founders/CEOs, Service Firms", description: "Founders and CEOs at US-based service businesses with 10 to 100 employees.", targetText: LONG_AUDIENCE, status: "active" }],
      campaigns: [
        { id: "c1", name: "Wide Email Replies 23", status: "ongoing", stopReason: null, createdAt: "2026-10-27T17:44:27.434Z", maxBudget: { amountCents: "1000", period: "monthly" }, maxVolume: null, funnelType: "proactive" },
        { id: "c2", name: "Reply Booking", status: "ongoing", stopReason: null, createdAt: "2026-10-27T17:45:34.249Z", maxBudget: { amountCents: "1000", period: "monthly" }, maxVolume: null, funnelType: "reactive" },
      ],
    },
  ],
};

describe("onboarding record text (ONBOARDING-FICHE-1027)", () => {
  const text = recordText(chaim);

  it("holds every choice in full, nothing cut, once", () => {
    expect(text).toContain("Brand: Beyond Logic, website https://beyondlogic.tech");
    expect(text).toContain("Offer: Fixed-Price Software Build");
    expect(text).toContain("Custom software development delivered in 30 days for a fixed fee with full code ownership.");
    expect(text).toContain(`Who exactly: ${LONG_AUDIENCE}`);
    expect(text).toContain("Lacks client portal login: Does the company homepage lack any visible client login, patient portal, or member dashboard button?");
    expect(text).toContain("Client value: $50,000 per client");
    expect(text).toContain("Campaign: Wide Email Replies 23, live, created 2026-10-27 17:44 UTC");
    expect(text).toContain("Max budget $10 per month");
    expect(text).toContain("Up to $10 per month");
    expect(text).toContain("    - Senior builder scope review within 48 hours");
    expect(text).toContain("    - Start now to have it running before the new year");
    expect(text).not.toContain("...");
    expect(text).not.toContain("…");
    expect(text.split("Offer: Fixed-Price Software Build").length).toBe(2);
  });

  it("keeps the signals they kept apart from the ones they left off", () => {
    expect(text.indexOf("Signals they kept on:")).toBeLessThan(text.indexOf("Lacks client portal login"));
    expect(text.indexOf("Signals offered, left off:")).toBeLessThan(text.indexOf("Hiring software developers"));
  });

  it("says when a field is still our suggestion", () => {
    expect(text).toContain("Target audience (suggested, not confirmed by them):");
    expect(text).toContain("Give for free:");
    expect(text).toContain("Never give:");
  });

  it("writes no dash a reader would see as ours", () => {
    expect(text).not.toMatch(/[–—]/);
  });

  it("names a key in words and splits values into lines", () => {
    expect(keyWords("dreamOutcome")).toBe("Dream outcome");
    expect(keyWords("give_for_free")).toBe("Give for free");
    expect(valueLines(["a", "b\nc", null])).toEqual(["a", "b", "c"]);
    expect(valueLines(50000)).toEqual(["50000"]);
  });
});

const item = (over: Partial<TimelineItem>): TimelineItem => ({
  at: "2026-10-27T17:38:26.000Z",
  source: "gmail",
  channel: "email",
  kind: "message",
  direction: "other",
  subject: "Revenue made easy. Starts here.",
  text: "Revenue made easy.",
  from: "growth@distribute.you",
  to: ["chaim@beyondlogic.tech"],
  ref: {},
  textClean: null,
  outreachFact: null,
  event: null,
  ...over,
});

describe("who sent it (sentBy)", () => {
  it("labels our machines automation and a typed WhatsApp person", () => {
    const auto = new Set(["$ours"]);
    expect(sentByOf(item({ source: "transactional", direction: "outbound" }), auto)).toBe("automation");
    expect(sentByOf(item({ source: "copilot", direction: "outbound" }), auto)).toBe("automation");
    expect(sentByOf(item({ source: "matrix", direction: "outbound", ref: { eventId: "$ours" } }), auto)).toBe("automation");
    expect(sentByOf(item({ source: "matrix", direction: "outbound", ref: { eventId: "$typed" } }), auto)).toBe("person");
    expect(sentByOf(item({ source: "gmail", direction: "outbound" }), auto)).toBeNull();
    expect(sentByOf(item({ source: "matrix", direction: "inbound" }), auto)).toBeNull();
    expect(sentByOf(item({ source: "onboarding", kind: "event", direction: null }), auto)).toBeNull();
  });
});

describe("Gmail copies of our transactional emails", () => {
  const sends = [
    { recipientEmail: "chaim@beyondlogic.tech", subject: "Revenue made easy. Starts here.", sentAt: new Date("2026-10-27T17:38:27.246Z") },
    { recipientEmail: "fanoikijoshua@gmail.com", subject: "Revenue made easy. Starts here.", sentAt: new Date("2026-10-27T13:23:09.973Z") },
  ];

  it("drops the copy of his own welcome and another client's welcome threaded with it", () => {
    const own = item({});
    const joshua = item({ at: "2026-10-27T13:23:09.000Z", to: ["fanoikijoshua@gmail.com"] });
    const typed = item({ subject: "Quick question", direction: "outbound" });
    const reply = item({ direction: "inbound", from: "chaim@beyondlogic.tech", to: ["growth@distribute.you"] });
    expect(withoutTransactionalCopies([joshua, own, typed, reply], sends)).toEqual([typed, reply]);
  });

  it("keeps a same-subject email sent far from any transactional send", () => {
    const later = item({ at: "2026-10-29T10:00:00.000Z" });
    expect(withoutTransactionalCopies([later], sends)).toEqual([later]);
  });
});
