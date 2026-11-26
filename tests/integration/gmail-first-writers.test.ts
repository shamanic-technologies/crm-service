import { describe, it, expect, afterAll } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { peopleMessageTexts, peopleScopes } from "../../src/db/schema.js";
import { gmailFirstWriters } from "../../src/lib/people/sources.js";

/**
 * GMAIL-WRITES-FIRST-1125 (DISTRY-START-DOOR-1125): a person who writes FIRST to the org's connected mailbox (no
 * correspondent: the owner never wrote to them) is a Gmail presence of the scope, read from our store, only for mail
 * after the scope's Gmail watch start. Staff addresses only.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "f1f1f1f1-1111-4111-8111-000000000001";
const BRAND = "f1f1f1f1-1111-4111-8111-000000000002";
const BRAND_B = "f1f1f1f1-1111-4111-8111-000000000003";
const WATCH = new Date("2026-11-25T10:00:00.000Z");
const scopeIds: string[] = [];

async function store(scopeId: string, address: string, key: string, at: string, direction: "inbound" | "outbound") {
  await db.insert(peopleMessageTexts).values({
    scopeId, source: "gmail", unit: address, address, messageKey: key, at: new Date(at), direction, subject: "Hi", body: "Hello",
    searchText: "Hi\nHello", item: { at, source: "gmail", direction, text: "Hello", from: address, to: ["distry@brand-first.example"] },
  });
}

describe.skipIf(!RUN)("gmailFirstWriters", () => {
  afterAll(async () => {
    if (scopeIds.length === 0) return;
    await db.delete(peopleMessageTexts).where(inArray(peopleMessageTexts.scopeId, scopeIds));
    await db.delete(peopleScopes).where(inArray(peopleScopes.id, scopeIds));
  });

  it("serves an address that wrote after the watch start, counted from the store; history and our own mail alone are nobody", async () => {
    const [s] = await db.insert(peopleScopes).values({ orgId: ORG, brandId: BRAND, createdByUserId: "user-first", status: "built", gmailReplyWatchSince: WATCH }).returning();
    scopeIds.push(s.id);
    await store(s.id, "k.lourd+distry1125@send-first.example", "m1", "2026-11-25T11:00:00.000Z", "inbound");
    await store(s.id, "k.lourd+distry1125@send-first.example", "m2", "2026-11-25T11:10:00.000Z", "outbound");
    await store(s.id, "k.lourd+old1125@send-first.example", "m3", "2026-11-25T09:00:00.000Z", "inbound");
    await store(s.id, "k.lourd+ours1125@send-first.example", "m4", "2026-11-25T11:00:00.000Z", "outbound");

    const presences = await gmailFirstWriters(s.id);
    expect(presences).toHaveLength(1);
    expect(presences[0]).toMatchObject({
      source: "gmail",
      sourceRef: "k.lourd+distry1125@send-first.example",
      emails: ["k.lourd+distry1125@send-first.example"],
      inboundCount: 1,
      outboundCount: 1,
      messageCount: 2,
      firstActivityAt: "2026-11-25T11:00:00.000Z",
      lastActivityAt: "2026-11-25T11:10:00.000Z",
      detail: { twoWay: true, wroteFirst: true },
    });
  });

  it("a scope whose Gmail watch never started holds nobody", async () => {
    const [s] = await db.insert(peopleScopes).values({ orgId: ORG, brandId: BRAND_B, createdByUserId: "user-first-2", status: "built" }).returning();
    scopeIds.push(s.id);
    await store(s.id, "k.lourd+distry1125b@send-first.example", "m5", "2026-11-25T11:00:00.000Z", "inbound");
    expect(await gmailFirstWriters(s.id)).toEqual([]);
  });
});
