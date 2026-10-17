import { describe, it, expect } from "vitest";
import {
  CONNECTION_TAGS,
  personConnectionTags,
  tagsFromScores,
  type TagLookups,
  type TagScores,
} from "../../src/lib/people/connection-tags.js";
import { groupLines } from "../../src/lib/people/group-tags.js";
import { personView } from "../../src/lib/people/relevance.js";
import type { MatrixEvent } from "../../src/lib/matrix/client.js";

const scores = (p: Partial<TagScores>): TagScores => ({
  personal_to_user: 0,
  personal_not_to_user: 0,
  professional_to_brand: 0,
  professional_not_to_brand: 0,
  ...p,
});
const lookups = (x: Partial<TagLookups> = {}): TagLookups => ({
  brandId: "brand-1",
  automated: false,
  conversations: new Map(),
  groups: new Map(),
  posters: new Map(),
  ...x,
});
const presence = (source: string, extra: Record<string, unknown> = {}) => ({ source, emails: [] as string[], detail: {}, ...extra });
const tagsOf = (r: { tag: string }[]) => r.map((t) => t.tag);

describe("tagsFromScores", () => {
  it("keeps every tag at or above 0.5, up to all four", () => {
    expect(tagsFromScores(scores({ personal_to_user: 0.8, professional_to_brand: 0.6 }))).toEqual(["personal_to_user", "professional_to_brand"]);
    expect(tagsFromScores(scores({ personal_to_user: 1, personal_not_to_user: 1, professional_to_brand: 1, professional_not_to_brand: 1 }))).toEqual([
      ...CONNECTION_TAGS,
    ]);
  });
  it("none at 0.5: the most likely one, so a judged item always carries a tag", () => {
    expect(tagsFromScores(scores({ personal_not_to_user: 0.3, professional_not_to_brand: 0.4 }))).toEqual(["professional_not_to_brand"]);
  });
});

describe("personConnectionTags", () => {
  it("a record of the brand's own tools is professional, to the brand, no model", () => {
    const tags = personConnectionTags({ presences: [presence("stripe"), presence("gohighlevel")], evidence: [{ kind: "csv_contact" }] }, lookups());
    expect(tags).toEqual([
      {
        tag: "professional_to_brand",
        userIds: [],
        brandId: "brand-1",
        basis: [
          { kind: "source", ref: "stripe", probability: null },
          { kind: "source", ref: "gohighlevel", probability: null },
          { kind: "evidence", ref: "csv_contact", probability: null },
        ],
      },
    ]);
  });

  it("a friend on WhatsApp who is also a client carries both tags, the personal one naming the user", () => {
    const conversations: TagLookups["conversations"] = new Map([
      ["matrix:c1", { tags: ["personal_to_user"], scores: scores({ personal_to_user: 0.9 }), userIds: ["u-kevin"] }],
    ]);
    const tags = personConnectionTags(
      { presences: [presence("matrix", { detail: { conversationId: "c1", contactId: "k1", groups: [] } }), presence("stripe")] },
      lookups({ conversations }),
    );
    expect(tagsOf(tags)).toEqual(["personal_to_user", "professional_to_brand"]);
    expect(tags[0]).toMatchObject({ userIds: ["u-kevin"], brandId: null, basis: [{ kind: "conversation", ref: "matrix:c1", probability: 0.9 }] });
  });

  it("a direct thread with no word a person wrote is personal, to the user", () => {
    const conversations: TagLookups["conversations"] = new Map([["matrix:c1", { noWords: true as const, userIds: ["u-kevin"] }]]);
    const tags = personConnectionTags({ presences: [presence("matrix", { detail: { conversationId: "c1" } })] }, lookups({ conversations }));
    expect(tags).toEqual([
      { tag: "personal_to_user", userIds: ["u-kevin"], brandId: null, basis: [{ kind: "direct_thread_no_words", ref: "matrix:c1", probability: null }] },
    ]);
  });

  it("+33767292737 (one post in 'Vibrating Temples'): tagged from their own posts in that group", () => {
    const posters: TagLookups["posters"] = new Map([
      ["!vt:hs|k1", { tags: ["personal_not_to_user"], scores: scores({ personal_not_to_user: 0.92 }), userIds: ["u-kevin"] }],
    ]);
    const groups: TagLookups["groups"] = new Map([["!vt:hs", { tags: ["personal_not_to_user"], scores: null, userIds: ["u-kevin"] }]]);
    const p = presence("matrix", { sourceRef: "k1", detail: { kind: "group_member", contactId: "k1", groups: [{ roomId: "!vt:hs", authoredCount: 1 }] } });
    expect(personConnectionTags({ presences: [p] }, lookups({ posters, groups }))).toEqual([
      { tag: "personal_not_to_user", userIds: ["u-kevin"], brandId: null, basis: [{ kind: "group_posts", ref: "!vt:hs", probability: 0.92 }] },
    ]);
  });

  it("a silent member inherits the group's verdict, never 'to user' (they wrote to nobody)", () => {
    const groups: TagLookups["groups"] = new Map([
      ["!g:hs", { tags: ["personal_to_user", "professional_not_to_brand"], scores: scores({ personal_to_user: 0.6, professional_not_to_brand: 0.7 }), userIds: ["u"] }],
    ]);
    const p = presence("matrix", { sourceRef: "k2", detail: { kind: "group_member", contactId: "k2", groups: [{ roomId: "!g:hs", authoredCount: 0 }] } });
    expect(tagsOf(personConnectionTags({ presences: [p] }, lookups({ groups })))).toEqual(["personal_not_to_user", "professional_not_to_brand"]);
  });

  it("a poster whose posts were never judged (media only) falls back to the group's verdict", () => {
    const groups: TagLookups["groups"] = new Map([["!g:hs", { tags: ["professional_to_brand"], scores: scores({ professional_to_brand: 0.8 }), userIds: [] }]]);
    const p = presence("matrix", { sourceRef: "k3", detail: { kind: "group_member", contactId: "k3", groups: [{ roomId: "!g:hs", authoredCount: 2 }] } });
    expect(tagsOf(personConnectionTags({ presences: [p] }, lookups({ groups })))).toEqual(["professional_to_brand"]);
  });

  it("an automated sender is professional, not to the brand", () => {
    expect(tagsOf(personConnectionTags({ presences: [presence("gmail", { emails: ["noreply@x.com"] })] }, lookups({ automated: true })))).toEqual([
      "professional_not_to_brand",
    ]);
  });

  it("nothing judged yet = no tag (an unreadable mailbox)", () => {
    expect(personConnectionTags({ presences: [presence("gmail", { emails: ["a@x.com"] })] }, lookups())).toEqual([]);
  });
});

describe("personView", () => {
  it("names the brand's own sources holding the person, their company and email domains", () => {
    expect(
      personView({
        presences: [
          { source: "matrix", emails: [], displayName: null, lastActivityAt: null, messageCount: 1, detail: {} },
          { source: "stripe", emails: ["a@acme.com"], displayName: null, company: "Acme", lastActivityAt: null, messageCount: null, detail: {} },
        ],
        evidence: [{ kind: "csv_contact" }],
      }),
    ).toEqual({ knownBy: ["csv", "stripe"], company: "Acme", emailDomains: ["acme.com"] });
  });
});

describe("groupLines", () => {
  const ev = (id: string, sender: string, ts: number, content: Record<string, unknown>): MatrixEvent =>
    ({ event_id: id, sender, origin_server_ts: ts, type: "m.room.message", content }) as unknown as MatrixEvent;
  const own = new Set(["@crm_kevin:hs"]);
  it("marks the user's own lines, a reply to the user and a mention of the user; drops edits and bridge notices", () => {
    const lines = groupLines(
      [
        ev("$1", "@crm_kevin:hs", 1, { msgtype: "m.text", body: "Anyone for yoga?" }),
        ev("$2", "@whatsapp_lid1:hs", 2, { msgtype: "m.text", body: "Me!", "m.relates_to": { "m.in_reply_to": { event_id: "$1" } } }),
        ev("$3", "@whatsapp_lid2:hs", 3, { msgtype: "m.text", body: "hey Kevin", "m.mentions": { user_ids: ["@crm_kevin:hs"] } }),
        ev("$4", "@whatsapp_lid2:hs", 4, { msgtype: "m.text", body: "* hey Kevin!", "m.relates_to": { rel_type: "m.replace", event_id: "$3" } }),
        ev("$5", "@whatsapp_lid3:hs", 5, { msgtype: "m.notice", body: "Failed to bridge media" }),
        ev("$6", "@whatsapp_lid3:hs", 6, { msgtype: "m.text", body: "Good vibes" }),
      ],
      own,
    );
    expect(lines.map((l) => [l.from, l.text, l.repliesToUser, l.mentionsUser])).toEqual([
      ["user", "Anyone for yoga?", false, false],
      ["member", "Me!", true, false],
      ["member", "hey Kevin", false, true],
      ["member", "Good vibes", false, false],
    ]);
  });
});

import { crmRecordKey, parseCrmRecordKey, recordKeys } from "../../src/lib/people/humans.js";

describe("CRM record keys (HUMAN-RECORD-KEYS-1017)", () => {
  it("round-trips a record key, an id holding ':' included", () => {
    const r = { provider: "stripe" as const, accountId: "acct_1", id: "cus:9" };
    expect(crmRecordKey(r)).toBe("crm_record:stripe:acct_1:cus:9");
    expect(parseCrmRecordKey(crmRecordKey(r))).toEqual(r);
    expect(parseCrmRecordKey("gohighlevel:abc")).toBeNull();
    expect(parseCrmRecordKey("crm_record:stripe::x")).toBeNull();
  });
  it("a record's keys include its CRM record; an account id holding ':' is never stated", () => {
    expect(recordKeys({ emails: [], phones: [], crmRecords: [{ provider: "gohighlevel", accountId: "loc", id: "c1" }] })).toEqual([
      "crm_record:gohighlevel:loc:c1",
    ]);
    expect(recordKeys({ emails: [], phones: [], crmRecords: [{ provider: "gohighlevel", accountId: "a:b", id: "c1" }] })).toEqual([]);
  });
});
