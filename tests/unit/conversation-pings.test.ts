import { describe, it, expect } from "vitest";
import {
  anyStaff,
  apiConversationKey,
  composePingText,
  uniboxThreadUrl,
} from "../../src/lib/conversation-pings.js";
import { isStaffEmail } from "../../src/lib/owner-telegram.js";

describe("staff never pings", () => {
  it("knows the owner's addresses, plus-addressing and the whole @distribute.you domain", () => {
    for (const e of ["kevin@distribute.you", "Kevin.Lourd@gmail.com", "kevin.lourd+test@gmail.com", "kevin@pressbeat.io", "anyone@distribute.you"]) {
      expect(isStaffEmail(e)).toBe(true);
    }
    for (const e of ["jane@prospect.io", "kevin@gmail.com", "", null, undefined]) {
      expect(isStaffEmail(e)).toBe(false);
    }
  });

  it("a user id ever seen with a staff address is staff", () => {
    expect(anyStaff(["jane@prospect.io", "kevin.lourd@gmail.com"])).toBe(true);
    expect(anyStaff(["jane@prospect.io"])).toBe(false);
  });
});

describe("what one conversation is", () => {
  it("one person's calls on one channel", () => {
    expect(apiConversationKey("mcp", "jane@prospect.io")).toBe("api:mcp:jane@prospect.io");
    expect(apiConversationKey("api", "jane@prospect.io")).not.toBe(apiConversationKey("mcp", "jane@prospect.io"));
  });
});

describe("the message", () => {
  it("an API start: who, org, first call, thread", () => {
    expect(
      composePingText({
        channel: "api",
        email: "jane@prospect.io",
        name: "Jane Doe",
        orgName: "Prospect",
        brandNames: [],
        first: "Listed emails\nfor brand AscendQE",
        threadUrl: uniboxThreadUrl("org_abc", "f4d73dab-1f9d-49b2-b16e-63ecde76a5eb", "11111111-2222-4333-8444-555555555555"),
      }),
    ).toBe(
      [
        "New conversation on API",
        "Who: Jane Doe (jane@prospect.io)",
        "Org: Prospect",
        "First call: Listed emails for brand AscendQE",
        "Thread: https://dashboard.distribute.you/v2/orgs/org_abc/brands/f4d73dab-1f9d-49b2-b16e-63ecde76a5eb/unibox?person=11111111-2222-4333-8444-555555555555",
      ].join("\n"),
    );
  });

  it("an MCP start names the channel and the first call; lines it cannot fill are left out", () => {
    const text = composePingText({
      channel: "mcp",
      email: "jane@prospect.io",
      name: null,
      orgName: null,
      brandNames: ["AscendQE", "Other"],
      first: "tool distribute_list_emails: Listed emails for brand AscendQE. Answered: 12 emails (200, 120 ms)",
      threadUrl: null,
    });
    expect(text).toBe(
      [
        "New conversation on MCP",
        "Who: jane@prospect.io",
        "Brands: AscendQE, Other",
        "First call: tool distribute_list_emails: Listed emails for brand AscendQE. Answered: 12 emails (200, 120 ms)",
      ].join("\n"),
    );
    expect(text).not.toMatch(/[—–]/);
  });

  it("a long first message is cut, never the whole wall", () => {
    const text = composePingText({ channel: "api", email: "a@b.io", name: null, orgName: null, brandNames: [], first: "x".repeat(5000), threadUrl: null });
    expect(text.length).toBeLessThan(400);
    expect(text).toContain("…");
  });
});
