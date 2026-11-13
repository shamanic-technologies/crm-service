import { describe, it, expect } from "vitest";
import { eventSessionless, BRONZE_SESSIONLESS_EVENT_SQL } from "../../src/lib/posthog/records.js";
import { newsletterScopeMatches, parseFeedNewsletter } from "../../src/lib/transactional/newsletters.js";

// UNIBOX-NEWSLETTER-1113: the newsletter we sent is ours on the thread; a server identify (no session) is no act of theirs.

describe("eventSessionless", () => {
  it("a server-recorded event (session column present, empty) is plumbing", () => {
    expect(eventSessionless({ event: "newsletter_link_identified", session_id: "" })).toBe(true);
    expect(eventSessionless({ event: "anonymous_org_created", session_id: null })).toBe(true);
  });
  it("an event in a session is theirs; a payload stating no session column at all is left alone", () => {
    expect(eventSessionless({ event: "get_started_step_done", session_id: "0199-abc" })).toBe(false);
    expect(eventSessionless({ event: "legacy" })).toBe(false);
  });
  it("the SQL twin asks the same two things", () => {
    expect(BRONZE_SESSIONLESS_EVENT_SQL("p")).toBe("(p ? 'session_id' AND COALESCE(p->>'session_id', '') = '')");
  });
});

describe("newsletterScopeMatches", () => {
  const ORG = "o1";
  it("a send lands only on the brand(s) it names, in the sending org", () => {
    expect(newsletterScopeMatches({ orgId: ORG, brandIds: ["b1"] }, ORG, "b1")).toBe(true);
    expect(newsletterScopeMatches({ orgId: ORG, brandIds: ["b1"] }, ORG, "b2")).toBe(false);
    expect(newsletterScopeMatches({ orgId: "o2", brandIds: ["b1"] }, ORG, "b1")).toBe(false);
  });
  it("no brand known = no thread at all, on any brand of the org", () => {
    expect(newsletterScopeMatches({ orgId: ORG, brandIds: null }, ORG, "b1")).toBe(false);
    expect(newsletterScopeMatches({ orgId: ORG, brandIds: [] }, ORG, "b2")).toBe(false);
  });
});

describe("parseFeedNewsletter", () => {
  const ok = {
    id: "4e754e75-1111-4111-8111-0000000000a1",
    releaseId: "4e754e75-1111-4111-8111-0000000000b1",
    listSlug: "newsletter",
    recipientEmail: "a@x.com",
    orgId: "f0420eb5-8f72-4f0a-a150-f473746df1e6",
    brandIds: [],
    from: null,
    subject: "Hi",
    sentAt: "2026-11-13T12:56:55.581Z",
  };
  it("keeps a valid row, an empty brand list read as none", () => {
    expect(parseFeedNewsletter(ok)).toMatchObject({ id: ok.id, brandIds: null, subject: "Hi" });
  });
  it("refuses a row missing what the thread needs", () => {
    expect(() => parseFeedNewsletter({ ...ok, subject: undefined })).toThrow(/no subject/);
    expect(() => parseFeedNewsletter({ ...ok, sentAt: "x" })).toThrow(/sentAt/);
    expect(() => parseFeedNewsletter({ ...ok, id: "nope" })).toThrow(/uuid/);
  });
});
