import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { contacts, contactServes, NewContact } from "../../src/db/schema.js";
import { serveNext, serveStats } from "../../src/lib/serve.js";

/**
 * DB-backed serve tests. Gated on CRM_TEST_DB so CI (mock CRM_SERVICE_DATABASE_URL) skips.
 * Run against a real Neon dev branch with BOTH env vars pointed at it:
 *   CRM_SERVICE_DATABASE_URL=<branch> CRM_TEST_DB=1 pnpm vitest run tests/integration/serve.test.ts
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "11111111-1111-1111-1111-111111111111";
const BRAND = "22222222-2222-2222-2222-222222222222";
const OTHER_BRAND = "33333333-3333-3333-3333-333333333333";
const UPLOAD = "44444444-4444-4444-4444-444444444444";
// Two more imported files, for the per-file (upload-restricted) serve tests.
const UPLOAD_A = "55555555-5555-5555-5555-555555555555";
const UPLOAD_B = "66666666-6666-6666-6666-666666666666";
const UPLOAD_UNKNOWN = "77777777-7777-7777-7777-777777777777";
const RUN_ID = "run-test-1";

function contact(over: Partial<NewContact> & { primaryEmail: string | null }): NewContact {
  return {
    orgId: ORG,
    brandId: BRAND,
    primaryEmail: over.primaryEmail,
    phoneE164: null,
    fullName: null,
    firstName: null,
    lastName: null,
    rawAttributes: {},
    consentStatus: "unknown",
    unsubscribed: false,
    sourceUploadId: UPLOAD,
    sourceRowId: sql`gen_random_uuid()` as unknown as string,
    ...over,
  };
}

async function wipe() {
  await db.delete(contactServes).where(eq(contactServes.orgId, ORG));
  await db.delete(contacts).where(eq(contacts.orgId, ORG));
}

/** Seed N sendable contacts + a fixed set of non-sendable ones. Returns sendable emails. */
async function seed(sendableCount: number): Promise<string[]> {
  const sendable: NewContact[] = [];
  const emails: string[] = [];
  for (let i = 0; i < sendableCount; i++) {
    const email = `user${i}@example.com`;
    emails.push(email);
    sendable.push(contact({ primaryEmail: email }));
  }
  // Non-sendable: excluded by the gold view — must NEVER be served.
  const nonSendable: NewContact[] = [
    contact({ primaryEmail: "unsub@example.com", unsubscribed: true }),
    contact({ primaryEmail: "denied@example.com", consentStatus: "denied" }),
    contact({ primaryEmail: null }),
    contact({ primaryEmail: "not-an-email" }),
    // Different brand — same org, must not leak into BRAND serves.
    contact({ primaryEmail: "otherbrand@example.com", brandId: OTHER_BRAND }),
  ];
  await db.insert(contacts).values([...sendable, ...nonSendable]);
  return emails;
}

describe.skipIf(!RUN)("serve-next (DB)", () => {
  beforeAll(async () => {
    // Fail loud if the shared db is NOT pointed at the test branch.
    await db.execute(sql`SELECT 1`);
  });

  beforeEach(wipe);

  it("serves only un-served sendable contacts, permanently suppressing repeats", async () => {
    const emails = await seed(5);

    const first = await serveNext(ORG, BRAND, 2, RUN_ID);
    expect(first.served).toBe(2);
    expect(first.contacts.length).toBe(2);
    expect(first.exhausted).toBe(false);
    for (const c of first.contacts) {
      expect(emails).toContain(c.primaryEmail);
      expect(c.brandId).toBe(BRAND);
    }

    const second = await serveNext(ORG, BRAND, 2, RUN_ID);
    expect(second.served).toBe(2);
    // No overlap with the first batch.
    const firstEmails = new Set(first.contacts.map((c) => c.primaryEmail));
    for (const c of second.contacts) expect(firstEmails.has(c.primaryEmail)).toBe(false);

    const third = await serveNext(ORG, BRAND, 10, RUN_ID);
    expect(third.served).toBe(1); // only the 5th remains
    expect(third.exhausted).toBe(true);

    // Drained: further calls return empty + exhausted, never a non-sendable row.
    const fourth = await serveNext(ORG, BRAND, 10, RUN_ID);
    expect(fourth.served).toBe(0);
    expect(fourth.contacts).toEqual([]);
    expect(fourth.exhausted).toBe(true);

    // Exactly the 5 sendable emails were served — no duplicates, no non-sendable.
    const served = await db
      .select({ email: contactServes.email })
      .from(contactServes)
      .where(and(eq(contactServes.orgId, ORG), eq(contactServes.brandId, BRAND)));
    expect(served.map((s) => s.email).sort()).toEqual([...emails].sort());
  });

  it("reports truthful serve-stats", async () => {
    const emails = await seed(4);
    let stats = await serveStats(ORG, BRAND);
    expect(stats).toEqual({ served: 0, remainingSendable: 4, totalSendable: 4 });

    await serveNext(ORG, BRAND, 3, RUN_ID);
    stats = await serveStats(ORG, BRAND);
    expect(stats).toEqual({ served: 3, remainingSendable: 1, totalSendable: 4 });
    void emails;
  });

  it("never double-serves under CONCURRENT calls", async () => {
    const emails = await seed(50);

    // 8 parallel calls, each asking for more than exist. With correct atomic
    // serving, the union is exactly the 50 sendable emails, zero duplicates.
    const results = await Promise.all(
      Array.from({ length: 8 }, () => serveNext(ORG, BRAND, 50, RUN_ID)),
    );

    const allServed = results.flatMap((r) => r.contacts.map((c) => c.primaryEmail));
    // No email served twice across the concurrent callers.
    expect(new Set(allServed).size).toBe(allServed.length);
    // Every sendable contact served exactly once.
    expect(new Set(allServed)).toEqual(new Set(emails));
    expect(allServed.length).toBe(50);

    // The suppression table holds exactly 50 distinct emails.
    const [{ n }] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM contact_serves
      WHERE org_id = ${ORG} AND brand_id = ${BRAND}
    `)) as unknown as { n: number }[];
    expect(n).toBe(50);
  });

  it("keeps suppression across a re-promote (email key, not volatile uuid)", async () => {
    await seed(1);
    const first = await serveNext(ORG, BRAND, 1, RUN_ID);
    expect(first.served).toBe(1);
    const email = first.contacts[0].primaryEmail!;

    // Simulate a re-promote: the silver row is deleted and re-inserted with a
    // NEW uuid but the SAME email. Suppression must still hold.
    await db.delete(contacts).where(and(eq(contacts.orgId, ORG), eq(contacts.primaryEmail, email)));
    await db.insert(contacts).values(contact({ primaryEmail: email }));

    const again = await serveNext(ORG, BRAND, 10, RUN_ID);
    expect(again.served).toBe(0);
    expect(again.exhausted).toBe(true);
  });
});

/**
 * PER-FILE serve restriction — each imported CRM file behaves as its own
 * sendable pool, while suppression stays brand-wide.
 */
describe.skipIf(!RUN)("serve-next restricted to imported files (DB)", () => {
  beforeEach(wipe);

  /** Seed `count` sendable contacts attributed to one imported file. */
  async function seedFile(uploadId: string, prefix: string, count: number): Promise<string[]> {
    const emails: string[] = [];
    const rows: NewContact[] = [];
    for (let i = 0; i < count; i++) {
      const email = `${prefix}${i}@example.com`;
      emails.push(email);
      rows.push(contact({ primaryEmail: email, sourceUploadId: uploadId }));
    }
    await db.insert(contacts).values(rows);
    return emails;
  }

  it("serves only contacts of the requested file", async () => {
    const aEmails = await seedFile(UPLOAD_A, "a", 3);
    const bEmails = await seedFile(UPLOAD_B, "b", 2);

    const fromA = await serveNext(ORG, BRAND, 10, RUN_ID, [UPLOAD_A]);
    expect(fromA.served).toBe(3);
    expect(fromA.contacts.map((c) => c.primaryEmail).sort()).toEqual([...aEmails].sort());
    // File A is drained; the brand is NOT — exhaustion answers the asked scope.
    expect(fromA.exhausted).toBe(true);

    const againFromA = await serveNext(ORG, BRAND, 10, RUN_ID, [UPLOAD_A]);
    expect(againFromA.served).toBe(0);

    const fromB = await serveNext(ORG, BRAND, 10, RUN_ID, [UPLOAD_B]);
    expect(fromB.served).toBe(2);
    expect(fromB.contacts.map((c) => c.primaryEmail).sort()).toEqual([...bEmails].sort());
    expect(fromB.exhausted).toBe(true);
  });

  it("serves the union when several files are requested", async () => {
    const aEmails = await seedFile(UPLOAD_A, "a", 2);
    const bEmails = await seedFile(UPLOAD_B, "b", 2);
    await seedFile(UPLOAD, "c", 2); // a third file, NOT requested

    const both = await serveNext(ORG, BRAND, 10, RUN_ID, [UPLOAD_A, UPLOAD_B]);
    expect(both.served).toBe(4);
    expect(both.contacts.map((c) => c.primaryEmail).sort()).toEqual(
      [...aEmails, ...bEmails].sort(),
    );
    // The un-requested file still holds 2 un-served contacts.
    expect(both.exhausted).toBe(true);
    const rest = await serveNext(ORG, BRAND, 10, RUN_ID);
    expect(rest.served).toBe(2);
  });

  it("omitting the restriction is the whole-brand behaviour", async () => {
    const aEmails = await seedFile(UPLOAD_A, "a", 2);
    const bEmails = await seedFile(UPLOAD_B, "b", 3);

    const all = await serveNext(ORG, BRAND, 100, RUN_ID);
    expect(all.served).toBe(5);
    expect(all.contacts.map((c) => c.primaryEmail).sort()).toEqual(
      [...aEmails, ...bEmails].sort(),
    );
    expect(all.exhausted).toBe(true);
  });

  it("never re-serves a person through another file (brand-wide suppression)", async () => {
    // Alice is in file A and file B. Silver dedups on (org, brand, email), so
    // she is ONE row, attributed to the file that promoted last — start with A.
    await db.insert(contacts).values(contact({ primaryEmail: "alice@example.com", sourceUploadId: UPLOAD_A }));

    const fromA = await serveNext(ORG, BRAND, 10, RUN_ID, [UPLOAD_A]);
    expect(fromA.served).toBe(1);

    // File B is re-promoted and takes over the attribution (same email, new row).
    await db.delete(contacts).where(and(eq(contacts.orgId, ORG), eq(contacts.primaryEmail, "alice@example.com")));
    await db.insert(contacts).values(contact({ primaryEmail: "alice@example.com", sourceUploadId: UPLOAD_B }));

    // Serving file B must NOT hand Alice out a second time.
    const fromB = await serveNext(ORG, BRAND, 10, RUN_ID, [UPLOAD_B]);
    expect(fromB.served).toBe(0);
    expect(fromB.exhausted).toBe(true);
    // Nor does the unrestricted whole-brand serve.
    const brandWide = await serveNext(ORG, BRAND, 10, RUN_ID);
    expect(brandWide.served).toBe(0);

    // Exactly one suppression row exists for her.
    const [{ n }] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM contact_serves
      WHERE brand_id = ${BRAND} AND email = 'alice@example.com'
    `)) as unknown as { n: number }[];
    expect(n).toBe(1);
  });

  it("returns an empty, exhausted batch for a file with no contacts", async () => {
    await seedFile(UPLOAD_A, "a", 2);

    const unknown = await serveNext(ORG, BRAND, 10, RUN_ID, [UPLOAD_UNKNOWN]);
    expect(unknown.served).toBe(0);
    expect(unknown.contacts).toEqual([]);
    expect(unknown.exhausted).toBe(true);
    // Nothing was consumed from the brand's real pool.
    expect((await serveNext(ORG, BRAND, 10, RUN_ID)).served).toBe(2);
  });

  it("reports per-file serve-stats", async () => {
    await seedFile(UPLOAD_A, "a", 4);
    await seedFile(UPLOAD_B, "b", 3);

    expect(await serveStats(ORG, BRAND, [UPLOAD_A])).toEqual({
      served: 0,
      remainingSendable: 4,
      totalSendable: 4,
    });

    await serveNext(ORG, BRAND, 3, RUN_ID, [UPLOAD_A]);

    // File A moved; file B is untouched.
    expect(await serveStats(ORG, BRAND, [UPLOAD_A])).toEqual({
      served: 3,
      remainingSendable: 1,
      totalSendable: 4,
    });
    expect(await serveStats(ORG, BRAND, [UPLOAD_B])).toEqual({
      served: 0,
      remainingSendable: 3,
      totalSendable: 3,
    });
    // Several files at once, and the whole brand, stay coherent.
    expect(await serveStats(ORG, BRAND, [UPLOAD_A, UPLOAD_B])).toEqual({
      served: 3,
      remainingSendable: 4,
      totalSendable: 7,
    });
    expect(await serveStats(ORG, BRAND)).toEqual({
      served: 3,
      remainingSendable: 4,
      totalSendable: 7,
    });
  });
});
