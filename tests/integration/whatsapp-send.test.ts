import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  contacts,
  contactServes,
  conversations,
  whatsappPhoneLookups,
  matrixConnections,
  matrixGhostPhones,
  matrixLinks,
  matrixRawEvents,
  people,
  peopleScopes,
  staffAlerts,
  whatsappSends,
} from "../../src/db/schema.js";
import { like } from "drizzle-orm";
import whatsappRoutes from "../../src/routes/whatsapp.js";
import contactsRoutes from "../../src/routes/contacts.js";
import matrixRoutes from "../../src/routes/matrix.js";
import { resolveBrandWhatsappPhones } from "../../src/lib/whatsapp/phone-resolution.js";

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
const ACCOUNT_PRO = "@crm_wa_pro:matrix.test";
const LOGIN_OF: Record<string, string> = { [ACCOUNT]: "33611111111", [ACCOUNT_PRO]: "33622222222" };
let lookups: string[] = [];
let telegrams: string[] = [];
/** Digits the stub bridge answers 500 M_UNKNOWN for (what mautrix-whatsapp answers when WhatsApp says the contact is "invalid"). */
const BRIDGE_500 = new Set(["2541110229905", "33600000009"]);
const KNOWN_ROOM = "!known:matrix.test";
let sends: { room: string; txn: string; body: string; auth: string | null }[] = [];
let createdDms: string[] = [];
let loginState = "CONNECTED";
/** Room → the bridge's `m.bridge` channel id, when a test makes a room deliver to someone else. */
let roomChannelOverride: Record<string, string> = {};
/** Digits → the room `create_dm` answers instead of a fresh `!dm-<digits>` one. */
let createDmRoomOverride: Record<string, string> = {};
const jidOfLid = (lid: string) => `${lid.replace(/^lid-/, "")}@lid`;
/** Phone digits → WhatsApp state for the stub. */
const NETWORK: Record<string, { lid: string; room: string | null }> = {
  "33600000001": { lid: "lid-1", room: KNOWN_ROOM },
  "33600000002": { lid: "lid-2", room: null },
};

function installFetchStub() {
  sends = [];
  createdDms = [];
  lookups = [];
  telegrams = [];
  loginState = "CONNECTED";
  roomChannelOverride = {};
  createDmRoomOverride = {};
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "api.telegram.org") {
      telegrams.push(JSON.parse(String(init?.body)).text as string);
      return json({ ok: true, result: { message_id: telegrams.length } });
    }
    if (url.host === "wa.test") {
      expect(auth).toBe(`Bearer ${SECRET}`);
      const path = url.pathname.replace("/_matrix/provision/v3", "");
      if (path === "/whoami") {
        const login = LOGIN_OF[url.searchParams.get("user_id")!] ?? "33611111111";
        return json({ logins: [{ id: login, name: login, state: { state_event: loginState } }] });
      }
      const m = path.match(/^\/(resolve_identifier|create_dm)\/(.+)$/);
      if (m) {
        expect(url.searchParams.get("login_id")).toBe(LOGIN_OF[url.searchParams.get("user_id")!] ?? "33611111111");
        lookups.push(decodeURIComponent(m[2]));
        const digits = decodeURIComponent(m[2]).replace(/\D/g, "");
        if (BRIDGE_500.has(digits)) return json({ errcode: "M_UNKNOWN", error: "Internal error resolving identifier" }, 500);
        const who = NETWORK[digits];
        if (!who) return json({ errcode: "M_NOT_FOUND", error: `the server said +${digits} is not on WhatsApp` }, 404);
        let room = who.room;
        if (m[1] === "create_dm") {
          room = createDmRoomOverride[digits] ?? `!dm-${digits}:matrix.test`;
          createdDms.push(digits);
        }
        return json({ id: who.lid, name: `+${digits} (WA)`, mxid: `@whatsapp_${who.lid}:matrix.test`, ...(room ? { dm_room_mxid: room } : {}) });
      }
    }
    if (url.host === "hs.test") {
      if (url.pathname.startsWith("/_matrix/client/v3/join/")) return json({ room_id: "x" });
      const st = url.pathname.match(/^\/_matrix\/client\/v3\/rooms\/([^/]+)\/state$/);
      if (st) {
        // The bridge's own statement of whom the room talks to, on the token's login.
        const room = decodeURIComponent(st[1]);
        const dmDigits = room.match(/^!dm-(\d+):/)?.[1];
        const channel =
          roomChannelOverride[room] ??
          (room === KNOWN_ROOM ? jidOfLid(NETWORK["33600000001"].lid) : dmDigits && NETWORK[dmDigits] ? jidOfLid(NETWORK[dmDigits].lid) : "unknown@lid");
        const receiver = (auth ?? "").replace("Bearer tok-", "");
        const content = { bridgebot: "@whatsappbot:matrix.test", channel: { id: channel, displayname: "x (WA)", "fi.mau.receiver": receiver } };
        return json([
          { type: "m.room.create", state_key: "", content: {} },
          { type: "m.bridge", state_key: "matrix.test/whatsapp", content },
          { type: "uk.half-shot.bridge", state_key: "matrix.test/whatsapp", content },
        ]);
      }
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
  a.use(matrixRoutes);
  return a;
}

const headers = { "x-api-key": API_KEY, "x-org-id": ORG, "x-user-id": USER };

async function wipe() {
  await db.delete(whatsappSends).where(eq(whatsappSends.orgId, ORG));
  await db.delete(conversations).where(eq(conversations.orgId, ORG));
  await db.delete(whatsappPhoneLookups).where(inArray(whatsappPhoneLookups.phone, ["+33600000001", "+33600000002", "+33699999999", "+2541110229905"]));
  await db.delete(staffAlerts).where(like(staffAlerts.alertKey, "%babababa-1111-4111-8111-%"));
  await db.delete(matrixRawEvents).where(eq(matrixRawEvents.orgId, ORG));
  await db.delete(matrixLinks).where(eq(matrixLinks.orgId, ORG));
  await db.delete(matrixConnections).where(eq(matrixConnections.orgId, ORG));
  await db.delete(contactServes).where(eq(contactServes.orgId, ORG));
  await db.delete(contacts).where(eq(contacts.orgId, ORG));
  await db.delete(people).where(eq(people.orgId, ORG));
  await db.delete(peopleScopes).where(eq(peopleScopes.orgId, ORG));
  await db.delete(matrixGhostPhones).where(inArray(matrixGhostPhones.ghostMxid, ["@whatsapp_lid-1:matrix.test", "@whatsapp_lid-2:matrix.test"]));
}

async function linkAccount(matrixUserId = ACCOUNT, opts: { linkedAt?: Date } = {}) {
  const [conn] = await db
    .insert(matrixConnections)
    .values({
      orgId: ORG,
      brandId: BRAND,
      channel: "whatsapp",
      matrixUserId,
      createdByUserId: USER,
      counterpartPrefix: "@whatsapp_",
      accessToken: `tok-${LOGIN_OF[matrixUserId]}`,
      sinceToken: "s1",
    })
    .returning();
  const [link] = await db
    .insert(matrixLinks)
    .values({
      orgId: ORG,
      brandId: BRAND,
      channel: "whatsapp",
      createdByUserId: USER,
      matrixUserId,
      status: "linked",
      method: "qr",
      remoteLoginId: LOGIN_OF[matrixUserId],
      connectionId: conn.id,
      linkedAt: opts.linkedAt ?? new Date(),
    })
    .returning();
  return { connectionId: conn.id, linkId: link.id };
}

/** A mirrored WhatsApp conversation of `connectionId` with the ghost, phone unknown (a LID ghost). */
async function mirroredThread(connectionId: string, ghost: string, messages: number) {
  const [c] = await db
    .insert(contacts)
    .values({
      orgId: ORG,
      brandId: BRAND,
      primaryEmail: null,
      phoneE164: null,
      rawAttributes: {},
      consentStatus: "unknown",
      unsubscribed: false,
      source: "matrix",
      channel: "whatsapp",
      channelHandle: ghost,
      sourceConnectionId: connectionId,
    })
    .returning();
  await db.insert(conversations).values({
    orgId: ORG,
    brandId: BRAND,
    connectionId,
    contactId: c.id,
    channel: "whatsapp",
    roomId: `!room-${connectionId}`,
    firstMessageAt: new Date("2026-09-01T00:00:00Z"),
    lastMessageAt: new Date("2026-09-02T00:00:00Z"),
    messageCount: messages,
    inboundCount: messages,
    outboundCount: 0,
    lastEventId: "$x",
  });
  return c.id;
}

/** One message sent AS the brand's account into the mirrored thread of `connectionId` (typed on the phone, or one of our sends mirrored back). */
async function ownMessage(connectionId: string, matrixUserId: string, eventId: string, body: string) {
  await db.insert(matrixRawEvents).values({
    orgId: ORG, brandId: BRAND, connectionId, eventId, roomId: `!room-${connectionId}`, sender: matrixUserId, eventType: "m.room.message",
    originServerTs: new Date("2026-09-02T00:00:00Z"),
    payload: { event_id: eventId, type: "m.room.message", sender: matrixUserId, origin_server_ts: Date.parse("2026-09-02T00:00:00Z"), content: { msgtype: "m.text", body } },
  });
}

type P = { source: string; phones?: string[]; inboundCount?: number | null; outboundCount?: number | null; detail?: Record<string, unknown> };

async function seedPeople(rows: { key: string; emails?: string[]; phones?: string[]; presences: P[]; automated?: boolean; at: string }[]) {
  const [scope] = await db.insert(peopleScopes).values({ orgId: ORG, brandId: BRAND, createdByUserId: USER, status: "built" }).returning();
  await db.insert(people).values(
    rows.map((r) => ({
      scopeId: scope.id,
      orgId: ORG,
      brandId: BRAND,
      personKey: r.key,
      identityKeys: [r.key, ...(r.phones ?? []).map((p) => `phone:${p}`)],
      displayName: "Ann Lee",
      emails: r.emails ?? [r.key.replace("email:", "")],
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
    expect(sends[0]).toMatchObject({ room: KNOWN_ROOM, body: "Hi Ann", auth: "Bearer tok-33611111111" });
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

  it("writes from the account already in conversation, else from the brand's outreach default", async () => {
    const personal = await linkAccount(ACCOUNT, { linkedAt: new Date("2026-10-01T00:00:00Z") });
    const pro = await linkAccount(ACCOUNT_PRO, { linkedAt: new Date("2026-10-02T00:00:00Z") });
    const mark = await request(app())
      .patch(`/orgs/matrix/links/${pro.linkId}`)
      .set(headers)
      .send({ brandId: BRAND, outreachDefault: true });
    expect(mark.status).toBe(200);
    expect(mark.body.link.outreachDefault).toBe(true);

    // Nobody talks with +33600000002 yet: the pro (default) account writes.
    const fresh = await request(app())
      .post("/orgs/whatsapp/messages")
      .set(headers)
      .send({ brandId: BRAND, phone: "+33600000002", text: "Hi", idempotencyKey: "k-fresh" });
    expect(fresh.body.fromAccount).toBe("+33622222222");

    // A real conversation with +33600000001 exists on the personal account: it keeps the thread.
    await mirroredThread(personal.connectionId, "@whatsapp_lid-1:matrix.test", 12);
    const known = await request(app())
      .post("/orgs/whatsapp/messages")
      .set(headers)
      .send({ brandId: BRAND, phone: "+33600000001", text: "Hi again", idempotencyKey: "k-known" });
    expect(known.body.fromAccount).toBe("+33611111111");
  });

  it("an automated send never writes from an account the brand keeps out of automation, even where the person talks to it (SOPHIE-WA-1016)", async () => {
    const personal = await linkAccount(ACCOUNT, { linkedAt: new Date("2026-10-01T00:00:00Z") });
    const assistant = await linkAccount(ACCOUNT_PRO, { linkedAt: new Date("2026-10-02T00:00:00Z") });
    // New links allow automation by default.
    const before = await request(app()).get(`/orgs/matrix/links?brandId=${BRAND}`).set(headers);
    expect(before.body.accounts.map((a: { automationAllowed: boolean; persona: unknown }) => [a.automationAllowed, a.persona])).toEqual([
      [true, null],
      [true, null],
    ]);

    const off = await request(app())
      .patch(`/orgs/matrix/links/${personal.linkId}`)
      .set(headers)
      .send({ brandId: BRAND, automationAllowed: false });
    expect(off.status).toBe(200);
    expect(off.body.link).toMatchObject({ automationAllowed: false, outreachDefault: false });
    const named = await request(app())
      .patch(`/orgs/matrix/links/${assistant.linkId}`)
      .set(headers)
      .send({ brandId: BRAND, persona: { name: " Sophie ", role: "AI assistant", instructions: "Warm, short." } });
    expect(named.status).toBe(200);
    expect(named.body.link.persona).toEqual({ name: "Sophie", role: "AI assistant", instructions: "Warm, short." });

    // The only conversation with +33600000001 is on the personal account: the message starts from the assistant.
    await mirroredThread(personal.connectionId, "@whatsapp_lid-1:matrix.test", 12);
    const persona = { name: "Sophie", role: "AI assistant", instructions: "Warm, short." };
    const r = await request(app()).post("/orgs/whatsapp/reach").set(headers).send({ brandId: BRAND, phone: "+33600000001" });
    expect(r.body).toMatchObject({ reachable: true, fromAccount: "+33622222222", persona });
    const sent = await request(app())
      .post("/orgs/whatsapp/messages")
      .set(headers)
      .send({ brandId: BRAND, phone: "+33600000001", text: "Hi, Sophie here", idempotencyKey: "k-sophie" });
    expect(sent.status).toBe(200);
    expect(sent.body).toMatchObject({ fromAccount: "+33622222222", persona });
    expect(sends).toHaveLength(1);
    expect(sends[0].auth).toBe("Bearer tok-33622222222");
    const again = await request(app())
      .post("/orgs/whatsapp/messages")
      .set(headers)
      .send({ brandId: BRAND, phone: "+33600000001", text: "Hi, Sophie here", idempotencyKey: "k-sophie" });
    expect(again.body).toMatchObject({ duplicate: true, persona });

    // The list shows both settings; a partial persona update keeps the other fields; null clears.
    const list = await request(app()).get(`/orgs/matrix/links?brandId=${BRAND}`).set(headers);
    const wa = list.body.links.find((l: { channel: string }) => l.channel === "whatsapp");
    expect(wa.channelAccounts.map((a: { phone: string; automationAllowed: boolean; persona: unknown }) => [a.phone, a.automationAllowed, a.persona])).toEqual([
      ["+33611111111", false, null],
      ["+33622222222", true, persona],
    ]);
    const role = await request(app())
      .patch(`/orgs/matrix/links/${assistant.linkId}`)
      .set(headers)
      .send({ brandId: BRAND, persona: { role: "" } });
    expect(role.body.link.persona).toEqual({ name: "Sophie", role: null, instructions: "Warm, short." });
    const cleared = await request(app()).patch(`/orgs/matrix/links/${assistant.linkId}`).set(headers).send({ brandId: BRAND, persona: null });
    expect(cleared.body.link.persona).toBeNull();
    const empty = await request(app()).patch(`/orgs/matrix/links/${assistant.linkId}`).set(headers).send({ brandId: BRAND });
    expect(empty.status).toBe(400);
  });

  it("refuses human_in_conversation, nothing sent, when someone of the brand typed to the person by hand on any linked account (HUMAN-IN-THREAD-1016)", async () => {
    const personal = await linkAccount(ACCOUNT, { linkedAt: new Date("2026-10-01T00:00:00Z") });
    await linkAccount(ACCOUNT_PRO, { linkedAt: new Date("2026-10-02T00:00:00Z") });
    await mirroredThread(personal.connectionId, "@whatsapp_lid-1:matrix.test", 3);

    // Only our own automated messages in the thread (one mirrored back by event id, one by its text before
    // its event id was recorded): the person still gets the follow-up.
    await db.insert(whatsappSends).values({
      orgId: ORG, brandId: BRAND, idempotencyKey: "k-earlier", phone: "+33600000001", text: "Welcome to Acme!", status: "sent",
      connectionId: personal.connectionId, roomId: `!room-${personal.connectionId}`, eventId: "$ours-1", sentAt: new Date("2026-09-02T00:00:00Z"),
    });
    await ownMessage(personal.connectionId, ACCOUNT, "$ours-1", "Welcome to Acme!");
    await ownMessage(personal.connectionId, ACCOUNT, "$ours-2-mirrored-before-recorded", "Welcome to Acme!");
    const automatedOnly = await request(app())
      .post("/orgs/whatsapp/messages")
      .set(headers)
      .send({ brandId: BRAND, phone: "+33600000001", text: "Following up", idempotencyKey: "k-follow" });
    expect(automatedOnly.status).toBe(200);
    expect(sends).toHaveLength(1);

    // The owner typed to them by hand (on his personal account): his conversation now, on every account.
    await ownMessage(personal.connectionId, ACCOUNT, "$hand-1", "Hey Noah, Kevin here, let's talk tomorrow");
    const res = await request(app())
      .post("/orgs/whatsapp/messages")
      .set(headers)
      .send({ brandId: BRAND, phone: "+33600000001", text: "Following up again", idempotencyKey: "k-follow-2" });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ type: "refused", code: "human_in_conversation" });
    expect(sends).toHaveLength(1);
    const [row] = await db.select().from(whatsappSends).where(eq(whatsappSends.idempotencyKey, "k-follow-2"));
    expect(row).toMatchObject({ status: "refused", errorCode: "human_in_conversation" });
    // A brand-side refusal the brand chose: no staff alert.
    expect(telegrams).toEqual([]);

    // The reach check answers the same, before any model writes a message.
    const reach = await request(app()).post("/orgs/whatsapp/reach").set(headers).send({ brandId: BRAND, phone: "+33600000001" });
    expect(reach.body).toMatchObject({ reachable: false, code: "human_in_conversation" });

    // A brand-new lead (no thread at all) still gets the welcome.
    const newcomer = await request(app())
      .post("/orgs/whatsapp/messages")
      .set(headers)
      .send({ brandId: BRAND, phone: "+33600000002", text: "Welcome!", idempotencyKey: "k-new" });
    expect(newcomer.status).toBe(200);
    expect(sends).toHaveLength(2);
  });

  it("refuses automation_not_allowed, nothing sent, when no linked account allows automated sends (SOPHIE-WA-1016)", async () => {
    const personal = await linkAccount(ACCOUNT);
    const pro = await linkAccount(ACCOUNT_PRO);
    for (const l of [personal, pro]) {
      await request(app()).patch(`/orgs/matrix/links/${l.linkId}`).set(headers).send({ brandId: BRAND, automationAllowed: false }).expect(200);
    }
    const res = await request(app())
      .post("/orgs/whatsapp/messages")
      .set({ ...headers, "x-campaign-id": "babababa-1111-4111-8111-0000000000c1" })
      .send({ brandId: BRAND, phone: "+33600000001", text: "Hi", idempotencyKey: "k-none-allowed" });
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ type: "refused", code: "automation_not_allowed" });
    expect(sends).toEqual([]);
    expect(createdDms).toEqual([]);
    const [row] = await db.select().from(whatsappSends).where(eq(whatsappSends.idempotencyKey, "k-none-allowed"));
    expect(row).toMatchObject({ status: "refused", errorCode: "automation_not_allowed" });
    const reach = await request(app()).post("/orgs/whatsapp/reach").set(headers).send({ brandId: BRAND, phone: "+33600000001" });
    expect(reach.body).toMatchObject({ reachable: false, code: "automation_not_allowed" });
    // Naming a disallowed account explicitly is refused the same way.
    await request(app()).patch(`/orgs/matrix/links/${pro.linkId}`).set(headers).send({ brandId: BRAND, automationAllowed: true }).expect(200);
    const named = await request(app())
      .post("/orgs/whatsapp/reach")
      .set(headers)
      .send({ brandId: BRAND, phone: "+33600000001", fromAccount: "+33611111111" });
    expect(named.body).toMatchObject({ reachable: false, code: "automation_not_allowed" });
  });

  it("never posts into a DM room the bridge maps to someone else (JACKSON-WA-WRONG-ROOM)", async () => {
    await linkAccount();
    // The bridge answers KNOWN_ROOM for +33600000001, but the room's m.bridge is another person.
    roomChannelOverride[KNOWN_ROOM] = "152128261730337@lid";
    // create_dm hands back the same broken room: no correct DM exists.
    createDmRoomOverride["33600000001"] = KNOWN_ROOM;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});

    const body = { brandId: BRAND, phone: "+33600000001", text: "Test", idempotencyKey: "k-wrong-room" };
    const res = await request(app()).post("/orgs/whatsapp/messages").set(headers).send(body);
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ type: "refused", code: "wrong_room" });
    expect(res.body.error).toContain("152128261730337@lid");
    expect(sends).toEqual([]);
    const [row] = await db.select().from(whatsappSends).where(eq(whatsappSends.idempotencyKey, "k-wrong-room"));
    expect(row).toMatchObject({ status: "refused", errorCode: "wrong_room", phone: "+33600000001", roomId: null, eventId: null });
    expect(row.error).toContain(KNOWN_ROOM);
    expect(errors.mock.calls.some((c) => String(c[0]).includes("WRONG ROOM refused") && String(c[0]).includes("+33600000001"))).toBe(true);

    // A retry under the same key answers the same refusal and still sends nothing.
    const again = await request(app()).post("/orgs/whatsapp/messages").set(headers).send(body);
    expect(again.status).toBe(422);
    expect(again.body.code).toBe("wrong_room");
    expect(sends).toEqual([]);

    // When the bridge can open a fresh DM that IS the person, the send goes there instead.
    delete createDmRoomOverride["33600000001"];
    const fixed = await request(app()).post("/orgs/whatsapp/messages").set(headers).send({ ...body, idempotencyKey: "k-wrong-room-2" });
    expect(fixed.status).toBe(200);
    expect(fixed.body.roomId).toBe("!dm-33600000001:matrix.test");
    expect(sends.map((x) => x.room)).toEqual(["!dm-33600000001:matrix.test"]);
    errors.mockRestore();
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

  it("a number that cannot exist is 'not on WhatsApp', a bridge 500 on a valid one stays a bridge error (WHATSAPP-RESOLVE-1015)", async () => {
    await linkAccount();
    // Kenya: 9-digit national numbers; this one has 10. WhatsApp answers "invalid", the bridge a 500.
    const invalid = await request(app())
      .post("/orgs/whatsapp/messages")
      .set(headers)
      .send({ brandId: BRAND, phone: "+2541110229905", text: "x", idempotencyKey: "inv-1" });
    expect(invalid.status).toBe(422);
    expect(invalid.body.code).toBe("not_on_whatsapp");
    expect(invalid.body.error).toContain("not a valid phone number");

    const outage = await request(app())
      .post("/orgs/whatsapp/messages")
      .set(headers)
      .send({ brandId: BRAND, phone: "+33600000009", text: "x", idempotencyKey: "inv-2" });
    expect(outage.status).toBe(502);
    expect(outage.body.code).toBe("bridge_error");
    expect(sends).toHaveLength(0);
  });

  it("tells staff once a day per brand when a campaign cannot write because WhatsApp is not linked", async () => {
    process.env.TELEGRAM_BOT_TOKEN = "tg-token";
    process.env.TELEGRAM_OWNER_CHAT_ID = "42";
    try {
      // Not a campaign: no alert.
      await request(app())
        .post("/orgs/whatsapp/messages")
        .set(headers)
        .send({ brandId: BRAND_UNLINKED, phone: "+33600000001", text: "x", idempotencyKey: "al-0" });
      for (const k of ["al-1", "al-2"]) {
        const r = await request(app())
          .post("/orgs/whatsapp/messages")
          .set({ ...headers, "x-campaign-id": "camp-1" })
          .send({ brandId: BRAND_UNLINKED, phone: "+33600000001", text: "x", idempotencyKey: k });
        expect(r.body.code).toBe("whatsapp_not_linked");
      }
      await vi.waitFor(async () => {
        const [row] = await db.select().from(staffAlerts).where(like(staffAlerts.alertKey, `%${BRAND_UNLINKED}%`));
        expect(row?.status).toBe("sent");
      });
      await new Promise((r) => setTimeout(r, 100));
      expect(telegrams).toHaveLength(1);
      expect(telegrams[0]).toContain("no WhatsApp account linked");
      expect(telegrams[0]).toContain("link their WhatsApp");
    } finally {
      delete process.env.TELEGRAM_BOT_TOKEN;
      delete process.env.TELEGRAM_OWNER_CHAT_ID;
    }
  });
});

describe.skipIf(!RUN)("WhatsApp threads merge into the person by phone (DB)", () => {
  beforeEach(async () => {
    await wipe();
    installFetchStub();
  });
  afterAll(wipe);

  it("asks the bridge once per CRM phone and puts the phone on the mirrored LID thread", async () => {
    const { connectionId } = await linkAccount();
    const contactId = await mirroredThread(connectionId, "@whatsapp_lid-1:matrix.test", 40);
    await seedPeople([
      { key: "email:ann@x.com", phones: ["+33600000001"], presences: [clerk(["+33600000001"])], at: "2026-09-01T00:00:00Z" },
      { key: "email:zed@x.com", phones: ["+33699999999"], presences: [clerk(["+33699999999"])], at: "2026-09-02T00:00:00Z" },
      // A number that cannot exist sorts FIRST and must not stop the pass (WHATSAPP-RESOLVE-1015).
      { key: "email:ke@x.com", phones: ["+2541110229905"], presences: [clerk(["+2541110229905"])], at: "2026-09-03T00:00:00Z" },
    ]);

    const first = await resolveBrandWhatsappPhones(ORG, BRAND);
    expect(first).toMatchObject({ status: "ok", asked: 3, found: 1, notOnWhatsapp: 2, contactsUpdated: 1 });
    const [ke] = await db.select().from(whatsappPhoneLookups).where(eq(whatsappPhoneLookups.phone, "+2541110229905"));
    expect(ke.outcome).toBe("invalid_number");
    const [c] = await db.select().from(contacts).where(eq(contacts.id, contactId));
    expect(c.phoneE164).toBe("+33600000001");

    // Asked once: a second pass asks nobody.
    lookups = [];
    const second = await resolveBrandWhatsappPhones(ORG, BRAND);
    expect(second.asked).toBe(0);
    expect(lookups).toEqual([]);
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
      // The owner, merged across a school address and his staff Gmail (plus-addressed): never in a pool.
      { key: "email:kevin.lourd@school.edu", emails: ["kevin.lourd@school.edu", "kevin.lourd+x@gmail.com"], presences: [clerk()], at: "2026-09-09T00:00:00Z" },
      // A test account on our own domain.
      { key: "email:qa@distribute.you", presences: [clerk()], at: "2026-09-10T00:00:00Z" },
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

/**
 * The reach check (LLM-SPEND-NO-SEND-1016): the send's checks, answered without
 * sending. Every answer here is the code the send gives for the same person.
 */
describe.skipIf(!RUN)("WhatsApp reach check (DB)", () => {
  beforeEach(async () => {
    await wipe();
    installFetchStub();
  });
  afterAll(wipe);

  const reach = (body: Record<string, unknown>) => request(app()).post("/orgs/whatsapp/reach").set(headers).send({ brandId: BRAND, ...body });
  const sendRows = () => db.select().from(whatsappSends).where(eq(whatsappSends.orgId, ORG));

  it("reachable: the phone the CRM knows, on WhatsApp, from the linked account; nothing sent, no row, no room", async () => {
    await linkAccount();
    await seedPeople([{ key: "email:ann@x.com", phones: ["+33600000002"], presences: [clerk(["+33600000002"])], at: "2026-09-01T00:00:00Z" }]);
    const res = await reach({ email: "Ann@x.com" });
    expect(res.status).toBe(200);
    expect(res.body).toEqual({ reachable: true, to: "+33600000002", phoneSource: "crm:clerk", fromAccount: "+33611111111", persona: null });
    expect(lookups).toEqual(["+33600000002"]);
    expect(sends).toEqual([]);
    expect(createdDms).toEqual([]);
    expect(await sendRows()).toEqual([]);
  });

  it("no_phone_known: a person with no phone anywhere", async () => {
    await linkAccount();
    await seedPeople([{ key: "email:nophone@x.com", presences: [clerk()], at: "2026-09-01T00:00:00Z" }]);
    const res = await reach({ email: "nophone@x.com" });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ reachable: false, code: "no_phone_known" });
    const unknown = await reach({ email: "nobody@x.com" });
    expect(unknown.body).toMatchObject({ reachable: false, code: "no_phone_known" });
    expect(lookups).toEqual([]);
    expect(await sendRows()).toEqual([]);
  });

  it("not_on_whatsapp: WhatsApp has no account, and a number that cannot exist (bridge 500) is never a 502", async () => {
    await linkAccount();
    const none = await reach({ phone: "+33699999999" });
    expect(none.status).toBe(200);
    expect(none.body).toMatchObject({ reachable: false, code: "not_on_whatsapp" });
    const impossible = await reach({ phone: "+2541110229905" });
    expect(impossible.status).toBe(200);
    expect(impossible.body).toMatchObject({ reachable: false, code: "not_on_whatsapp" });
    expect(sends).toEqual([]);
    expect(await sendRows()).toEqual([]);
  });

  it("bridge_error stays 502 on a VALID number the bridge fails on", async () => {
    await linkAccount();
    const res = await reach({ phone: "+33600000009" });
    expect(res.status).toBe(502);
    expect(res.body.code).toBe("bridge_error");
  });

  it("whatsapp_not_linked / whatsapp_not_connected: before any lookup", async () => {
    const unlinked = await request(app()).post("/orgs/whatsapp/reach").set(headers).send({ brandId: BRAND_UNLINKED, phone: "+33600000001" });
    expect(unlinked.body).toMatchObject({ reachable: false, code: "whatsapp_not_linked" });
    await linkAccount();
    loginState = "BAD_CREDENTIALS";
    const offline = await reach({ phone: "+33600000001" });
    expect(offline.body).toMatchObject({ reachable: false, code: "whatsapp_not_connected" });
    expect(lookups).toEqual([]);
  });

  it("person_replied only with skipIfReplied, as the send", async () => {
    await linkAccount();
    await seedPeople([
      { key: "email:rep@x.com", phones: ["+33600000001"], presences: [{ source: "gmail", inboundCount: 2 }, clerk(["+33600000001"])], at: "2026-09-01T00:00:00Z" },
    ]);
    expect((await reach({ email: "rep@x.com", skipIfReplied: true })).body).toMatchObject({ reachable: false, code: "person_replied" });
    expect((await reach({ email: "rep@x.com" })).body).toMatchObject({ reachable: true, to: "+33600000001" });
  });

  it("a person named by neither email nor phone is a 400", async () => {
    const res = await reach({ phone: "0612345678" });
    expect(res.status).toBe(400);
    expect(res.body.code).toBe("invalid_request");
  });
});
