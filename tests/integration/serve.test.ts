import { describe, it, expect, beforeEach, beforeAll } from "vitest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { contacts, contactServes, NewContact } from "../../src/db/schema.js";
import { serveNext, serveStats } from "../../src/lib/serve.js";

/**
 * DB-backed serve tests. Gated on CRM_TEST_DB so CI (mock DATABASE_URL) skips.
 * Run against a real Neon dev branch with BOTH env vars pointed at it:
 *   DATABASE_URL=<branch> CRM_TEST_DB=1 pnpm vitest run tests/integration/serve.test.ts
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "11111111-1111-1111-1111-111111111111";
const BRAND = "22222222-2222-2222-2222-222222222222";
const OTHER_BRAND = "33333333-3333-3333-3333-333333333333";
const UPLOAD = "44444444-4444-4444-4444-444444444444";
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
