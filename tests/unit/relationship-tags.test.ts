import { describe, expect, it } from "vitest";
import { groupMembers, handleOf, isGroupRoom, roomName, unescapeLocalpart } from "../../src/lib/matrix/events.js";
import type { MatrixEvent } from "../../src/lib/matrix/client.js";
import { businessOnlyVerdict, type Relationship } from "../../src/lib/people/relationships.js";
import { isGroupOnly } from "../../src/lib/people/sources.js";
import { handleKey, parseHandleKey, clusterPeople, type Presence } from "../../src/lib/people/identity.js";
import { humanEvidence, recordKeys } from "../../src/lib/people/humans.js";

const OWN = "@crm_abc:hs";
const P = "@whatsapp_";
let ts = 1_760_000_000_000;
const member = (who: string, membership: string, extra: Record<string, unknown> = {}): MatrixEvent =>
  ({ type: "m.room.member", event_id: `$m${ts}`, sender: who, state_key: who, origin_server_ts: ts++, content: { membership, ...extra } }) as unknown as MatrixEvent;
const msg = (who: string, body: string): MatrixEvent =>
  ({ type: "m.room.message", event_id: `$x${ts}`, sender: who, origin_server_ts: ts++, content: { msgtype: "m.text", body } }) as unknown as MatrixEvent;

describe("Matrix groups (RELATIONSHIP-TAGS-1014)", () => {
  it("a room with is_direct is a DM even with two ghosts; without it, two ghosts make a group", () => {
    const dm = [member(OWN, "join", { is_direct: true }), member(`${P}lid-1:hs`, "join"), member(`${P}33612345678:hs`, "join")];
    expect(isGroupRoom(dm, OWN, P)).toBe(false);
    const group = [member(OWN, "join"), member(`${P}lid-1:hs`, "join"), member(`${P}lid-2:hs`, "join")];
    expect(isGroupRoom(group, OWN, P)).toBe(true);
    // A hand-registered room with one ghost and no mark stays a DM.
    expect(isGroupRoom([member(OWN, "join"), member(`${P}lid-1:hs`, "join")], OWN, P)).toBe(false);
  });

  it("every member is a person with what they wrote; the bridge bot and the account are not members", () => {
    const events = [
      member(OWN, "join"),
      member("@whatsappbot:hs", "join"),
      member(`${P}lid-83932385144839:hs`, "join", { displayname: "Yulia (WA)" }),
      member(`${P}lid-2:hs`, "join", { displayname: "Charlotte Leonard (WA)" }),
      msg(`${P}lid-2:hs`, "hello all"),
      msg(OWN, "hi"),
      member(`${P}lid-2:hs`, "leave"),
      { type: "m.room.name", event_id: "$n", sender: OWN, state_key: "", origin_server_ts: ts++, content: { name: "Mush KPG Cross-Promotion (MCP '24)" } } as unknown as MatrixEvent,
    ];
    const ms = groupMembers(events, OWN, P);
    expect(ms.map((m) => [m.mxid, m.displayName, m.membership, m.authoredCount])).toEqual([
      [`${P}lid-2:hs`, "Charlotte Leonard (WA)", "leave", 1],
      [`${P}lid-83932385144839:hs`, "Yulia (WA)", "join", 0],
    ]);
    expect(roomName(events)).toBe("Mush KPG Cross-Promotion (MCP '24)");
  });

  it("handles are in human-service's form: WhatsApp LID digits@lid, phone ghosts none, LinkedIn unescaped", () => {
    expect(handleOf("whatsapp", `${P}lid-83932385144839:hs`, P)).toEqual({ network: "whatsapp", id: "83932385144839@lid" });
    expect(handleOf("whatsapp", `${P}33612345678:hs`, P)).toBeNull();
    expect(handleOf("linkedin", "@linkedin__a_co_a_a_c15fa0_bc7-_i:hs", "@linkedin_")).toEqual({ network: "linkedin", id: "ACoAAC15fa0Bc7-I" });
    expect(handleOf("discord", "@discord_1:hs", "@discord_")).toBeNull();
    expect(unescapeLocalpart("a__b=2dc")).toBe("a_b-c");
  });
});

describe("identity with messaging handles", () => {
  it("a handle key round-trips, reaches human-service and survives human_identity evidence", () => {
    const k = handleKey("whatsapp", "83932385144839@lid");
    expect(k).toBe("msg:whatsapp:83932385144839@lid");
    expect(parseHandleKey(k)).toEqual({ network: "whatsapp", id: "83932385144839@lid" });
    expect(recordKeys({ emails: [], phones: [], handles: [k] })).toEqual([k]);
    const ev = humanEvidence([k, "email:lusenko.julija@gmail.com"], new Map([[k, "h1"], ["email:lusenko.julija@gmail.com", "h1"]]));
    expect(ev).toHaveLength(1);
    expect(ev[0].keys).toEqual([k]);
    expect(ev[0].emails).toEqual(["lusenko.julija@gmail.com"]);
  });

  it("once human-service says a group member and a signup are one human, they are ONE person", () => {
    const k = handleKey("whatsapp", "83932385144839@lid");
    const base = { company: null, phones: [], firstActivityAt: null, lastActivityAt: null, messageCount: 0, inboundCount: 0, outboundCount: 0 };
    const member: Presence = { ...base, source: "matrix", sourceRef: "c1", displayName: "Yulia (WA)", emails: [], keys: ["matrix:c1", k], detail: { kind: "group_member", groups: [] } };
    const signup: Presence = { ...base, source: "clerk", sourceRef: "u1", displayName: "Yuliia Siletska", emails: ["lusenko.julija@gmail.com"], detail: {} };
    expect(clusterPeople([member, signup], [])).toHaveLength(2);
    const ev = humanEvidence([k, "matrix:c1", "email:lusenko.julija@gmail.com"], new Map([[k, "h1"], ["email:lusenko.julija@gmail.com", "h1"]]));
    const one = clusterPeople([member, signup], ev);
    expect(one).toHaveLength(1);
    expect(one[0].personKey).toBe("email:lusenko.julija@gmail.com");
    expect(isGroupOnly(one[0].presences)).toBe(false);
    expect(isGroupOnly([member])).toBe(true);
  });
});

describe("business_only", () => {
  const rel = (over: Partial<Relationship>): Relationship => ({ humanId: "h", company: null, tags: [], unsureTags: [], judgedAt: "2026-10-14T00:00:00Z", details: [], ...over });
  it("lead-service's policy decides; a refusal is named, never re-derived into a yes", () => {
    expect(businessOnlyVerdict(rel({ tags: ["prospect"], policies: { business_only: true } }))).toEqual({ ok: true });
    expect(businessOnlyVerdict(rel({ tags: ["prospect", "personal"], policies: { business_only: false } }))).toEqual({ ok: false, reason: "tagged_personal" });
    expect(businessOnlyVerdict(rel({ unsureTags: ["investor"], policies: { business_only: false } }))).toEqual({ ok: false, reason: "tagged_investor" });
    // Tags look fine but lead-service says no: no.
    expect(businessOnlyVerdict(rel({ tags: ["customer"], policies: { business_only: false } }))).toEqual({ ok: false, reason: "not_business" });
    // No stated policy (an older lead-service): never served.
    expect(businessOnlyVerdict(rel({ tags: ["customer"] }))).toEqual({ ok: false, reason: "policy_not_stated" });
    expect(businessOnlyVerdict(rel({ judgedAt: null, policies: { business_only: false } }))).toEqual({ ok: false, reason: "never_judged" });
    expect(businessOnlyVerdict(null)).toEqual({ ok: false, reason: "no_human" });
  });
});
