import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BRAND_MIN_PROBABILITY,
  clip,
  conversationKeysOf,
  hidesConversation,
  isPersonalChannelOnly,
  judgeConversation,
  needsJudgment,
  personRelevance,
  type BrandContext,
  type ConversationInput,
  type RecordedVerdict,
} from "../../src/lib/people/relevance.js";

const presence = (source: string, extra: Record<string, unknown> = {}) => ({
  source,
  emails: [] as string[],
  displayName: null,
  lastActivityAt: "2026-10-01T00:00:00Z",
  messageCount: 3,
  detail: {},
  ...extra,
});
const gmail = (email: string) => presence("gmail", { emails: [email] });
const matrix = (conversationId: string) => presence("matrix", { detail: { conversationId } });

const verdict = (topic: RecordedVerdict["topic"], brandProbability: number, offerIds: string[] = []): RecordedVerdict => ({
  topic,
  confidence: 0.9,
  brandProbability,
  offerIds,
});

describe("hidesConversation", () => {
  it("hides only below the bar: a hesitant verdict stays visible", () => {
    expect(BRAND_MIN_PROBABILITY).toBe(0.15);
    expect(hidesConversation({ brandProbability: 0.05 })).toBe(true);
    expect(hidesConversation({ brandProbability: 0.149 })).toBe(true);
    expect(hidesConversation({ brandProbability: 0.15 })).toBe(false);
    expect(hidesConversation({ brandProbability: 0.6 })).toBe(false);
  });
});

describe("needsJudgment", () => {
  const stored = { ...verdict("personal", 0.1), judgedThrough: "m1", contextHash: "h1" };
  it("judges a new conversation, re-judges a moved one or a changed brand context, never an unchanged one", () => {
    expect(needsJudgment(undefined, "m1", "h1")).toBe(true);
    expect(needsJudgment(stored, "m1", "h1")).toBe(false);
    expect(needsJudgment(stored, "m2", "h1")).toBe(true);
    expect(needsJudgment(stored, "m1", "h2")).toBe(true);
  });
});

describe("isPersonalChannelOnly", () => {
  it("is true for a person seen on Gmail / Matrix alone", () => {
    expect(isPersonalChannelOnly({ presences: [gmail("a@x.com"), matrix("c1")] }, false)).toBe(true);
  });
  it("is false as soon as a business source knows the person", () => {
    for (const s of ["instantly", "gohighlevel", "stripe", "posthog"]) {
      expect(isPersonalChannelOnly({ presences: [gmail("a@x.com"), presence(s)] }, false)).toBe(false);
    }
    expect(isPersonalChannelOnly({ presences: [gmail("a@x.com")], evidence: [{ kind: "csv_contact" }] }, false)).toBe(false);
    expect(isPersonalChannelOnly({ presences: [gmail("a@x.com")], evidence: [{ kind: "lead_pairing" }] }, false)).toBe(false);
    expect(isPersonalChannelOnly({ presences: [gmail("a@x.com")] }, true)).toBe(false);
  });
  it("an address-book entry is not a business record", () => {
    expect(isPersonalChannelOnly({ presences: [gmail("a@x.com")], evidence: [{ kind: "google_contact" }] }, false)).toBe(true);
  });
});

describe("personRelevance", () => {
  const person = { presences: [gmail("mom@x.com"), matrix("c1")] };

  it("hides a personal-channel person only when EVERY conversation was judged not about the brand", () => {
    const all = new Map([
      ["gmail:mom@x.com", verdict("personal", 0.02)],
      ["matrix:c1", verdict("other_business", 0.1)],
    ]);
    expect(conversationKeysOf(person)).toEqual(["gmail:mom@x.com", "matrix:c1"]);
    expect(personRelevance(person, all, false).notBusiness).toBe(true);

    const oneUnjudged = new Map([["gmail:mom@x.com", verdict("personal", 0.02)]]);
    expect(personRelevance(person, oneUnjudged, false).notBusiness).toBe(false);

    const oneAboutBrand = new Map([
      ["gmail:mom@x.com", verdict("personal", 0.02)],
      ["matrix:c1", verdict("this_brand", 0.8, ["offer-a"])],
    ]);
    const r = personRelevance(person, oneAboutBrand, false);
    expect(r.notBusiness).toBe(false);
    expect(r.offerIds).toEqual(["offer-a"]);
  });

  it("never hides a person a business source knows, even when every conversation is personal", () => {
    const all = new Map([
      ["gmail:mom@x.com", verdict("personal", 0.02)],
      ["matrix:c1", verdict("personal", 0.02)],
    ]);
    expect(personRelevance({ presences: [...person.presences, presence("stripe")] }, all, false).notBusiness).toBe(false);
    expect(personRelevance(person, all, true).notBusiness).toBe(false);
  });

  it("a person with no personal-channel conversation carries no relevance", () => {
    expect(personRelevance({ presences: [presence("instantly")] }, new Map(), false)).toEqual({
      notBusiness: false,
      offerIds: [],
      relevance: null,
    });
  });
});

describe("judgeConversation", () => {
  const context: BrandContext = {
    brand: { name: "Acme", website: "acme.com", description: "Acme sells software." },
    offers: [
      { offerId: "offer-a", name: "Pro plan", description: null },
      { offerId: "offer-b", name: "Angel round", description: null },
    ],
    otherBrandsOfTheSameOwner: [{ name: "Other Co", website: "other.co" }],
    hash: "h",
  };
  const input: ConversationInput = {
    key: "gmail:a@x.com",
    source: "gmail",
    judgedThrough: "m1",
    channel: "email",
    counterpart: { names: ["A"], email: "a@x.com", phone: null },
    messages: [{ at: "2026-10-01T00:00:00Z", direction: "inbound", subject: "Pricing", text: "How much is Pro?" }],
  };
  const tracking = { orgId: "o", userId: "u", runId: "r", brandIds: ["b"] };
  let body: { state: Record<string, unknown>; questions: Record<string, { type: string }> } | null = null;

  function stub(answers: Record<string, unknown>) {
    process.env.CHAT_SERVICE_URL = "http://chat.test";
    process.env.CHAT_SERVICE_API_KEY = "k";
    vi.stubGlobal("fetch", async (url: string, init: RequestInit) => {
      expect(String(url)).toBe("http://chat.test/orgs/judgments");
      body = JSON.parse(String(init.body));
      return new Response(JSON.stringify({ model: "jev-test", answers, usage: { inputTokens: 1, outputTokens: 0 } }), { status: 200 });
    });
  }
  afterEach(() => vi.unstubAllGlobals());

  it("asks one topic choice and one yes/no per active offer, and tags the offers Jev says yes to", async () => {
    stub({
      topic: { type: "choice", choice: "this_brand", confidence: 0.8, probabilities: { personal: 0.05, other_business: 0.05, this_brand: 0.9 } },
      o0: { type: "noul", noul: 0.93 },
      o1: { type: "noul", noul: 0.1 },
    });
    const v = await judgeConversation(input, context, tracking);
    expect(Object.keys(body!.questions)).toEqual(["topic", "o0", "o1"]);
    expect(body!.questions.o0.type).toBe("noul");
    expect(v).toMatchObject({ topic: "this_brand", brandProbability: 0.9, offerIds: ["offer-a"], model: "jev-test" });
    expect(v.offerScores).toEqual({ "offer-a": 0.93, "offer-b": 0.1 });
  });

  it("never tags an offer on a conversation hidden as not about the brand", async () => {
    stub({
      topic: { type: "choice", choice: "personal", confidence: 0.9, probabilities: { personal: 0.9, other_business: 0.05, this_brand: 0.05 } },
      o0: { type: "noul", noul: 0.7 },
      o1: { type: "noul", noul: 0.1 },
    });
    const v = await judgeConversation(input, context, tracking);
    expect(v.offerIds).toEqual([]);
  });

  it("fails loud on an unknown topic or a missing offer answer", async () => {
    stub({ topic: { type: "choice", choice: "family", confidence: 1, probabilities: { family: 1 } } });
    await expect(judgeConversation(input, context, tracking)).rejects.toThrow(/unknown topic "family"/);
    stub({
      topic: { type: "choice", choice: "this_brand", confidence: 1, probabilities: { this_brand: 1 } },
      o0: { type: "noul", noul: 0.5 },
    });
    await expect(judgeConversation(input, context, tracking)).rejects.toThrow(/no answer for offer offer-b/);
  });
});

describe("clip", () => {
  it("never cuts inside an emoji and drops a lone surrogate (Jev refuses invalid Unicode)", () => {
    const text = "a".repeat(399) + "😀" + "tail";
    const out = clip(text);
    expect(out).toBe("a".repeat(399) + "😀…");
    expect(clip("broken \uD83D end")).toBe("broken \uFFFD end");
    expect(clip("short")).toBe("short");
  });
});
