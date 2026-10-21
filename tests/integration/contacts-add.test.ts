import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { contactEmailLookups, contactRowsRaw, contactServes, contactUploads, contacts } from "../../src/db/schema.js";
import contactRoutes from "../../src/routes/contacts.js";
import { promoteUpload } from "../../src/lib/promote.js";
import { serveNext } from "../../src/lib/serve.js";

/**
 * CRM-ADD-ONE-CONTACT-1021 against a real Postgres (gated on CRM_TEST_DB): a client adds ONE
 * person (JSON), with or without an email; an email-unknown contact is handed out by serve-next
 * (`includeEmailUnknown`) and the found email written back. Staff test addresses only.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "ad1c0de0-1111-4111-8111-000000000001";
const BRAND = "ad1c0de0-1111-4111-8111-000000000002";
const USER = "ad1c0de0-1111-4111-8111-000000000003";
const FILE = "ad1c0de0-1111-4111-8111-00000000000f";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

function app() {
  const a = express();
  a.use(express.json());
  a.use(contactRoutes);
  return a;
}
const add = (body: Record<string, unknown>) =>
  request(app())
    .post("/orgs/contacts")
    .set("x-api-key", API_KEY)
    .set("x-org-id", ORG)
    .set("x-user-id", USER)
    .send({ brandId: BRAND, ...body });
const serve = (body: Record<string, unknown>) =>
  request(app()).post("/orgs/contacts/serve-next").set("x-api-key", API_KEY).set("x-org-id", ORG).send({ brandId: BRAND, ...body });
const writeBack = (contactId: string, body: Record<string, unknown>) =>
  request(app())
    .post(`/orgs/contacts/${contactId}/email-lookup`)
    .set("x-api-key", API_KEY)
    .set("x-org-id", ORG)
    .send({ brandId: BRAND, ...body });
const list = () => request(app()).get(`/orgs/contacts?brandId=${BRAND}`).set("x-api-key", API_KEY).set("x-org-id", ORG);

async function wipe() {
  await db.delete(contactEmailLookups).where(eq(contactEmailLookups.orgId, ORG));
  await db.delete(contactServes).where(eq(contactServes.orgId, ORG));
  await db.delete(contacts).where(eq(contacts.orgId, ORG));
  await db.delete(contactUploads).where(eq(contactUploads.orgId, ORG));
}

const PERSON = {
  fullName: "Test Person",
  companyName: "Distribute Test Co",
  companyDomain: "https://www.distribute.you/about",
  jobTitle: "Head of Automation",
  linkedinUrl: "linkedin.com/in/Staff-Test-Person/?trk=x",
  note: "Met at the staff offsite",
};

describe.skipIf(!RUN)("add one contact + email lookup (DB)", () => {
  beforeEach(async () => {
    vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
      const url = new URL(String(input));
      if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
        return json({ id: "run-" + Math.random().toString(16).slice(2) });
      }
      throw new Error(`unexpected fetch ${url}`);
    });
    await wipe();
  });
  afterAll(async () => {
    await wipe();
    vi.unstubAllGlobals();
  });

  it("AC1: name + company + LinkedIn is added, listed with its fields, email not known yet", async () => {
    const res = await add(PERSON);
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ created: true, matchedOn: null, emailStatus: "unknown" });
    expect(res.body.contact).toMatchObject({
      fullName: "Test Person",
      firstName: "Test",
      lastName: "Person",
      companyName: "Distribute Test Co",
      companyDomain: "distribute.you",
      jobTitle: "Head of Automation",
      linkedinUrl: "https://www.linkedin.com/in/staff-test-person",
      note: "Met at the staff offsite",
      primaryEmail: null,
      source: "csv",
    });
    const listed = (await list()).body.contacts;
    expect(listed).toHaveLength(1);
    expect(listed[0]).toMatchObject({ id: res.body.contactId, emailStatus: "unknown", note: "Met at the staff offsite" });
    const uploads = await db.select().from(contactUploads).where(eq(contactUploads.orgId, ORG));
    expect(uploads).toHaveLength(1);
    expect(uploads[0]).toMatchObject({ kind: "manual", filename: "Contacts added one by one" });
  });

  it("refuses what cannot be found, and a bad LinkedIn", async () => {
    expect((await add({ fullName: "Only A Name" })).status).toBe(400);
    expect((await add({ fullName: "X", linkedinUrl: "https://example.com/x" })).status).toBe(400);
    expect((await add({ companyName: "No Name Co" })).body.type).toBe("not_enough_to_find");
  });

  it("AC2: handed out with what finds the email, once; found makes it sendable + served; not_found stops it", async () => {
    const a = (await add(PERSON)).body.contactId as string;
    const b = (await add({ fullName: "Other Tester", companyDomain: "distribute.you" })).body.contactId as string;

    // Current callers (no flag) never see them.
    const plain = await serve({ limit: 10 });
    expect(plain.body).toEqual({ contacts: [], served: 0, exhausted: true });

    const first = await serve({ limit: 10, includeEmailUnknown: true });
    expect(first.status).toBe(200);
    expect(first.body.contacts.map((c: { id: string }) => c.id).sort()).toEqual([a, b].sort());
    const handed = first.body.contacts.find((c: { id: string }) => c.id === a);
    expect(handed).toMatchObject({
      primaryEmail: null,
      emailStatus: "unknown",
      fullName: "Test Person",
      companyDomain: "distribute.you",
      linkedinUrl: "https://www.linkedin.com/in/staff-test-person",
      note: "Met at the staff offsite",
    });
    expect(first.body.emailUnknown).toMatchObject({ served: 2, remaining: 0, handedOut: 2 });
    expect(first.body.exhausted).toBe(true);

    // Never handed out twice.
    expect((await serve({ limit: 10, includeEmailUnknown: true })).body.contacts).toEqual([]);

    const found = await writeBack(a, { status: "found", email: "K.Lourd+addone@distribute.you" });
    expect(found.status).toBe(200);
    expect(found.body).toMatchObject({ emailStatus: "known", email: "k.lourd+addone@distribute.you", served: true, duplicateOf: null });
    // A normal sendable contact now, already served (the hand-out was its serve).
    const [row] = await db.execute(sql`SELECT count(*)::int AS n FROM sendable_contacts WHERE id = ${a}`) as unknown as { n: number }[];
    expect(row.n).toBe(1);
    expect((await serveNext(ORG, BRAND, 10, "r")).served).toBe(0);
    // Idempotent.
    expect((await writeBack(a, { status: "found", email: "k.lourd+addone@distribute.you" })).status).toBe(200);
    expect((await writeBack(a, { status: "found", email: "other@distribute.you" })).status).toBe(409);

    const nf = await writeBack(b, { status: "not_found" });
    expect(nf.body).toMatchObject({ emailStatus: "not_found", served: false });
    // Even after the hand-out TTL, a not_found is never handed out again.
    await db.execute(sql`UPDATE contact_email_lookups SET handed_out_at = now() - interval '48 hours' WHERE org_id = ${ORG}`);
    expect((await serve({ limit: 10, includeEmailUnknown: true })).body.contacts).toEqual([]);
    const listed = (await list()).body.contacts as { id: string; emailStatus: string }[];
    expect(listed.find((c) => c.id === b)?.emailStatus).toBe("not_found");
  });

  it("an unresolved hand-out comes back after the TTL", async () => {
    const a = (await add(PERSON)).body.contactId as string;
    expect((await serve({ includeEmailUnknown: true })).body.contacts).toHaveLength(1);
    await db.execute(sql`UPDATE contact_email_lookups SET handed_out_at = now() - interval '25 hours' WHERE org_id = ${ORG}`);
    const again = await serve({ includeEmailUnknown: true });
    expect(again.body.contacts.map((c: { id: string }) => c.id)).toEqual([a]);
  });

  it("AC3: with an email it is sendable at once, like a CSV contact", async () => {
    const res = await add({ email: "k.lourd+addtwo@distribute.you", fullName: "Staff Two", companyName: "Co" });
    expect(res.body.emailStatus).toBe("known");
    const served = await serveNext(ORG, BRAND, 10, "r");
    expect(served.contacts.map((c) => c.id)).toEqual([res.body.contactId]);
    expect(served.contacts[0]).toMatchObject({ companyName: "Co", emailStatus: "known" });
  });

  it("AC4: the same LinkedIn or email twice keeps one person (notes kept, latest values win)", async () => {
    const first = await add(PERSON);
    const again = await add({ linkedinUrl: "https://fr.linkedin.com/in/staff-test-person/", jobTitle: "VP Automation", note: "Prefers email" });
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ contactId: first.body.contactId, created: false, matchedOn: "linkedin" });
    expect(again.body.contact).toMatchObject({ jobTitle: "VP Automation", companyName: "Distribute Test Co", note: "Met at the staff offsite\n\nPrefers email" });

    const withEmail = await add({ linkedinUrl: PERSON.linkedinUrl, email: "k.lourd+addthree@distribute.you" });
    expect(withEmail.body).toMatchObject({ contactId: first.body.contactId, emailStatus: "known" });
    const byEmail = await add({ email: "K.LOURD+addthree@distribute.you", fullName: "Test Person" });
    expect(byEmail.body).toMatchObject({ contactId: first.body.contactId, created: false, matchedOn: "email" });
    expect((await list()).body.contacts).toHaveLength(1);
  });

  it("a person already in a CSV file is taken over: one contact, the file's phone and opt-out kept", async () => {
    await db.insert(contactUploads).values({
      id: FILE, orgId: ORG, brandId: BRAND, filename: "f.csv", contentHash: "h", rowCount: 1,
      columnHeaders: ["Email", "Phone", "Unsubscribed"], columnMapping: { Email: "email", Phone: "phone", Unsubscribed: "other" },
      mappingProvenance: "override", status: "promoted", runId: "r",
    });
    await db.insert(contactRowsRaw).values({ orgId: ORG, brandId: BRAND, uploadId: FILE, rowNumber: 0, payload: { Email: "k.lourd+file@distribute.you", Phone: "+33600000099", Unsubscribed: "yes" } });
    await promoteUpload(FILE);
    expect((await list()).body.contacts).toHaveLength(1);

    const res = await add({ email: "k.lourd+file@distribute.you", jobTitle: "CTO", note: "Known from the file" });
    expect(res.body).toMatchObject({ created: false, matchedOn: "email" });
    expect(res.body.contact).toMatchObject({ phoneE164: "+33600000099", jobTitle: "CTO", unsubscribed: true });
    // Re-promoting the file does not bring a second copy back.
    await promoteUpload(FILE);
    const listed = (await list()).body.contacts;
    expect(listed).toHaveLength(1);
    expect(listed[0].id).toBe(res.body.contactId);
    // Opted out stays out of every serve.
    expect((await serveNext(ORG, BRAND, 10, "r")).served).toBe(0);
  });

  it("AC5: a CSV with company / title / LinkedIn columns stores them structured, raw attributes unchanged", async () => {
    await db.insert(contactUploads).values({
      id: FILE, orgId: ORG, brandId: BRAND, filename: "f.csv", contentHash: "h2", rowCount: 1,
      columnHeaders: ["Email", "Company", "Website", "Job Title", "LinkedIn", "City"],
      columnMapping: { Email: "email", Company: "company_name", Website: "company_domain", "Job Title": "job_title", LinkedIn: "linkedin_url", City: "other" },
      mappingProvenance: "override", status: "promoted", runId: "r",
    });
    const payload = { Email: "k.lourd+csv@distribute.you", Company: "Acme Test", Website: "https://acme.test.distribute.you/", "Job Title": "CEO", LinkedIn: "https://www.linkedin.com/in/acme-ceo", City: "Paris" };
    await db.insert(contactRowsRaw).values({ orgId: ORG, brandId: BRAND, uploadId: FILE, rowNumber: 0, payload });
    await promoteUpload(FILE);
    const [c] = await db.select().from(contacts).where(eq(contacts.orgId, ORG));
    expect(c).toMatchObject({
      companyName: "Acme Test",
      companyDomain: "acme.test.distribute.you",
      jobTitle: "CEO",
      linkedinUrl: "https://www.linkedin.com/in/acme-ceo",
      rawAttributes: { Company: "Acme Test", Website: "https://acme.test.distribute.you/", "Job Title": "CEO", LinkedIn: "https://www.linkedin.com/in/acme-ceo", City: "Paris" },
    });
  });

  it("business_only never hands out an email-unknown contact (no known person to judge)", async () => {
    await add(PERSON);
    const res = await serve({ includeEmailUnknown: true, relationships: "business_only" });
    expect(res.status).toBe(200);
    expect(res.body.contacts).toEqual([]);
    expect(res.body.emailUnknown).toMatchObject({ served: 0, remaining: 1, skipped: "business_only_needs_a_known_person" });
  });

  it("includeEmailUnknown is refused on the people pool", async () => {
    expect((await serve({ includeEmailUnknown: true, people: { signedUp: true } })).status).toBe(400);
  });
});
