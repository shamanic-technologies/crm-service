import { describe, it, expect } from "vitest";
import { burstOwner } from "../../src/lib/reply-trigger/email-path.js";
import { burstFromAnchor } from "../../src/lib/reply-trigger/gmail-recheck.js";

describe("burstOwner (EMAIL-REPLY-ORPHAN-1027)", () => {
  it("the burst is the email path's when it ACTS on any of its mails (holds a sequence)", () => {
    expect(burstOwner([{ owner: "none", reason: "no_sequence" }, { owner: "email_path", reason: "lead_sequence" }])).toBe("email_path");
    expect(burstOwner([{ owner: "email_path", reason: "sending_mailbox_sequence" }])).toBe("email_path");
    expect(burstOwner([{ owner: "email_path", reason: "org_mailbox_sequence" }])).toBe("email_path");
  });
  it("nobody there acts: ours (no sequence, ambiguous orgs, our own mail)", () => {
    expect(burstOwner([{ owner: "none", reason: "no_sequence" }])).toBe("none");
    expect(burstOwner([{ owner: "none", reason: "ambiguous_orgs" }])).toBe("none");
    expect(burstOwner([{ owner: "email_path", reason: "our_own_mail" }])).toBe("none");
  });
});

describe("burstFromAnchor", () => {
  const m = (id: string) => ({ messageId: id, at: "2026-10-27T14:24:03.000Z", subject: null, text: "x", to: [], threadId: null });
  it("the current burst from the row's first mail; null when the brand answered since", () => {
    expect(burstFromAnchor({ kind: "unanswered", burst: [m("a"), m("b"), m("c")], wroteBefore: true }, "b").map((x) => x.messageId)).toEqual(["b", "c"]);
    expect(burstFromAnchor({ kind: "unanswered", burst: [m("c")], wroteBefore: true }, "b")).toBeNull();
    expect(burstFromAnchor({ kind: "answered" }, "b")).toBeNull();
  });
});
