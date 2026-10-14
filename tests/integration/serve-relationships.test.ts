import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { contacts, contactServes, humanKeys, people, peopleScopes } from "../../src/db/schema.js";
import { RelationshipsUnavailableError, serveNextBusinessOnly, serveNextPeopleBusinessOnly } from "../../src/lib/serve.js";

/**
 * RELATIONSHIP-TAGS-1014: a `business_only` serve hands out only whom lead-service
 * says a business pipe may write to (`policies.business_only`), on both pools, and
 * never burns the others.
 */
const RUN = !!process.env.CRM_TEST_DB;
const ORG = "edededed-1111-4111-8111-000000000001";
const BRAND = "edededed-1111-4111-8111-000000000002";
const UPLOAD = "edededed-1111-4111-8111-000000000003";
const H = (n: number) => `edededed-1111-4111-8111-1000000000${String(n).padStart(2, "0")}`;
const identity = { orgId: ORG, userId: "user-1", runId: "run-1", brandId: BRAND };

// humanId -> lead-service's answer
let answers: Record<string, { tags: string[]; judgedAt: string | null; business_only: boolean }> = {};
let leadDown = false;
const asked: string[][] = [];

function stub() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    if (url.startsWith("http://lead.test/internal/brands/") && url.endsWith("/relationships/query")) {
      if (leadDown) return new Response(JSON.stringify({ error: "down" }), { status: 503 });
      const { humanIds } = JSON.parse(String(init?.body)) as { humanIds: string[] };
      asked.push(humanIds);
      return new Response(
        JSON.stringify({
          relationships: humanIds.map((h) => {
            const a = answers[h] ?? { tags: [], judgedAt: null, business_only: false };
            return { humanId: h, company: null, tags: a.tags, unsureTags: [], judgedAt: a.judgedAt, details: [], policies: { business_only: a.business_only } };
          }),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch ${url}`);
  });
}

async function wipe() {
  await db.execute(sql`DELETE FROM contact_serves WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM contacts WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM human_keys WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM people_scopes WHERE org_id = ${ORG}`);
}

const judged = "2026-10-14T00:00:00Z";

describe.skipIf(!RUN)("serve-next relationships=business_only", () => {
  beforeAll(() => {
    process.env.LEAD_SERVICE_URL = "http://lead.test";
    process.env.LEAD_SERVICE_API_KEY = "test-lead-key";
    stub();
  });
  beforeEach(async () => {
    await wipe();
    answers = {};
    leadDown = false;
    asked.length = 0;
  });
  afterAll(wipe);

  it("CSV pool: only business people are served; a friend or an unjudged person is never burned", async () => {
    const rows = ["friend", "client", "unjudged", "nohuman"].map((t) => ({
      orgId: ORG, brandId: BRAND, primaryEmail: `${t}@x.com`, rawAttributes: {}, sourceUploadId: UPLOAD,
      sourceRowId: sql`gen_random_uuid()` as unknown as string,
    }));
    await db.insert(contacts).values(rows);
    await db.insert(humanKeys).values([
      { orgId: ORG, identityKey: "email:friend@x.com", humanId: H(1) },
      { orgId: ORG, identityKey: "email:client@x.com", humanId: H(2) },
      { orgId: ORG, identityKey: "email:unjudged@x.com", humanId: H(3) },
    ]);
    answers = {
      [H(1)]: { tags: ["personal", "prospect"], judgedAt: judged, business_only: false },
      [H(2)]: { tags: ["customer"], judgedAt: judged, business_only: true },
    };
    const r = await serveNextBusinessOnly(identity, 10, "run-1");
    expect(r.contacts.map((c) => c.primaryEmail)).toEqual(["client@x.com"]);
    expect(r.relationships.skipped).toEqual({ tagged_personal: 1, never_judged: 1, no_human: 1 });
    expect(r.exhausted).toBe(false); // two people wait on a first judgment
    const served = await db.select({ email: contactServes.email }).from(contactServes).where(sql`${contactServes.orgId} = ${ORG}`);
    expect(served.map((s) => s.email)).toEqual(["client@x.com"]);

    // lead-service judges the unjudged one as business: the next serve hands them out.
    answers[H(3)] = { tags: ["prospect"], judgedAt: judged, business_only: true };
    const again = await serveNextBusinessOnly(identity, 10, "run-2");
    expect(again.contacts.map((c) => c.primaryEmail)).toEqual(["unjudged@x.com"]);
  });

  it("people pool: a Personal-tagged person is never handed out; lead-service down = nothing served, loud", async () => {
    const [scope] = await db.insert(peopleScopes).values({ orgId: ORG, brandId: BRAND, createdByUserId: "user-1", status: "built" }).returning();
    const person = (key: string, humanId: string, at: string) => ({
      scopeId: scope.id, orgId: ORG, brandId: BRAND, personKey: `email:${key}@x.com`, identityKeys: [`email:${key}@x.com`],
      emails: [`${key}@x.com`], phones: [], sources: ["clerk"], presences: [], mergeEvidence: [], state: "in_conversation",
      stateSource: "none", humanId, firstActivityAt: new Date(at),
    });
    await db.insert(people).values([person("yuliia", H(4), "2026-01-01"), person("stranger", H(5), "2026-01-02")]);
    answers = {
      [H(4)]: { tags: ["personal", "customer"], judgedAt: judged, business_only: false },
      [H(5)]: { tags: ["prospect"], judgedAt: judged, business_only: true },
    };
    leadDown = true;
    await expect(serveNextPeopleBusinessOnly(identity, 10, "run-1", {})).rejects.toBeInstanceOf(RelationshipsUnavailableError);
    expect(await db.select().from(contactServes).where(sql`${contactServes.orgId} = ${ORG}`)).toHaveLength(0);

    leadDown = false;
    const r = await serveNextPeopleBusinessOnly(identity, 10, "run-1", {});
    expect(r.contacts.map((c) => c.primaryEmail)).toEqual(["stranger@x.com"]);
    expect(r.relationships).toMatchObject({ policy: "business_only", checked: 2, skipped: { tagged_personal: 1 } });
    expect(r.exhausted).toBe(true);
    const again = await serveNextPeopleBusinessOnly(identity, 10, "run-2", {});
    expect(again.contacts).toHaveLength(0);
  });
});
