import { describe, it, expect, vi, beforeEach } from "vitest";

/**
 * SOPHIE-WA-HUMAN-1106: the person's timeline (the thread every answering AI reads) keeps only the mails between
 * them and us. Prod 2026-11-04: Kevin's person holds the org's connected mailbox address, so google-service's
 * "conversation with" it was the whole mailbox (his mail to Thierry, MAIF / The Hustle newsletters).
 */
const state = { googleStatus: 200, reads: 0 };
vi.mock("../../src/lib/people/siblings.js", async (orig) => ({
  ...(await orig<typeof import("../../src/lib/people/siblings.js")>()),
  siblingGet: vi.fn(async (service: string) => {
    state.reads += 1;
    if (service !== "google") throw new Error(`unexpected ${service}`);
    return { status: state.googleStatus, body: state.googleStatus === 200 ? { accounts: [{ email: "Kevin.Lourd@gmail.com" }] } : { error: "down" } };
  }),
  siblingGetOk: vi.fn(async (service: string) => {
    if (service === "instantly") return { accounts: [{ email: "k.lourd@sendmail.io", mailboxLogin: null }] };
    if (service === "brand") return { brand: { domain: "distribute.you" } };
    throw new Error(`unexpected ${service}`);
  }),
}));

const { onlyExchangedWithUs } = await import("../../src/lib/people/timeline.js");
const { clearBrandAddressesCache } = await import("../../src/lib/people/brand-addresses.js");

const identity = { orgId: "o", brandId: "b", userId: "u", runId: "r" };
const mail = (from: string, to: string[], subject: string) =>
  ({
    at: "2026-11-04T08:56:43Z", source: "gmail", channel: "email", kind: "message", direction: "inbound", subject, text: subject,
    from, to, ref: {}, textClean: null, outreachFact: null, event: null,
  }) as const;

describe("the person's Gmail items: only mails between them and us", () => {
  beforeEach(() => {
    clearBrandAddressesCache();
    state.googleStatus = 200;
    state.reads = 0;
  });

  it("replays Kevin's 2026-11-04 thread: the third-party deal and the newsletters are gone, a real exchange stays", async () => {
    const items = [
      mail("kevin.lourd@gmail.com", ["thierry@dualityfund.com"], "Re: 1-month project: your trading research tool"),
      mail("thierry@dualityfund.com", ["kevin.lourd@gmail.com"], "Re: 1-month project: your trading research tool"),
      mail("newsletter@maif.fr", ["kevin.lourd@gmail.com"], "Votre lettre MAIF"),
      mail("hello@thehustle.co", ["kevin.lourd@gmail.com"], "The Hustle"),
      mail("kevin@polaritycourse.com", ["kevin.lourd@gmail.com"], "a note to myself at the brand"),
    ];
    const out = await onlyExchangedWithUs(
      { status: "ok", items: items.map((i) => ({ ...i, to: [...i.to] })), error: null, asked: [] },
      ["b00390394@essec.edu", "kevin.lourd@gmail.com", "kevin@polaritycourse.com"],
      identity,
    );
    expect(out.status).toBe("ok");
    expect(out.items.map((i) => i.subject)).toEqual(["a note to myself at the brand"]);
  });

  it("nothing left = `empty`; the own addresses are read once per brand (cached)", async () => {
    const one = await onlyExchangedWithUs({ status: "ok", items: [{ ...mail("news@x.com", ["kevin.lourd@gmail.com"], "n"), to: ["kevin.lourd@gmail.com"] }], error: null, asked: [] }, ["kevin.lourd@gmail.com"], identity);
    expect(one).toMatchObject({ status: "empty", items: [] });
    await onlyExchangedWithUs({ status: "ok", items: [{ ...mail("ann@acme.com", ["kevin.lourd@gmail.com"], "hi"), to: ["kevin.lourd@gmail.com"] }], error: null, asked: [] }, ["ann@acme.com"], identity);
    expect(state.reads).toBe(1);
  });

  it("own addresses unreadable: the Gmail source is `failed` with no item, never the unfiltered mailbox", async () => {
    state.googleStatus = 503;
    const out = await onlyExchangedWithUs({ status: "ok", items: [{ ...mail("ann@acme.com", ["kevin.lourd@gmail.com"], "hi"), to: ["kevin.lourd@gmail.com"] }], error: null, asked: [] }, ["ann@acme.com"], identity);
    expect(out.status).toBe("failed");
    expect(out.items).toEqual([]);
    expect(out.error).toContain("own addresses");
  });
});
