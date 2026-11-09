import { describe, it, expect } from "vitest";
import { factTypeFor, messagePeople, namesSomeoneElse, parseFeedMailboxMessage, timelineDirection } from "../../src/lib/mailbox/rules.js";
import { versionNum } from "../../src/lib/mailbox/feed.js";

/** EVERY-PERSON-ON-THE-THREAD-1109: every address on a message of our sending mailboxes, one rule. */
const base = {
  mailbox: "Kevin@Send.test",
  from: null,
  to: [],
  cc: [],
  bcc: [],
  participants: [],
  leadEmail: "thomas@acme.test",
};

describe("messagePeople", () => {
  it("inbound: the From, every To and Cc, our mailbox and staff left out, the sequence's lead marked", () => {
    const people = messagePeople({
      ...base,
      from: { address: "Markus@Acme.test", name: "Markus" },
      to: [{ address: "kevin@send.test", name: null }],
      cc: [{ address: "thomas@acme.test", name: null }, { address: "anna@acme.test", name: "Anna" }, { address: "kevin@distribute.you", name: null }],
    });
    expect(people).toEqual([
      { address: "anna@acme.test", name: "Anna", role: "cc", sequenceLead: false },
      { address: "markus@acme.test", name: "Markus", role: "from", sequenceLead: false },
      { address: "thomas@acme.test", name: null, role: "cc", sequenceLead: true },
    ]);
    expect(namesSomeoneElse(people)).toBe(true);
  });

  it("outbound: To, Cc and Bcc; an address on two headers keeps its strongest role; participants count too", () => {
    const people = messagePeople({
      ...base,
      from: { address: "kevin@send.test", name: "Kevin" },
      to: [{ address: "thomas@acme.test", name: null }],
      cc: [{ address: "markus@acme.test", name: null }],
      bcc: [{ address: "markus@acme.test", name: "Markus" }, { address: "boss@acme.test", name: null }],
      participants: [{ email: "late@acme.test", role: "cc" }],
    });
    expect(people.map((p) => `${p.address}:${p.role}`)).toEqual(["boss@acme.test:bcc", "late@acme.test:cc", "markus@acme.test:cc", "thomas@acme.test:to"]);
    expect(people.find((p) => p.address === "markus@acme.test")!.name).toBe("Markus");
  });

  it("a cold email to the lead alone names nobody else", () => {
    expect(namesSomeoneElse(messagePeople({ ...base, from: { address: "kevin@send.test", name: null }, to: [{ address: "thomas@acme.test", name: null }] }))).toBe(false);
  });
});

describe("factTypeFor / timelineDirection", () => {
  it("the writer of an inbound wrote to us; anyone else on it was copied; we wrote to everyone on what we sent", () => {
    expect(factTypeFor("in", "from")).toBe("message_in");
    expect(factTypeFor("in", "cc")).toBe("message_copied");
    expect(factTypeFor("in", "to")).toBe("message_copied");
    expect(factTypeFor("out", "cc")).toBe("message_out");
    expect(factTypeFor("out", "bcc")).toBe("message_out");
    expect(timelineDirection("in", "from")).toBe("inbound");
    expect(timelineDirection("in", "cc")).toBe("other");
    expect(timelineDirection("out", "to")).toBe("outbound");
  });
});

describe("parseFeedMailboxMessage", () => {
  const row = {
    id: "imap:abc",
    version: "12",
    mailbox: "kevin@send.test",
    direction: "in",
    kind: "reply",
    messageId: "<a@b>",
    inReplyTo: null,
    references: ["<root@b>"],
    threadKey: "<root@b>",
    occurredAt: "2026-11-09T15:28:51.000Z",
    subject: "Re: x",
    from: { address: "markus@acme.test", name: "Markus" },
    to: [{ address: "kevin@send.test", name: null }],
    cc: [],
    bcc: [],
    participants: [{ email: "markus@acme.test", role: "from" }],
    text: "hi",
    textUnavailableReason: null,
    sentBy: null,
    orgId: "8bfec2f4-6184-40b7-b1aa-c8933d506a87",
    brandIds: ["f2408cfb-4f02-4910-acec-e61fc8edb9cf"],
    campaignId: "c",
    instantlyCampaignId: "self:1",
    leadEmail: "thomas@acme.test",
  };
  it("reads a served row", () => {
    expect(parseFeedMailboxMessage(row)).toMatchObject({ id: "imap:abc", version: "12", direction: "in", threadKey: "<root@b>", brandIds: [row.brandIds[0]] });
  });
  it("fails loud on a row it cannot place, files a foreign org id on nobody", () => {
    expect(() => parseFeedMailboxMessage({ ...row, direction: "sideways" })).toThrow(/direction/);
    expect(() => parseFeedMailboxMessage({ ...row, participants: [{ email: "x@y", role: "reply-to" }] })).toThrow(/participant/);
    expect(parseFeedMailboxMessage({ ...row, orgId: "org_2abc" }).orgId).toBeNull();
  });
  it("versions compare as numbers", () => {
    expect(versionNum("0042")).toBe("42");
    expect(() => versionNum("v1")).toThrow(/sequence number/);
  });
});
