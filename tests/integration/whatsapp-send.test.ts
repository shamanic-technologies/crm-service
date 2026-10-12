import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  contacts,
  contactServes,
  matrixConnections,
  matrixGhostPhones,
  matrixLinks,
  people,
  peopleScopes,
  whatsappSends,
} from "../../src/db/schema.js";
import whatsappRoutes from "../../src/routes/whatsapp.js";
import contactsRoutes from "../../src/routes/contacts.js";

/**
 * The WhatsApp send and the people-pool serve, end to end against a real
 * database. The bridge's provisioning API, the homeserver and runs-service are
 * stubbed at `fetch`, with the shapes the deployed mautrix-whatsapp answered on
 * 2026-10-12 (resolve_identifier 200 with dm_room_mxid; 404 M_NOT_FOUND "… is
 * not on WhatsApp").
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "babababa-1111-4111-8111-000000000001";
const BRAND = "babababa-1111-4111-8111-000000000002";
const BRAND_UNLINKED = "babababa-1111-4111-8111-000000000003";
const USER = "user-wa-1";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";
const SECRET = "bridge-secret-wa";

process.env.MATRIX_HOMESERVER_URL = "http://hs.test";
process.env.MATRIX_APPSERVICE_TOKEN = "as-token-wa";
process.env.MATRIX_WHATSAPP_PROVISIONING_URL = "http://wa.test";
process.env.MATRIX_WHATSAPP_PROVISIONING_SECRET = SECRET;
process.env.MATRIX_INGESTION_FLOOR = "2026-08-01";
process.env.CRM_LEAD_READING_CHAT_CONFIG = "google/flash";
// The post-send mirror pull + people rebuild runs behind the answer; off here so
// it never writes into the next test's fixtures.
process.env.WHATSAPP_SEND_REFRESH = "off";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

const ACCOUNT = "@crm_wa_a:matrix.test";
const KNOWN_ROOM = "!known:matrix.test";
let sends: { room: string; txn: string; body: string; auth: string | null }[] = [];
let createdDms: string[] = [];
let loginState = "CONNECTED";
/** Phone digits → WhatsApp state for the stub. */
const NETWORK: Record<string, { lid: string; room: string | null }> = {
  "33600000001": { lid: "lid-1", room: KNOWN_ROOM },
  "33600000002": { lid: "lid-2", room: null },
};

function installFetchStub() {
  sends = [];
  createdDms = [];
  loginState = "CONNECTED";
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "wa.test") {
      expect(auth).toBe(`Bearer ${SECRET}`);
      const path = url.pathname.replace("/_matrix/provision/v3", "");
      if (path === "/whoami") {
        return json({ logins: [{ id: "33611111111", name: "+33 6 11 11 11 11", state: { state_event: loginState } }] });
      }
      const m = path.match(/^\/(resolve_identifier|create_dm)\/(.+)$/);
      if (m) {
        expect(url.searchParams.get("login_id")).toBe("33611111111");
        const digits = decodeURIComponent(m[2]).replace(/\D/g, "");
        const who = NETWORK[digits];
        if (!who) return json({ errcode: "M_NOT_FOUND", error: `the server said +${digits} is not on WhatsApp` }, 404);
        let room = who.room;
        if (m[1] === "create_dm") {
          room = `!dm-${digits}:matrix.test`;
          createdDms.push(digits);
        }
        return json({ id: who.lid, name: `+${digits} (WA)`, mxid: `@whatsapp_${who.lid}:matrix.test`, ...(room ? { dm_room_mxid: room } : {}) });
      }
    }
    if (url.host === "hs.test") {
      if (url.pathname.startsWith("/_matrix/client/v3/join/")) return json({ room_id: "x" });
      const s = url.pathname.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/send\/m\.room\.message\/([^/]+)$/);
      if (s) {
        const body = JSON.parse(String(init?.body)).body as string;
        const existing = sends.find((x) => x.txn === s[2]);
        if (!existing) sends.push({ room: decodeURIComponent(s[1]), txn: s[2], body, auth });
        return json({ event_id: `$ev-${s[2]}` });
      }
      if (url.pathname === "/_matrix/client/v3/sync") return json({ next_batch: "s1", rooms: { join: {} } });
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  });
}

function app() {
  const a = express();
  a.use(express.json());
  a.use(whatsappRoutes);
  a.use(contactsRoutes);
  return a;
}

const headers = { "x-api-key": API_KEY, "x-org-id": ORG, "x-user-id": USER };

async function wipe() {
  await db.delete(whatsappSends).where(eq(whatsappSends.orgId, ORG));
  await db.delete(matrixLinks).where(eq(matrixLinks.orgId, ORG));
  await db.delete(matrixConnections).where(eq(matrixConnections.orgId, ORG));
  await db.delete(contactServes).where(eq(contactServes.orgId, ORG));
  await db.delete(contacts).where(eq(contacts.orgId, ORG));
  await db.delete(people).where(eq(people.orgId, ORG));
  await db.delete(peopleScopes).where(eq(peopleScopes.orgId, ORG));
  await db.delete(matrixGhostPhones).where(inArray(matrixGhostPhones.ghostMxid, ["@whatsapp_lid-1:matrix.test", "@whatsapp_lid-2:matrix.test"]));
}

async function linkAccount() {
  const [conn] = await db
    .insert(matrixConnections)
    .values({
      orgId: ORG,
      brandId: BRAND,
      channel: "whatsapp",
      matrixUserId: ACCOUNT,
      createdByUserId: USER,
      counterpartPrefix: "@whatsapp_",
      accessToken: "tok-a",
      sinceToken: "s1",
    })
    .returning();
  await db.insert(matrixLinks).values({
    orgId: ORG,
    brandId: BRAND,
    channel: "whatsapp",
    createdByUserId: USER,
    matrixUserId: ACCOUNT,
    status: "linked",
    method: "qr",
    remoteLoginId: "33611111111",
    connectionId: conn.id,
    linkedAt: new Date(),
  });
}

type P = { source: string; phones?: string[]; inboundCount?: number | null; outboundCount?: number | null; detail?: Record<string, unknown> };

async function seedPeople(rows: { key: string; phones?: string[]; presences: P[]; automated?: boolean; at: string }[]) {
  const [scope] = await db.insert(peopleScopes).values({ orgId: ORG, brandId: BRAND, createdByUserId: USER, status: "built" }).returning();
  await db.insert(people).values(
    rows.map((r) => ({
      scopeId: scope.id,
      orgId: ORG,
      brandId: BRAND,
      personKey: r.key,
      identityKeys: [r.key, ...(r.phones ?? []).map((p) => `phone:${p}`)],
      displayName: "Ann Lee",
      emails: [r.key.replace("email:", "")],
      phones: r.phones ?? [],
      sources: [...new Set(r.presences.map((p) => p.source))],
      presences: r.presences.map((p) => ({
        source: p.source,
        sourceRef: "x",
        displayName: null,
        company: null,
        emails: [],
        phones: p.phones ?? [],
        firstActivityAt: null,
        lastActivityAt: null,
        messageCount: null,
        inboundCount: p.inboundCount ?? null,
        outboundCount: p.outboundCount ?? null,
        detail: p.detail ?? {},
      })),
      mergeEvidence: [],
      state: "in_conversation",
      stateSource: "none",
      automated: r.automated ?? false,
      firstActivityAt: new Date(r.at),
    })),
  );
}

const clerk = (phones: string[] = []): P => ({
  source: "clerk",
  phones,
  detail: { phoneSources: phones.map((phone) => ({ phone, via: "clerk_public_metadata.phone" })) },
});

describe.skipIf(!RUN)("WhatsApp send (DB)", () => {
  beforeEach(async () => {
    await wipe();
    installFetchStub();
  });
  afterAll(wipe);

  it("sends to the phone the CRM knows, from the linked account, into the existing DM, once per key", async () => {
    await linkAccount();
    await seedPeople([{ key: "email:ann@x.com", phones: ["+33600000001"], presences: [clerk(["+33600000001"])], at: "2026-09-01T00:00:00Z" }]);

    const body = { brandId: BRAND, email: "Ann@x.com", text: "Hi Ann", idempotencyKey: "camp1:ann:step1" };
    const res = await request(app()).post("/orgs/whatsapp/messages").set(headers).send(body);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      status: "sent",
      duplicate: false,
      to: "+33600000001",
      phoneSource: "crm:clerk",
      fromAccount: "+33611111111",
      roomId: KNOWN_ROOM,
      previousSends: 0,
    });
    expect(sends).toHaveLength(1);
    expect(sends[0]).toMatchObject({ room: KNOWN_ROOM, body: "Hi Ann", auth: "Bearer tok-a" });
    expect(createdDms).toEqual([]);

    // The bridge's ghost for that number now carries the phone.
    const [ghost] = await db.select().from(matrixGhostPhones).where(eq(matrixGhostPhones.ghostMxid, "@whatsapp_lid-1:matrix.test"));
    expect(ghost.phone).toBe("+33600000001");

    // A retry with the same key sends nothing and answers the first outcome.
    const again = await request(app()).post("/orgs/whatsapp/messages").set(headers).send(body);
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ duplicate: true, eventId: res.body.eventId });
    expect(sends).toHaveLength(1);

    // A follow-up (new key) counts the earlier send.
    const follow = await request(app())
      .post("/orgs/whatsapp/messages")
      .set(headers)
      .send({ ...body, idempotencyKey: "camp1:ann:step2", skipIfReplied: true });
    expect(follow.status).toBe(200);
    expect(follow.body.previousSends).toBe(1);
  });

  it("opens the DM when there is none, with the phone the caller gives", async () => {
    await linkAccount();
    const res = await request(app())
      .post("/orgs/whatsapp/messages")
      .set(headers)
      .send({ brandId: BRAND, email: "bob@x.com", phone: "+33 6 00 00 00 02", text: "Hi Bob", idempotencyKey: "k-bob" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ to: "+33600000002", phoneSource: "request", roomId: "!dm-33600000002:matrix.test" });
    expect(createdDms).toEqual(["33600000002"]);
  });

  it("refuses with named codes the workflow can record", async () => {
    // No linked account.
    const unlinked = await request(app())
      .post("/orgs/whatsapp/messages")
      .set(headers)
      .send({ brandId: BRAND_UNLINKED, phone: "+33600000001", text: "x", idempotencyKey: "k1" });
    expect(unlinked.status).toBe(422);
    expect(unlinked.body.code).toBe("whatsapp_not_linked");

    await linkAccount();
    await seedPeople([
      { key: "email:nophone@x.com", presences: [clerk()], at: "2026-09-01T00:00:00Z" },
      { key: "email:answered@x.com", phones: ["+33600000001"], presences: [clerk(["+33600000001"]), { source: "gmail", inboundCount: 1, outboundCount: 1 }], at: "2026-09-01T00:00:00Z" },
    ]);

    const noPhone = await request(app())
      .post("/orgs/whatsapp/messages")
      .set(headers)
      .send({ brandId: BRAND, email: "nophone@x.com", text: "x", idempotencyKey: "k2" });
    expect(noPhone.status).toBe(422);
    expect(noPhone.body.code).toBe("no_phone_known");

    const notOn = await request(app())
      .post("/orgs/whatsapp/messages")
      .set(headers)
      .send({ brandId: BRAND, phone: "+33699999999", text: "x", idempotencyKey: "k3" });
    expect(notOn.status).toBe(422);
    expect(notOn.body.code).toBe("not_on_whatsapp");
    // The same key answers the same refusal, without asking the bridge to send.
    const notOnAgain = await request(app())
      .post("/orgs/whatsapp/messages")
      .set(headers)
      .send({ brandId: BRAND, phone: "+33699999999", text: "x", idempotencyKey: "k3" });
    expect(notOnAgain.body.code).toBe("not_on_whatsapp");

    const replied = await request(app())
      .post("/orgs/whatsapp/messages")
      .set(headers)
      .send({ brandId: BRAND, email: "answered@x.com", text: "x", idempotencyKey: "k4", skipIfReplied: true });
    expect(replied.status).toBe(422);
    expect(replied.body.code).toBe("person_replied");

    loginState = "BAD_CREDENTIALS";
    const offline = await request(app())
      .post("/orgs/whatsapp/messages")
      .set(headers)
      .send({ brandId: BRAND, phone: "+33600000001", text: "x", idempotencyKey: "k5" });
    expect(offline.status).toBe(422);
    expect(offline.body.code).toBe("whatsapp_not_connected");
    expect(sends).toHaveLength(0);
  });
});

describe.skipIf(!RUN)("people-pool serve (DB)", () => {
  beforeEach(async () => {
    await wipe();
    installFetchStub();
  });
  afterAll(wipe);

  it("serves product signups never written to or never answering, each once, never one who replied", async () => {
    await seedPeople([
      // Signed up, never written to.
      { key: "email:a@x.com", phones: ["+33600000001"], presences: [clerk(["+33600000001"])], at: "2026-09-01T00:00:00Z" },
      // Signed up, written to on Gmail and cold email, never answered.
      { key: "email:b@x.com", presences: [clerk(), { source: "gmail", inboundCount: 0, outboundCount: 2 }, { source: "instantly", detail: { replied: false, anyReply: false } }], at: "2026-09-02T00:00:00Z" },
      // Signed up, answered on Gmail.
      { key: "email:c@x.com", presences: [clerk(), { source: "gmail", inboundCount: 1, outboundCount: 1 }], at: "2026-09-03T00:00:00Z" },
      // Signed up, answered our cold email with "stop" (not engaged, still an answer).
      { key: "email:d@x.com", presences: [clerk(), { source: "instantly", detail: { replied: false, anyReply: true } }], at: "2026-09-04T00:00:00Z" },
      // Signed up, wrote on WhatsApp.
      { key: "email:e@x.com", presences: [clerk(), { source: "matrix", inboundCount: 3, outboundCount: 0 }], at: "2026-09-05T00:00:00Z" },
      // Used the Copilot only: product use, not a conversation → still in.
      { key: "email:f@x.com", presences: [clerk(), { source: "copilot", inboundCount: 4, outboundCount: 4 }], at: "2026-09-06T00:00:00Z" },
      // Not a signup.
      { key: "email:g@x.com", presences: [{ source: "posthog" }], at: "2026-09-07T00:00:00Z" },
      // Automated.
      { key: "email:h@x.com", presences: [clerk()], automated: true, at: "2026-09-08T00:00:00Z" },
    ]);

    const q = "pool=people&signedUp=true&replied=false";
    const stats = await request(app()).get(`/orgs/contacts/serve-stats?brandId=${BRAND}&${q}`).set(headers);
    expect(stats.status).toBe(200);
    expect(stats.body).toEqual({ served: 0, remainingSendable: 3, totalSendable: 3 });

    const phoneOnly = await request(app()).get(`/orgs/contacts/serve-stats?brandId=${BRAND}&${q}&reachableBy=phone`).set(headers);
    expect(phoneOnly.body.totalSendable).toBe(1);

    const served: string[] = [];
    for (let i = 0; i < 4; i++) {
      const res = await request(app())
        .post("/orgs/contacts/serve-next")
        .set(headers)
        .send({ brandId: BRAND, limit: 1, people: { signedUp: true, replied: false } });
      expect(res.status).toBe(200);
      served.push(...res.body.contacts.map((c: { primaryEmail: string }) => c.primaryEmail));
      if (i === 0) {
        expect(res.body.contacts[0]).toMatchObject({
          pool: "people",
          primaryEmail: "a@x.com",
          phoneE164: "+33600000001",
          phoneSources: [{ phone: "+33600000001", source: "clerk", via: "clerk_public_metadata.phone" }],
          firstName: "Ann",
          lastName: "Lee",
        });
      }
      if (i === 2) expect(res.body.exhausted).toBe(true);
    }
    expect(served).toEqual(["a@x.com", "b@x.com", "f@x.com"]);

    const after = await request(app()).get(`/orgs/contacts/serve-stats?brandId=${BRAND}&${q}`).set(headers);
    expect(after.body).toEqual({ served: 3, remainingSendable: 0, totalSendable: 3 });
  });

  it("a serve FOR a pipe skips whom the pipe cannot reach, without marking them, on both pools", async () => {
    await seedPeople([
      { key: "email:ph@x.com", phones: ["+33600000001"], presences: [clerk(["+33600000001"])], at: "2026-09-01T00:00:00Z" },
      { key: "email:nophone@x.com", presences: [clerk()], at: "2026-09-02T00:00:00Z" },
    ]);
    const people = { signedUp: true, replied: false };

    // The WhatsApp pipe: phone required. The no-phone person is not reachable.
    const wa = await request(app())
      .post("/orgs/contacts/serve-next")
      .set(headers)
      .send({ brandId: BRAND, limit: 10, people, reachableBy: "phone" });
    expect(wa.status).toBe(200);
    expect(wa.body.contacts.map((c: { primaryEmail: string }) => c.primaryEmail)).toEqual(["ph@x.com"]);
    expect(wa.body.exhausted).toBe(true);

    // The email pipe still gets the no-phone person: never marked by the WhatsApp serve.
    const statsEmail = await request(app()).get(`/orgs/contacts/serve-stats?brandId=${BRAND}&pool=people&signedUp=true&replied=false&reachableBy=email`).set(headers);
    expect(statsEmail.body).toEqual({ served: 1, remainingSendable: 1, totalSendable: 2 });
    const mail = await request(app())
      .post("/orgs/contacts/serve-next")
      .set(headers)
      .send({ brandId: BRAND, limit: 10, people, reachableBy: ["email"] });
    expect(mail.body.contacts.map((c: { primaryEmail: string }) => c.primaryEmail)).toEqual(["nophone@x.com"]);

    // CSV pool: same rule.
    const upload = "babababa-1111-4111-8111-0000000000a1";
    await db.insert(contacts).values(
      ["csvph@x.com", "csvnophone@x.com"].map((email, i) => ({
        orgId: ORG,
        brandId: BRAND,
        primaryEmail: email,
        phoneE164: i === 0 ? "+33600000009" : null,
        rawAttributes: {},
        consentStatus: "unknown",
        unsubscribed: false,
        sourceUploadId: upload,
        sourceRowId: `babababa-1111-4111-8111-0000000000b${i}`,
      })),
    );
    const csvStats = await request(app()).get(`/orgs/contacts/serve-stats?brandId=${BRAND}&reachableBy=phone`).set(headers);
    expect(csvStats.body.totalSendable).toBe(1);
    const csv = await request(app()).post("/orgs/contacts/serve-next").set(headers).send({ brandId: BRAND, limit: 10, reachableBy: "phone" });
    expect(csv.body.contacts.map((c: { primaryEmail: string }) => c.primaryEmail)).toEqual(["csvph@x.com"]);
    const csvAll = await request(app()).post("/orgs/contacts/serve-next").set(headers).send({ brandId: BRAND, limit: 10 });
    expect(csvAll.body.contacts.map((c: { primaryEmail: string }) => c.primaryEmail)).toEqual(["csvnophone@x.com"]);
  });

  it("refuses uploadIds together with people", async () => {
    const res = await request(app())
      .post("/orgs/contacts/serve-next")
      .set(headers)
      .send({ brandId: BRAND, uploadIds: [BRAND], people: { signedUp: true } });
    expect(res.status).toBe(400);
  });
});
