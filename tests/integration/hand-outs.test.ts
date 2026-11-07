import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { contacts, contactServes, humanKeys, people, peopleScopes } from "../../src/db/schema.js";
import { serveNext } from "../../src/lib/serve.js";
import { declineHandOut, handOut, HandOutError, serveHandOut, type HandOutRequest } from "../../src/lib/hand-outs.js";
import { recordEmailLookup } from "../../src/lib/contacts/email-lookup.js";

/**
 * AUDIENCE-PER-OFFER-1107: a brand's CRM pool is handed to each ASKER (one offer audience) to
 * judge without burning it; only a serve burns it for the brand; a decline keeps it away from
 * that asker only. serve-next is unchanged.
 */
const RUN = !!process.env.CRM_TEST_DB;
const ORG = "c1c1c1c1-1111-4111-8111-000000000001";
const BRAND = "c1c1c1c1-1111-4111-8111-000000000002";
const UPLOAD = "c1c1c1c1-1111-4111-8111-000000000003";
const identity = { orgId: ORG, userId: "user-1", runId: "run-1", brandId: BRAND };
const decide = { orgId: ORG, brandId: BRAND, runId: "run-d" };

const OWNERS = "audience:chiro-owners";
const EMPLOYEES = "audience:chiro-employees";

function req(asker: string, over: Partial<HandOutRequest> = {}): HandOutRequest {
  return { asker, limit: 1, runId: "run-1", reach: [], businessOnly: false, includeEmailUnknown: false, ...over };
}

async function seedCsv(emails: string[]) {
  for (const [i, email] of emails.entries()) {
    await db.insert(contacts).values({
      orgId: ORG, brandId: BRAND, primaryEmail: email, rawAttributes: {}, sourceUploadId: UPLOAD,
      sourceRowId: sql`gen_random_uuid()` as unknown as string,
      lastRebuiltAt: new Date(Date.UTC(2026, 0, 1 + i)),
    });
  }
}

async function wipe() {
  await db.execute(sql`DELETE FROM contact_hand_out_keys WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM contact_hand_outs WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM contact_serves WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM contact_email_lookups WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM contacts WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM human_keys WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM people_scopes WHERE org_id = ${ORG}`);
}

describe.skipIf(!RUN)("hand-outs per asker", () => {
  beforeAll(wipe);
  beforeEach(wipe);
  afterAll(wipe);

  it("(a)(b)(c) A declines X, B can still get X, A never again; once B serves X nobody gets X", async () => {
    await seedCsv(["chiro@x.com", "other@x.com"]);

    const a1 = await handOut(identity, req(OWNERS));
    expect(a1.contacts.map((c) => c.primaryEmail)).toEqual(["chiro@x.com"]);
    expect(a1.handedOut).toBe(1);
    // Nothing burned for the brand.
    expect(await db.select().from(contactServes).where(sql`${contactServes.orgId} = ${ORG}`)).toHaveLength(0);

    const d = await declineHandOut(decide, a1.contacts[0].handOutId, "employed, not an owner");
    expect(d).toMatchObject({ status: "declined", duplicate: false, asker: OWNERS });
    expect((await declineHandOut(decide, a1.contacts[0].handOutId, null)).duplicate).toBe(true);

    // (b) A is never handed X again: its next is the other contact, then nothing.
    const a2 = await handOut(identity, req(OWNERS, { limit: 10 }));
    expect(a2.contacts.map((c) => c.primaryEmail)).toEqual(["other@x.com"]);
    expect(a2.exhausted).toBe(true);

    // (a) B's first hand-out IS X.
    const b1 = await handOut(identity, req(EMPLOYEES));
    expect(b1.contacts.map((c) => c.primaryEmail)).toEqual(["chiro@x.com"]);

    // (c) B serves X: burned for the brand, forever.
    const s = await serveHandOut(decide, b1.contacts[0].handOutId);
    expect(s).toMatchObject({ status: "served", duplicate: false, emails: ["chiro@x.com"] });
    expect((await serveHandOut(decide, b1.contacts[0].handOutId)).duplicate).toBe(true);
    const third = await handOut(identity, req("audience:clinic-sales", { limit: 10 }));
    expect(third.contacts.map((c) => c.primaryEmail)).toEqual(["other@x.com"]);
    expect((await serveNext(ORG, BRAND, 10, "run-x")).contacts.map((c) => c.primaryEmail)).toEqual(["other@x.com"]);
  });

  it("a person someone else served first is refused already_served, nothing written; a declined hand-out cannot be served", async () => {
    await seedCsv(["x@x.com"]);
    const a = await handOut(identity, req(OWNERS));
    const b = await handOut(identity, req(EMPLOYEES));
    await serveHandOut(decide, b.contacts[0].handOutId);
    await expect(serveHandOut(decide, a.contacts[0].handOutId)).rejects.toMatchObject({ status: 409, type: "already_served" });
    // Declining after another asker served it is still fine (bookkeeping).
    expect((await declineHandOut(decide, a.contacts[0].handOutId, null)).status).toBe("declined");
    await expect(serveHandOut(decide, a.contacts[0].handOutId)).rejects.toMatchObject({ type: "declined" });
    await expect(serveHandOut(decide, "c1c1c1c1-1111-4111-8111-00000000ffff")).rejects.toBeInstanceOf(HandOutError);
  });

  it("(d) serve-next is unchanged: same shape, and an open hand-out does not burn the contact", async () => {
    await seedCsv(["one@x.com", "two@x.com"]);
    await handOut(identity, req(OWNERS, { limit: 10 }));
    const r = await serveNext(ORG, BRAND, 10, "run-x");
    expect(Object.keys(r).sort()).toEqual(["contacts", "exhausted", "served"]);
    expect(r.contacts.map((c) => c.primaryEmail)).toEqual(["one@x.com", "two@x.com"]);
    expect(r.contacts[0]).not.toHaveProperty("handOutId");
    expect(r.exhausted).toBe(true);
    // serve-next burned them: no asker gets them any more.
    expect((await handOut(identity, req(EMPLOYEES, { limit: 10 }))).contacts).toEqual([]);
  });

  it("people pool: keyed on every address of the person; served burns them all", async () => {
    const [scope] = await db.insert(peopleScopes).values({ orgId: ORG, brandId: BRAND, createdByUserId: "user-1", status: "built" }).returning();
    await db.insert(people).values({
      scopeId: scope.id, orgId: ORG, brandId: BRAND, personKey: "email:a@x.com", identityKeys: ["email:a@x.com", "email:a2@x.com"],
      emails: ["a@x.com", "a2@x.com"], phones: [], sources: ["clerk"], presences: [], mergeEvidence: [], state: "open",
      stateSource: "none", firstActivityAt: new Date("2026-01-01"),
    });
    const a = await handOut(identity, req(OWNERS, { people: {} }));
    expect(a.contacts[0]).toMatchObject({ pool: "people", emails: ["a@x.com", "a2@x.com"] });
    expect((await handOut(identity, req(OWNERS, { people: {} }))).contacts).toEqual([]);
    const b = await handOut(identity, req(EMPLOYEES, { people: {} }));
    expect((await serveHandOut(decide, b.contacts[0].handOutId)).emails).toEqual(["a@x.com", "a2@x.com"]);
    expect((await handOut(identity, req("audience:third", { people: {} }))).exhausted).toBe(true);
  });

  it("email-unknown contacts: per asker; a lookup found burns, not_found takes it out for everyone", async () => {
    await db.insert(contacts).values({
      orgId: ORG, brandId: BRAND, primaryEmail: null, fullName: "Ann Lee", companyDomain: "lee.com", rawAttributes: {},
      sourceUploadId: UPLOAD, sourceRowId: sql`gen_random_uuid()` as unknown as string,
    });
    const a = await handOut(identity, req(OWNERS, { includeEmailUnknown: true }));
    expect(a.contacts[0]).toMatchObject({ emailStatus: "unknown", primaryEmail: null });
    expect(a.emailUnknown).toEqual({ handedOut: 1, remaining: 0 });
    await expect(serveHandOut(decide, a.contacts[0].handOutId)).rejects.toMatchObject({ type: "email_unknown" });
    await declineHandOut(decide, a.contacts[0].handOutId, null);
    const b = await handOut(identity, req(EMPLOYEES, { includeEmailUnknown: true }));
    expect(b.contacts).toHaveLength(1);
    await recordEmailLookup(decide, b.contacts[0].id, "not_found", null);
    expect((await handOut(identity, req("audience:third", { includeEmailUnknown: true }))).contacts).toEqual([]);
  });

  describe("relationships=business_only", () => {
    beforeAll(() => {
      process.env.LEAD_SERVICE_URL = "http://lead.test";
      process.env.LEAD_SERVICE_API_KEY = "test-lead-key";
      vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
        const { humanIds } = JSON.parse(String(init?.body)) as { humanIds: string[] };
        expect(String(input)).toContain("/relationships/query");
        return new Response(
          JSON.stringify({
            relationships: humanIds.map((h) => ({
              humanId: h, company: null, tags: ["prospect"], unsureTags: [], judgedAt: "2026-11-01T00:00:00Z", details: [],
              policies: { business_only: h.endsWith("01") },
            })),
          }),
          { status: 200, headers: { "content-type": "application/json" } },
        );
      });
    });
    afterAll(() => vi.unstubAllGlobals());

    it("hands out only business people, burns nobody", async () => {
      await seedCsv(["biz@x.com", "friend@x.com"]);
      await db.insert(humanKeys).values([
        { orgId: ORG, identityKey: "email:biz@x.com", humanId: "c1c1c1c1-1111-4111-8111-100000000001" },
        { orgId: ORG, identityKey: "email:friend@x.com", humanId: "c1c1c1c1-1111-4111-8111-100000000002" },
      ]);
      const r = await handOut(identity, req(OWNERS, { limit: 10, businessOnly: true }));
      expect(r.contacts.map((c) => c.primaryEmail)).toEqual(["biz@x.com"]);
      expect(r.relationships?.skipped).toEqual({ not_business: 1 });
      expect(await db.select().from(contactServes).where(sql`${contactServes.orgId} = ${ORG}`)).toHaveLength(0);
    });
  });
});
