import { describe, it, expect, beforeEach, afterAll } from "vitest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { people, peopleScopes } from "../../src/db/schema.js";
import { replaceScopePeople, type PeopleRowInput } from "../../src/lib/people/write.js";

/**
 * BOX-DISK-FULL-1029: a build writes only the people that moved. Against a real Postgres
 * (gated on CRM_TEST_DB).
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "9a9a9a9a-1111-4111-8111-000000000001";
const BRAND = "9a9a9a9a-1111-4111-8111-000000000002";
const OTHER_BRAND = "9a9a9a9a-1111-4111-8111-000000000003";

function person(scopeId: string, brandId: string, name: string, over: Partial<PeopleRowInput> = {}): PeopleRowInput {
  return {
    scopeId,
    orgId: ORG,
    brandId,
    personKey: `email:${name}@write.test`,
    identityKeys: [`email:${name}@write.test`],
    displayName: name,
    emails: [`${name}@write.test`],
    phones: [],
    sources: ["gmail"],
    presences: [{ source: "gmail", sourceRef: name, emails: [], phones: [], detail: { n: 1 } }] as never,
    mergeEvidence: [],
    lastActivityAt: new Date("2026-10-29T10:00:00.123Z"),
    state: "in_conversation",
    stateSource: "none",
    stateDetail: { a: [1, 2], b: null },
    personId: "9a9a9a9a-1111-4111-8111-0000000000aa",
    ...over,
  };
}

async function rowsOf(scopeId: string) {
  return db.select().from(people).where(eq(people.scopeId, scopeId)).orderBy(people.personKey);
}

describe.skipIf(!RUN)("replaceScopePeople", () => {
  let scope: string;
  let other: string;
  const wipe = () => db.delete(peopleScopes).where(eq(peopleScopes.orgId, ORG));
  beforeEach(async () => {
    await wipe();
    [{ id: scope }] = await db.insert(peopleScopes).values({ orgId: ORG, brandId: BRAND, createdByUserId: "u", status: "built" }).returning();
    [{ id: other }] = await db.insert(peopleScopes).values({ orgId: ORG, brandId: OTHER_BRAND, createdByUserId: "u", status: "built" }).returning();
  });
  afterAll(wipe);

  it("first build inserts everyone, with the table defaults for columns the builder left out", async () => {
    const r = await db.transaction((tx) => replaceScopePeople(tx, scope, [person(scope, BRAND, "ann"), person(scope, BRAND, "bob")]));
    expect(r).toEqual({ deleted: 0, inserted: 2, unchanged: 0 });
    const rows = await rowsOf(scope);
    expect(rows.map((x) => x.displayName)).toEqual(["ann", "bob"]);
    expect(rows[0].automated).toBe(false);
    expect(rows[0].connectionTags).toEqual([]);
    expect(rows[0].stateDetail).toEqual({ a: [1, 2], b: null });
    expect(rows[0].lastActivityAt?.toISOString()).toBe("2026-10-29T10:00:00.123Z");
  });

  it("an identical rebuild writes nothing: same row ids, same built_at", async () => {
    const next = [person(scope, BRAND, "ann"), person(scope, BRAND, "bob")];
    await db.transaction((tx) => replaceScopePeople(tx, scope, next));
    const before = await rowsOf(scope);
    const r = await db.transaction((tx) => replaceScopePeople(tx, scope, next));
    expect(r).toEqual({ deleted: 0, inserted: 0, unchanged: 2 });
    const after = await rowsOf(scope);
    expect(after.map((x) => [x.id, x.builtAt.toISOString()])).toEqual(before.map((x) => [x.id, x.builtAt.toISOString()]));
  });

  it("a changed person is rewritten, a gone one deleted, a new one inserted; other scopes untouched", async () => {
    await db.transaction((tx) => replaceScopePeople(tx, other, [person(other, OTHER_BRAND, "ann")]));
    await db.transaction((tx) => replaceScopePeople(tx, scope, [person(scope, BRAND, "ann"), person(scope, BRAND, "bob"), person(scope, BRAND, "cid")]));
    const before = await rowsOf(scope);
    const r = await db.transaction((tx) =>
      replaceScopePeople(tx, scope, [
        person(scope, BRAND, "ann"),
        person(scope, BRAND, "bob", { stateDetail: { a: [2, 1], b: null }, automated: true }),
        person(scope, BRAND, "dan"),
      ]),
    );
    expect(r).toEqual({ deleted: 2, inserted: 2, unchanged: 1 });
    const after = await rowsOf(scope);
    expect(after.map((x) => x.displayName)).toEqual(["ann", "bob", "dan"]);
    expect(after[0].id).toBe(before[0].id);
    expect(after[1].id).not.toBe(before[1].id);
    expect(after[1].automated).toBe(true);
    expect(after[1].stateDetail).toEqual({ a: [2, 1], b: null });
    expect((await rowsOf(other)).map((x) => x.displayName)).toEqual(["ann"]);
  });

  it("an empty build empties the scope; a failed transaction leaves the old build whole", async () => {
    await db.transaction((tx) => replaceScopePeople(tx, scope, [person(scope, BRAND, "ann")]));
    await expect(
      db.transaction(async (tx) => {
        await replaceScopePeople(tx, scope, [person(scope, BRAND, "zed")]);
        throw new Error("boom");
      }),
    ).rejects.toThrow("boom");
    expect((await rowsOf(scope)).map((x) => x.displayName)).toEqual(["ann"]);
    const r = await db.transaction((tx) => replaceScopePeople(tx, scope, []));
    expect(r).toEqual({ deleted: 1, inserted: 0, unchanged: 0 });
    expect(await rowsOf(scope)).toEqual([]);
  });
});
