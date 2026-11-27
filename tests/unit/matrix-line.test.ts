import { describe, it, expect } from "vitest";
import { accountOf, lineOf, type LineLink } from "../../src/lib/matrix/line.js";

const link = (over: Partial<LineLink>): LineLink => ({
  id: "l1",
  connectionId: "c1",
  status: "linked",
  remoteLoginId: "33611111111",
  accountType: null,
  automationAllowed: true,
  linkedAt: new Date("2026-10-01T00:00:00Z"),
  updatedAt: new Date("2026-10-01T00:00:00Z"),
  ...over,
});

describe("the brand line a Matrix message is on (LEAD-REPLY-CHANNEL-1127)", () => {
  it("serves a WhatsApp number in E.164 (what fromAccount takes), another app's login id verbatim", () => {
    expect(accountOf("whatsapp", "33611111111")).toBe("+33611111111");
    expect(accountOf("telegram", "501657753")).toBe("501657753");
    expect(accountOf("whatsapp", null)).toBeNull();
  });

  it("a personal line, a mirror-only line and an unlinked one never allow automation; a pro_ai line does", () => {
    const conn = { id: "c1", channel: "telegram" };
    expect(lineOf(conn, [link({ accountType: "personal_human" })])).toMatchObject({ accountType: "personal_human", automationAllowed: false, account: "33611111111" });
    expect(lineOf(conn, [link({ automationAllowed: false })]).automationAllowed).toBe(false);
    expect(lineOf(conn, [link({ status: "failed" })]).automationAllowed).toBe(false);
    expect(lineOf(conn, [link({ accountType: "pro_ai" })])).toMatchObject({ linkId: "l1", accountType: "pro_ai", automationAllowed: true, channel: "telegram" });
  });

  it("a hand-registered connection has no link: no account, no automation", () => {
    expect(lineOf({ id: "c9", channel: "whatsapp" }, [link({})])).toEqual({
      connectionId: "c9", linkId: null, channel: "whatsapp", account: null, accountType: null, automationAllowed: false,
    });
  });

  it("the linked row wins over an older failed row of the same mirror", () => {
    const old = link({ id: "old", status: "failed", updatedAt: new Date("2026-11-01T00:00:00Z") });
    const live = link({ id: "live", status: "linked", updatedAt: new Date("2026-10-01T00:00:00Z") });
    expect(lineOf({ id: "c1", channel: "whatsapp" }, [old, live]).linkId).toBe("live");
  });
});
