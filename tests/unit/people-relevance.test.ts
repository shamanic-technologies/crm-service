import { describe, it, expect, vi, afterEach } from "vitest";
import {
  BRAND_MIN_PROBABILITY,
  clip,
  clipEnds,
  conversationKeysOf,
  gmailMessages,
  offersShownToJev,
  whatWeOfferOf,
  hidesConversation,
  isPersonalChannelOnly,
  judgeConversation,
  needsJudgment,
  personRelevance,
  readBrandContext,
  threadWindow,
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
  content: "readable",
  topic,
  confidence: 0.9,
  brandProbability,
  offerIds,
  tags: null,
  tagScores: null,
  userIds: [],
});

/** The four connection-tag answers every conversation judgment now carries (CONNECTION-TAGS-1017). */
const TAG_ANSWERS = {
  t_personal_to_user: { type: "noul", noul: 0.1 },
  t_personal_not_to_user: { type: "noul", noul: 0.05 },
  t_professional_to_brand: { type: "noul", noul: 0.9 },
  t_professional_not_to_brand: { type: "noul", noul: 0.1 },
};

describe("hidesConversation", () => {
  it("hides below the owner's 0.50 line (Alejandro's 0.47 photo-only thread hides, 0.5 stays)", () => {
    expect(BRAND_MIN_PROBABILITY).toBe(0.5);
    expect(hidesConversation({ brandProbability: 0.05 })).toBe(true);
    expect(hidesConversation({ brandProbability: 0.47 })).toBe(true);
    expect(hidesConversation({ brandProbability: 0.5 })).toBe(false);
    expect(hidesConversation({ brandProbability: 0.6 })).toBe(false);
  });
  it("a conversation with nothing a person wrote is no evidence of the brand", () => {
    expect(hidesConversation({ content: "none", brandProbability: null })).toBe(true);
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

  it("content-free conversations never keep a personal-channel person visible; an unjudged one still does", () => {
    const none: RecordedVerdict = { content: "none", topic: null, confidence: null, brandProbability: null, offerIds: [] };
    const alejandro = new Map([
      ["gmail:mom@x.com", verdict("personal", 0.01)],
      ["matrix:c1", none],
    ]);
    const r = personRelevance(person, alejandro, false);
    expect(r.notBusiness).toBe(true);
    expect(r.relevance?.[1]).toMatchObject({ conversation: "matrix:c1", content: "none", topic: null, brandProbability: null });
    expect(personRelevance(person, new Map([["matrix:c1", none]]), false).notBusiness).toBe(false);
    expect(personRelevance({ presences: [matrix("c1")] }, new Map([["matrix:c1", none]]), false).notBusiness).toBe(true);
    expect(personRelevance({ presences: [matrix("c1"), presence("instantly")] }, new Map([["matrix:c1", none]]), false).notBusiness).toBe(false);
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
      { offerId: "offer-a", name: "Pro plan", whatWeOffer: null },
      { offerId: "offer-b", name: "Angel round", whatWeOffer: null },
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
      return new Response(JSON.stringify({ model: "jev-test", answers: { ...TAG_ANSWERS, ...answers }, usage: { inputTokens: 1, outputTokens: 0 } }), {
        status: 200,
      });
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
    expect(Object.keys(body!.questions)).toEqual([
      "topic",
      "t_personal_to_user",
      "t_personal_not_to_user",
      "t_professional_to_brand",
      "t_professional_not_to_brand",
      "o0",
      "o1",
    ]);
    expect(body!.questions.o0.type).toBe("noul");
    expect(v).toMatchObject({ topic: "this_brand", brandProbability: 0.9, offerIds: ["offer-a"], model: "jev-test" });
    expect(v.offerScores).toEqual({ "offer-a": 0.93, "offer-b": 0.1 });
  });

  it("asks for SALES LEADS only: suppliers, accountant, mentors and investors are other work (owner 2026-10-10)", async () => {
    stub({
      topic: { type: "choice", choice: "this_brand", confidence: 0.8, probabilities: { personal: 0.05, other_business: 0.05, this_brand: 0.9 } },
      o0: { type: "noul", noul: 0.1 },
      o1: { type: "noul", noul: 0.1 },
    });
    await judgeConversation(input, context, tracking);
    const topic = body!.questions.topic as unknown as { criteria: Record<string, string> };
    expect(topic.criteria.this_brand).toMatch(/SALES LEAD/);
    for (const who of ["supplier", "accountant", "mentors", "investors"]) expect(topic.criteria.other_business).toContain(who);
    expect(topic.criteria.this_brand).not.toMatch(/supplier|accountant|mentor|investor/);
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

  it("CONNECTION-TAGS-1017: asks the four tags with the user and what the brand knows of the person, keeps every tag >= 0.5", async () => {
    stub({
      topic: { type: "choice", choice: "this_brand", confidence: 0.8, probabilities: { personal: 0.3, other_business: 0.05, this_brand: 0.65 } },
      t_personal_to_user: { type: "noul", noul: 0.7 },
      o0: { type: "noul", noul: 0.1 },
      o1: { type: "noul", noul: 0.1 },
    });
    const user = { channel: "whatsapp", account: "Kevin", users: [{ name: "Kevin Lourd", emails: ["kevin@x.com"], phones: ["+33600000000"] }] };
    const person = { knownBy: ["stripe"], company: "Acme", emailDomains: ["acme.com"] };
    const v = await judgeConversation({ ...input, user, userIds: ["u1"], person }, context, tracking);
    expect(body!.state.user).toEqual(user);
    expect(body!.state.counterpartKnownByTheBrand).toEqual(person);
    expect(JSON.stringify(body!.state)).not.toContain("u1");
    expect(v.tags).toEqual(["personal_to_user", "professional_to_brand"]);
    expect(v.tagScores.personal_to_user).toBe(0.7);
  });

  it("fails loud when a tag answer is missing", async () => {
    stub({
      topic: { type: "choice", choice: "this_brand", confidence: 1, probabilities: { this_brand: 1 } },
      t_professional_to_brand: { type: "choice" },
      o0: { type: "noul", noul: 0.5 },
      o1: { type: "noul", noul: 0.5 },
    });
    await expect(judgeConversation(input, context, tracking)).rejects.toThrow(/no answer for tag professional_to_brand/);
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

describe("WA-LEAD-RELEVANCE-1016: a supplier or another activity of the owner is not a lead of the brand", () => {
  const context: BrandContext = {
    brand: { name: "Distribute.you", website: "distribute.you", description: null },
    offers: [
      {
        offerId: "offer-a",
        name: "Product-led",
        whatWeOffer: "Meetings on your calendar with buyers who asked for them.",
      },
    ],
    otherBrandsOfTheSameOwner: [],
    hash: "h",
  };
  const tracking = { orgId: "o", userId: "u", runId: "r", brandIds: ["b"] };
  const thread = (texts: [string, string][]): ConversationInput => ({
    key: "matrix:c1",
    source: "matrix",
    judgedThrough: "e1",
    channel: "whatsapp",
    counterpart: { names: [], email: null, phone: null },
    messages: texts.map(([direction, text]) => ({ at: null, direction, text })),
  });
  // Prod 2026-10-16 (live Jev, before -> after): Vino Shan's no2bounce pitch 0.87 -> 0.00,
  // Faysal's Brazil residency 0.81 -> 0.13, a Da Nang co-living room 0.50 -> 0.00.
  const SUPPLIER = thread([
    ["inbound", "Hi Kevin, I'm Vino from no2bounce. Our email validation SaaS beats ZeroBounce on price, want a free trial?"],
    ["outbound", "Thanks, not now"],
  ]);
  const OTHER_ACTIVITY = thread([
    ["inbound", "What are the fees for the Brazil residency? Is the fast track visa possible from Dubai?"],
    ["outbound", "Fast track is $15,000 fees, I'll send the invoice"],
  ]);
  let body: { state: { offers: { name: string; whatWeOffer: string | null }[] }; questions: { topic: { instructions: string; criteria: Record<string, string> } } } | null =
    null;
  function stubJev(probabilities: Record<string, number>) {
    process.env.CHAT_SERVICE_URL = "http://chat.test";
    process.env.CHAT_SERVICE_API_KEY = "k";
    vi.stubGlobal("fetch", async (_url: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      return new Response(
        JSON.stringify({
          model: "jev-test",
          answers: { ...TAG_ANSWERS, topic: { type: "choice", choice: "other_business", confidence: 0.9, probabilities }, o0: { type: "noul", noul: 0.6 } },
        }),
        { status: 200 },
      );
    });
  }
  afterEach(() => vi.unstubAllGlobals());

  for (const [name, input] of [["a vendor pitching its own product", SUPPLIER], ["the owner's other activity (residency help)", OTHER_ACTIVITY]] as const) {
    it(`${name}: Jev is shown what the brand sells and told such a thread is other work, and its answer hides it`, async () => {
      stubJev({ personal: 0.02, other_business: 0.9, this_brand: 0.08 });
      const v = await judgeConversation(input, context, tracking);
      expect(body!.state.offers[0]).toEqual({ key: "o0", name: "Product-led", whatWeOffer: context.offers[0].whatWeOffer });
      const topic = body!.questions.topic;
      expect(topic.criteria.other_business).toMatch(/SELLER and the owner the buyer/);
      expect(topic.criteria.other_business).toMatch(/OTHER activities/);
      expect(topic.criteria.other_business).toMatch(/residency or visa help/);
      expect(topic.criteria.other_business).toMatch(/co-living/);
      expect(topic.instructions).toMatch(/who pays whom/);
      expect(hidesConversation(v)).toBe(true);
      expect(v.offerIds).toEqual([]);
    });
  }

  it("a client whose account the owner runs stays this brand's lead (Senthil, Olive)", async () => {
    stubJev({ personal: 0, other_business: 0.02, this_brand: 0.98 });
    await judgeConversation(thread([["outbound", "Your credit ran out, add $100 in Billing and we match it"]]), context, tracking);
    expect(body!.questions.topic.criteria.this_brand).toMatch(/A CLIENT or user stays a sales lead/);
    // A client of the brand's service is not "work for another company".
    expect(body!.questions.topic.criteria.other_business).not.toMatch(/runs or serves/);
  });
});

describe("threadWindow", () => {
  it("keeps the first 10 (where the deal is named) and the last 20 (where it stands), oldest first", () => {
    const all = Array.from({ length: 50 }, (_, i) => i);
    expect(threadWindow(all)).toEqual([...all.slice(0, 10), ...all.slice(30)]);
    expect(threadWindow(all.slice(0, 30))).toEqual(all.slice(0, 30));
  });
});

describe("readBrandContext", () => {
  afterEach(() => vi.unstubAllGlobals());
  it("WHOLE-THREAD-JEV-1021: each ACTIVE offer as the client created it (name + Service sold, else its text), never its Q&A", async () => {
    process.env.BRAND_SERVICE_URL = "http://brand.test";
    process.env.BRAND_SERVICE_API_KEY = "k";
    const asked: string[] = [];
    let overview = "Distribute.you gets B2B meetings.";
    let services: unknown = ["Autonomous multi-channel acquisition", " Cold email "];
    vi.stubGlobal("fetch", async (url: string) => {
      const u = new URL(url);
      asked.push(u.pathname + u.search);
      const json = (b: unknown) => new Response(JSON.stringify(b), { status: 200, headers: { "content-type": "application/json" } });
      if (u.pathname.endsWith("/offers")) {
        return json({
          offers: [
            { offerId: "o-active", name: "Product-led", description: " Done-for-you outbound that books meetings. ", status: "active" },
            { offerId: "o-blank", name: "Sales-led", description: "  ", status: "active" },
            { offerId: "o-archived", name: "Angel round", description: null, status: "archived" },
          ],
        });
      }
      if (u.pathname === "/orgs/brands") return json({ brands: [] });
      if (u.pathname.endsWith("/extracted-fields")) return json({ fields: [{ key: "companyOverview", value: overview }] });
      if (u.pathname === "/orgs/brands/b/offers/o-active/user-fields") {
        return json({ fields: { services: { value: services, provenance: "confirmed" }, dreamOutcome: { value: "More meetings", provenance: "confirmed" } } });
      }
      if (u.pathname.endsWith("/user-fields")) return json({ fields: { dreamOutcome: { value: "Q&A, never shown" } } });
      return json({ brand: { name: "Distribute.you", domain: "distribute.you", url: null } });
    });
    const identity = { orgId: "o", brandId: "b", userId: "u", runId: "r" };
    const ctx = await readBrandContext(identity);
    expect(asked.some((a) => a.includes("runtime-context"))).toBe(false);
    expect(asked.filter((a) => a.endsWith("/user-fields")).sort()).toEqual([
      "/orgs/brands/b/offers/o-active/user-fields",
      "/orgs/brands/b/offers/o-blank/user-fields",
    ]);
    expect(ctx.brand).toEqual({ name: "Distribute.you", website: "distribute.you", description: overview });
    expect(ctx.offers).toEqual([
      { offerId: "o-active", name: "Product-led", whatWeOffer: "Autonomous multi-channel acquisition; Cold email" },
      { offerId: "o-blank", name: "Sales-led", whatWeOffer: null },
    ]);
    expect(offersShownToJev(ctx)).toEqual([
      { key: "o0", name: "Product-led", whatWeOffer: "Autonomous multi-channel acquisition; Cold email" },
      { key: "o1", name: "Sales-led", whatWeOffer: null },
    ]);
    overview = "Worded differently after a re-extraction.";
    expect((await readBrandContext(identity)).hash).toBe(ctx.hash);
    // The client rewrites what the offer sells: every conversation is judged again.
    services = ["Done-for-you outbound"];
    expect((await readBrandContext(identity)).hash).not.toBe(ctx.hash);
  });

  it("whatWeOfferOf: Service sold first (a list joined), else the offer's own text, else nothing (lead-service's rule)", () => {
    expect(whatWeOfferOf({ description: null, fields: { services: ["Autonomous Sales Meetings Acquisition"] } })).toBe("Autonomous Sales Meetings Acquisition");
    expect(whatWeOfferOf({ description: "Dinner events for chiropractors", fields: {} })).toBe("Dinner events for chiropractors");
    expect(whatWeOfferOf({ description: "ignored", fields: { services: "Cold email" } })).toBe("Cold email");
    expect(whatWeOfferOf({ description: null, fields: { dreamOutcome: ["More patients"] } })).toBeNull();
  });
});

describe("WHOLE-THREAD-JEV-1021: Jev reads the whole thread from its start", () => {
  // Prod 2026-10-19: Regina's reply is the oldest message the mirror holds; the cold email it
  // answers was sent from another mailbox and lives only in her reply's quoted history.
  const COLD = "From: Kevin Lourd <kevin@pressbeat.ai>\nSubject: Garland chiropractic dinner events\n\nPhilip, I represent a team that runs educational dinner events for chiropractic practices.";
  const msg = (over: Record<string, unknown>) => ({
    direction: "inbound",
    fromEmail: "regina@x.com",
    subject: "Re: Garland chiropractic dinner events",
    snippet: null,
    bodyStatus: "ok",
    bodyCleanStatus: "cleaned",
    ...over,
  });

  it("the oldest held message of a thread carries its quoted history; later ones do not", () => {
    const out = gmailMessages({
      threads: [
        {
          threadId: "t1",
          messages: [
            msg({ sentAt: "2026-08-27T06:58:29Z", direction: "outbound", bodyText: "Happy to help", bodyTextOriginal: `Happy to help\n> How do you handle these events?\n> ${COLD}` }),
            msg({ sentAt: "2026-08-26T20:08:57Z", bodyText: "Hi Kevin, How do you handle these events?", bodyTextOriginal: `Hi Kevin, How do you handle these events?\n\n${COLD}` }),
          ],
        },
      ],
    });
    expect(out.map((m) => m.text)).toEqual(["Hi Kevin, How do you handle these events?", "Happy to help"]);
    expect(out[0].quotedHistory).toContain("educational dinner events for chiropractic practices");
    expect(out[1].quotedHistory).toBeUndefined();
  });

  it("no quoted history when cleaning removed nothing or the body was not cleaned", () => {
    const out = gmailMessages({
      threads: [
        { threadId: "a", messages: [msg({ sentAt: "2026-01-01T00:00:00Z", bodyText: "Hello", bodyTextOriginal: "Hello" })] },
        { threadId: "b", messages: [msg({ sentAt: "2026-01-02T00:00:00Z", bodyText: "Hi", bodyTextOriginal: `Hi\n${COLD}`, bodyCleanStatus: "not_cleaned" })] },
      ],
    });
    expect(out.every((m) => m.quotedHistory === undefined)).toBe(true);
  });

  it("Jev is shown the quoted history beside the brand and its offers as created, and told to read it as the start", async () => {
    process.env.CHAT_SERVICE_URL = "http://chat.test";
    process.env.CHAT_SERVICE_API_KEY = "k";
    let body: { state: Record<string, any>; questions: Record<string, any> } | null = null;
    vi.stubGlobal("fetch", async (_u: string, init: RequestInit) => {
      body = JSON.parse(String(init.body));
      const probabilities = { personal: 0.01, other_business: 0.69, this_brand: 0.3 };
      return new Response(
        JSON.stringify({ model: "jev-test", answers: { ...TAG_ANSWERS, topic: { type: "choice", choice: "other_business", confidence: 0.69, probabilities }, o0: { type: "noul", noul: 0.1 } } }),
        { status: 200 },
      );
    });
    const context: BrandContext = {
      brand: { name: "Distribute.you", website: "distribute.you", description: "B2B meetings, done for you." },
      offers: [{ offerId: "o-a", name: "Product-led", whatWeOffer: "Done-for-you outbound that books meetings." }],
      otherBrandsOfTheSameOwner: [],
      hash: "h",
    };
    const input: ConversationInput = {
      key: "gmail:regina@x.com",
      source: "gmail",
      judgedThrough: "m",
      channel: "email",
      counterpart: { names: ["Regina"], email: "regina@x.com", phone: null },
      messages: [{ at: null, direction: "inbound", text: "How do you handle these events?", quotedHistory: COLD }],
    };
    const v = await judgeConversation(input, context, { orgId: "o", userId: "u", runId: "r" });
    vi.unstubAllGlobals();
    expect(body!.state.brand).toEqual(context.brand);
    expect(body!.state.offers).toEqual([{ key: "o0", name: "Product-led", whatWeOffer: "Done-for-you outbound that books meetings." }]);
    expect(body!.state.conversation.messages[0].quotedHistory).toBe(COLD);
    expect(body!.questions.topic.instructions).toMatch(/quotedHistory/);
    expect(hidesConversation(v)).toBe(true);
  });

  it("a long thread stays under the cap with its start and its end", () => {
    const long = "A".repeat(5000) + "MIDDLE" + "Z".repeat(5000);
    const messages = Array.from({ length: 120 }, (_, i) =>
      msg({ sentAt: `2026-01-01T00:${String(Math.floor(i / 60)).padStart(2, "0")}:${String(i % 60).padStart(2, "0")}Z`, bodyText: `m${i}`, bodyTextOriginal: i === 0 ? `m0\n${long}` : `m${i}` }),
    );
    const out = gmailMessages({ threads: [{ threadId: "t", messages }] });
    expect(out).toHaveLength(30);
    expect(out[0].text).toBe("m0");
    expect(out[9].text).toBe("m9");
    expect(out[29].text).toBe("m119");
    const q = clipEnds(out[0].quotedHistory!, 1000, 2000);
    expect(q.startsWith("m0\nAAA")).toBe(true);
    expect(q.endsWith("ZZZ")).toBe(true);
    expect(q).not.toContain("MIDDLE");
    expect(Array.from(q).length).toBeLessThanOrEqual(3003);
  });
});
