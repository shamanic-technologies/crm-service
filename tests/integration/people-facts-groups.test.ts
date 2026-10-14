import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  contacts,
  conversations,
  matrixConnections,
  matrixGroupMembers,
  matrixGroups,
  matrixRawEvents,
  people,
  peopleFacts,
  peopleScopes,
} from "../../src/db/schema.js";
import { emitScopeFacts } from "../../src/lib/people/facts.js";
import type { Presence } from "../../src/lib/people/identity.js";

/**
 * RELATIONSHIP-TAGS-1014: a group's members and words reach the fact feed as
 * THEIR facts; the brand's own posts in a group are about nobody.
 */
const RUN = !!process.env.CRM_TEST_DB;
const ORG = "9e9e9e9e-1111-4111-8111-000000000001";
const BRAND = "9e9e9e9e-1111-4111-8111-000000000002";
const OWN = "@crm_own:hs";
const ROOM = "!grp:hs";
const YULIA = "@whatsapp_lid-83932385144839:hs";
const CHARLOTTE = "@whatsapp_lid-2:hs";

const presence = (contactId: string, handle: string): Presence => ({
  source: "matrix", sourceRef: contactId, displayName: null, company: null, emails: [], phones: [],
  firstActivityAt: null, lastActivityAt: null, messageCount: 0, inboundCount: 0, outboundCount: 0,
  detail: { contactId, channel: "whatsapp", channelHandle: handle, kind: "group_member", groups: [] },
});

async function wipe() {
  await db.execute(sql`DELETE FROM people_facts WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM people_scopes WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM matrix_connections WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM contacts WHERE org_id = ${ORG}`);
}

describe.skipIf(!RUN)("fact feed: messaging groups", () => {
  beforeAll(async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      throw new Error(`unexpected fetch ${String(input)}`);
    });
    await wipe();
  });
  afterAll(wipe);

  it("members get group_member, writers get group_message, the brand's own post is withdrawn from whoever held it", async () => {
    const [scope] = await db.insert(peopleScopes).values({ orgId: ORG, brandId: BRAND, createdByUserId: "u", status: "built" }).returning();
    const [conn] = await db.insert(matrixConnections).values({ orgId: ORG, brandId: BRAND, channel: "whatsapp", matrixUserId: OWN, counterpartPrefix: "@whatsapp_", createdByUserId: "u" }).returning();
    const [ch, yu] = await db
      .insert(contacts)
      .values([
        { orgId: ORG, brandId: BRAND, fullName: "Charlotte Leonard (WA)", rawAttributes: {}, source: "matrix", channel: "whatsapp", channelHandle: CHARLOTTE, sourceConnectionId: conn.id },
        { orgId: ORG, brandId: BRAND, fullName: "Yulia (WA)", rawAttributes: {}, source: "matrix", channel: "whatsapp", channelHandle: YULIA, sourceConnectionId: conn.id },
      ])
      .returning();
    const ev = (id: string, sender: string, body: string) => ({
      orgId: ORG, brandId: BRAND, connectionId: conn.id, eventId: id, roomId: ROOM, sender, eventType: "m.room.message",
      originServerTs: new Date("2026-08-02T10:00:00Z"), payload: { content: { msgtype: "m.text", body } },
    });
    await db.insert(matrixRawEvents).values([ev("$c1", CHARLOTTE, "welcome all"), ev("$own", OWN, "thanks!")]);
    await db.insert(people).values(
      [
        { key: "matrix:" + ch.id, p: presence(ch.id, CHARLOTTE), name: "Charlotte Leonard (WA)" },
        { key: "matrix:" + yu.id, p: presence(yu.id, YULIA), name: "Yulia (WA)" },
      ].map((x) => ({
        scopeId: scope.id, orgId: ORG, brandId: BRAND, personKey: x.key, identityKeys: [x.key], displayName: x.name,
        emails: [], phones: [], sources: ["matrix"], presences: [x.p], mergeEvidence: [], state: "in_conversation", stateSource: "none",
      })),
    );

    // The OLD rule: the group was a conversation of its first-joined member.
    await db.insert(conversations).values({
      orgId: ORG, brandId: BRAND, connectionId: conn.id, contactId: ch.id, channel: "whatsapp", roomId: ROOM,
      firstMessageAt: new Date(), lastMessageAt: new Date(), messageCount: 2, inboundCount: 1, outboundCount: 1, lastEventId: "$own",
    });
    await emitScopeFacts(scope);
    const before = await db.select().from(peopleFacts).where(eq(peopleFacts.orgId, ORG));
    expect(before.map((f) => f.type).sort()).toEqual(["message_in", "message_out"]);

    // The rebuild: the room is a group.
    await db.delete(conversations).where(eq(conversations.roomId, ROOM));
    const [g] = await db.insert(matrixGroups).values({ orgId: ORG, brandId: BRAND, connectionId: conn.id, channel: "whatsapp", roomId: ROOM, name: "Mush KPG Social", memberCount: 2, messageCount: 2 }).returning();
    await db.insert(matrixGroupMembers).values([
      { orgId: ORG, brandId: BRAND, groupId: g.id, roomId: ROOM, contactId: ch.id, ghostMxid: CHARLOTTE, membership: "join", joinedAt: new Date("2026-08-01T00:00:00Z"), authoredCount: 1 },
      { orgId: ORG, brandId: BRAND, groupId: g.id, roomId: ROOM, contactId: yu.id, ghostMxid: YULIA, membership: "join", joinedAt: new Date("2026-08-01T00:00:01Z"), authoredCount: 0 },
    ]);
    const summary = await emitScopeFacts(scope);
    expect(summary.unattributed).toBe(1);

    const live = await db.select().from(peopleFacts).where(sql`${peopleFacts.orgId} = ${ORG} AND ${peopleFacts.live} AND ${peopleFacts.naturalKey} IS NOT NULL`);
    const byType = (t: string) => live.filter((f) => f.type === t);
    expect(byType("message_in")).toHaveLength(0);
    expect(byType("message_out")).toHaveLength(0);
    expect(byType("group_member").map((f) => [f.personKey, (f.payload as { groupName: string }).groupName]).sort()).toEqual(
      [["matrix:" + ch.id, "Mush KPG Social"], ["matrix:" + yu.id, "Mush KPG Social"]].sort(),
    );
    expect(byType("group_message").map((f) => [f.personKey, f.sourceRef])).toEqual([["matrix:" + ch.id, "$c1"]]);
    const withdrawn = await db.select().from(peopleFacts).where(sql`${peopleFacts.orgId} = ${ORG} AND ${peopleFacts.type} = 'withdrawn'`);
    expect(withdrawn.map((w) => (w.payload as { reason: string }).reason).sort()).toEqual(["subject_changed", "vendor_record_changed"]);

    // A re-emission changes nothing.
    const again = await emitScopeFacts(scope);
    expect(again.emitted).toBe(0);
  });
});
