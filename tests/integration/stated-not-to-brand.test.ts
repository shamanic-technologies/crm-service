import { describe, it, expect, beforeAll, afterAll, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { people, peopleCorrections, peopleScopes } from "../../src/db/schema.js";
import peopleRoutes from "../../src/routes/people.js";

/**
 * POST /internal/people/stated-not-to-brand against a real Postgres (gated on CRM_TEST_DB): the email senders ask
 * whether the brand stated each person is NOT someone of theirs (DUALIST-WA-SILENCE-EMAIL, owner 2026-11-04).
 * Scopes, people and corrections are written directly: the read is what is tested.
 */
const RUN = !!process.env.CRM_TEST_DB;
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";

const ORG = "6a1c0e2d-3b4f-4a5e-8f60-71829304a5b1";
const OTHER_ORG = "6a1c0e2d-3b4f-4a5e-8f60-71829304a5b2";
const BRAND = "6a1c0e2d-3b4f-4a5e-8f60-71829304a5c1";
const OTHER_BRAND = "6a1c0e2d-3b4f-4a5e-8f60-71829304a5c2";
const P_EMAIL_ONLY = "6a1c0e2d-3b4f-4a5e-8f60-71829304a5d1";
const P_BOTH = "6a1c0e2d-3b4f-4a5e-8f60-71829304a5d2";
const USER = "user_stated_test";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function app() {
  const a = express();
  a.use(express.json());
  a.use(peopleRoutes);
  return a;
}
const post = (body: unknown) => request(app()).post("/internal/people/stated-not-to-brand").set("x-api-key", API_KEY).send(body);

async function wipe() {
  for (const org of [ORG, OTHER_ORG]) {
    await db.delete(peopleCorrections).where(eq(peopleCorrections.orgId, org));
    await db.delete(people).where(eq(people.orgId, org));
    await db.delete(peopleScopes).where(eq(peopleScopes.orgId, org));
  }
}

async function state(orgId: string, brandId: string, personKeys: string[]) {
  const [row] = await db
    .insert(peopleCorrections)
    .values({
      orgId,
      brandId,
      kind: "tag_add",
      personId: null,
      personKeys,
      target: { tag: "professional_not_to_brand" },
      targetKey: "tag_add:professional_not_to_brand",
      reason: "not one of ours",
      statedByUserId: USER,
    })
    .returning();
  return row;
}

describe.skipIf(!RUN)("POST /internal/people/stated-not-to-brand (DUALIST-WA-SILENCE-EMAIL)", () => {
  let runCalls = 0;
  beforeAll(() => {
    process.env.RUNS_SERVICE_URL = process.env.RUNS_SERVICE_URL || "http://runs.test";
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
        runCalls++;
        return json({ id: "run-" + Math.random().toString(16).slice(2) });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
  });
  afterAll(async () => {
    vi.unstubAllGlobals();
    await wipe();
  });
  beforeEach(async () => {
    await wipe();
    const [scope] = await db
      .insert(peopleScopes)
      .values({ orgId: ORG, brandId: BRAND, createdByUserId: "u", status: "built", lastBuiltAt: new Date(), sourceReads: { sources: [] } })
      .returning();
    const person = (personId: string, keys: string[], emails: string[], phones: string[]) => ({
      scopeId: scope.id,
      orgId: ORG,
      brandId: BRAND,
      personId,
      personKey: keys[0],
      identityKeys: keys,
      emails,
      phones,
      sources: ["instantly"],
      presences: [],
      mergeEvidence: [],
      state: "in_conversation",
      stateSource: "instantly",
      relations: [],
    });
    await db.insert(people).values([
      person(P_EMAIL_ONLY, ["email:thierry@dualist.test"], ["thierry@dualist.test"], []),
      // Known by email AND phone: the statement was made on the phone (a WhatsApp thread).
      person(P_BOTH, ["email:both@dualist.test", "phone:+33611111111"], ["both@dualist.test"], ["+33611111111"]),
    ]);
  });

  it("answers stated for a person known by email only, whatever the case asked; untagged people are not stated", async () => {
    const stated = await state(ORG, BRAND, ["email:thierry@dualist.test"]);
    const res = await post({ orgId: ORG, brandIds: [BRAND], emails: ["Thierry@Dualist.test", "someone@else.test", "not-an-email"] });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      orgId: ORG,
      results: [
        { email: "Thierry@Dualist.test", stated: true, brandId: BRAND, correctionId: stated.id },
        { email: "someone@else.test", stated: false, brandId: null, correctionId: null },
        { email: "not-an-email", stated: false, brandId: null, correctionId: null },
      ],
    });
  });

  it("a statement made on the person's phone silences their email too (same built person)", async () => {
    await state(ORG, BRAND, ["phone:+33611111111"]);
    const res = await post({ orgId: ORG, brandIds: [BRAND], emails: ["both@dualist.test", "thierry@dualist.test"] });
    expect(res.body.results.map((r: { stated: boolean }) => r.stated)).toEqual([true, false]);
  });

  it("is scoped to the org and the brands asked; any brand of the send answers", async () => {
    await state(ORG, BRAND, ["email:thierry@dualist.test"]);
    await state(OTHER_ORG, OTHER_BRAND, ["email:both@dualist.test"]);
    const otherBrand = await post({ orgId: ORG, brandIds: [OTHER_BRAND], emails: ["thierry@dualist.test"] });
    expect(otherBrand.body.results[0].stated).toBe(false);
    const multi = await post({ orgId: ORG, brandIds: [OTHER_BRAND, BRAND], emails: ["thierry@dualist.test", "both@dualist.test"] });
    expect(multi.body.results.map((r: { stated: boolean }) => r.stated)).toEqual([true, false]);
  });

  it("undoing the statement lifts it; a tag_remove or another tag never silences", async () => {
    const stated = await state(ORG, BRAND, ["email:thierry@dualist.test"]);
    await db.update(peopleCorrections).set({ undoneAt: new Date(), undoneByUserId: USER }).where(eq(peopleCorrections.id, stated.id));
    await db.insert(peopleCorrections).values([
      { orgId: ORG, brandId: BRAND, kind: "tag_remove", personId: null, personKeys: ["email:thierry@dualist.test"], target: { tag: "professional_not_to_brand" }, targetKey: "tag_remove:professional_not_to_brand", reason: null, statedByUserId: USER },
      { orgId: ORG, brandId: BRAND, kind: "tag_add", personId: null, personKeys: ["email:thierry@dualist.test"], target: { tag: "professional_to_brand" }, targetKey: "tag_add:professional_to_brand", reason: null, statedByUserId: USER },
    ]);
    const res = await post({ orgId: ORG, brandIds: [BRAND], emails: ["thierry@dualist.test"] });
    expect(res.body.results[0]).toMatchObject({ stated: false, correctionId: null });
  });

  it("opens no run for an answer where nobody is stated (asked on every status read); one when someone is", async () => {
    runCalls = 0;
    await post({ orgId: ORG, brandIds: [BRAND], emails: ["thierry@dualist.test"] });
    expect(runCalls).toBe(0);
    await state(ORG, BRAND, ["email:thierry@dualist.test"]);
    await post({ orgId: ORG, brandIds: [BRAND], emails: ["thierry@dualist.test"] });
    expect(runCalls).toBeGreaterThan(0);
  });

  it("email-sets: the whole answer at once agrees with the per-address read (STATUS-CRM-TIMEOUT-1107)", async () => {
    const onEmail = await state(ORG, BRAND, ["email:thierry@dualist.test"]);
    const onPhone = await state(ORG, BRAND, ["phone:+33611111111"]);
    await state(OTHER_ORG, BRAND, ["email:other-org@dualist.test"]);
    const sets = await request(app()).post("/internal/people/stated-not-to-brand/email-sets").set("x-api-key", API_KEY).send({ orgId: ORG, brandIds: [BRAND, OTHER_BRAND] });
    expect(sets.status).toBe(200);
    expect(sets.body).toEqual({
      orgId: ORG,
      brandIds: [BRAND, OTHER_BRAND],
      statements: [
        { correctionId: onEmail.id, brandId: BRAND, emails: ["thierry@dualist.test"] },
        { correctionId: onPhone.id, brandId: BRAND, emails: ["both@dualist.test"] },
      ],
    });
    const asked = ["thierry@dualist.test", "both@dualist.test", "someone@else.test", "other-org@dualist.test"];
    const one = await post({ orgId: ORG, brandIds: [BRAND, OTHER_BRAND], emails: asked });
    const inSets = new Set(sets.body.statements.flatMap((s: { emails: string[] }) => s.emails));
    expect(one.body.results.map((r: { stated: boolean }) => r.stated)).toEqual(asked.map((e) => inSets.has(e)));
    const none = await request(app()).post("/internal/people/stated-not-to-brand/email-sets").set("x-api-key", API_KEY).send({ orgId: ORG, brandIds: [OTHER_BRAND] });
    expect(none.body.statements).toEqual([]);
    expect((await request(app()).post("/internal/people/stated-not-to-brand/email-sets").set("x-api-key", API_KEY).send({ orgId: ORG, brandIds: [] })).status).toBe(400);
  });

  it("refuses a body that names no brand or no address", async () => {
    expect((await post({ orgId: ORG, brandIds: [], emails: ["a@b.co"] })).status).toBe(400);
    expect((await post({ orgId: ORG, brandIds: [BRAND], emails: [] })).status).toBe(400);
  });
});
