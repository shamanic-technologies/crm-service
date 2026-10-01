import { describe, it, expect, beforeEach, vi } from "vitest";
import express from "express";
import request from "supertest";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { contacts, conversations, matrixConnections, matrixLinks, matrixRawEvents } from "../../src/db/schema.js";
import matrixRoutes from "../../src/routes/matrix.js";

/**
 * Self-serve linking, end to end against a real database. The homeserver, the
 * WhatsApp bridge's provisioning API and runs-service are stubbed at `fetch`.
 * The bridge stub answers with the shapes the deployed mautrix-whatsapp served
 * on 2026-10-01 (start, display_and_wait refresh, PHONE_NUMBER_TOO_SHORT).
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "eeeeeeee-1111-4111-8111-000000000001";
const BRAND = "eeeeeeee-1111-4111-8111-000000000002";
const BRAND_2 = "eeeeeeee-1111-4111-8111-000000000003";
const USER = "user-link-1";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";
const AS_TOKEN = "as-token-test";
const SECRET = "bridge-secret-test";

process.env.MATRIX_HOMESERVER_URL = "http://hs.test";
process.env.MATRIX_APPSERVICE_TOKEN = AS_TOKEN;
process.env.MATRIX_WHATSAPP_PROVISIONING_URL = "http://wa.test";
process.env.MATRIX_WHATSAPP_PROVISIONING_SECRET = SECRET;
delete process.env.MATRIX_TELEGRAM_PROVISIONING_URL;
delete process.env.MATRIX_TELEGRAM_PROVISIONING_SECRET;
process.env.MATRIX_INGESTION_FLOOR = "2026-08-01";
process.env.CRM_LEAD_READING_CHAT_CONFIG = "google/flash";

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

interface Deferred {
  resolve: (r: Response) => void;
}

let registered: string[] = [];
let bridgeCalls: { path: string; userId: string; auth: string | null; body: unknown }[] = [];
let syncAuth: string[] = [];
let pendingWaits: Deferred[] = [];
let logouts: string[] = [];
let processSeq = 0;

function qrStep(processId: string, data: string) {
  return {
    login_id: processId,
    type: "display_and_wait",
    step_id: "fi.mau.whatsapp.login.qr",
    txn_id: "bls_x",
    instructions: "Scan the QR code with the WhatsApp mobile app to log in",
    display_and_wait: { type: "qr", data },
  };
}

function installFetchStub() {
  registered = [];
  bridgeCalls = [];
  syncAuth = [];
  pendingWaits = [];
  logouts = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const auth = new Headers(init?.headers).get("authorization");
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    if (url.pathname.startsWith("/v1/runs") || url.pathname.startsWith("/v1/platform-runs")) {
      return json({ id: "run-" + Math.random().toString(16).slice(2) });
    }
    if (url.host === "hs.test") {
      if (url.pathname === "/_matrix/client/v3/register") {
        expect(auth).toBe(`Bearer ${AS_TOKEN}`);
        expect(body.type).toBe("m.login.application_service");
        const userId = `@${body.username}:matrix.test`;
        registered.push(userId);
        return json({ user_id: userId, device_id: null });
      }
      if (url.pathname === "/_matrix/client/v3/login") {
        return json({ user_id: `@${body.identifier.user}:matrix.test`, access_token: `tok-${body.identifier.user}` });
      }
      if (url.pathname === "/_matrix/client/v3/logout") {
        logouts.push(auth ?? "");
        return json({});
      }
      if (url.pathname === "/_matrix/client/v3/sync") {
        syncAuth.push(auth ?? "");
        return json({ next_batch: "s1", rooms: { join: {} } });
      }
    }
    if (url.host === "wa.test") {
      const userId = url.searchParams.get("user_id")!;
      const path = url.pathname.replace("/_matrix/provision/v3", "");
      bridgeCalls.push({ path, userId, auth, body });
      if (auth !== `Bearer ${SECRET}`) return json({ errcode: "M_UNKNOWN_TOKEN", error: "Invalid auth token" }, 401);
      if (path === "/login/start/qr") return json(qrStep(`proc-${++processSeq}`, "2@first-qr"));
      if (path === "/login/start/phone") {
        return json({
          login_id: `proc-${++processSeq}`,
          type: "user_input",
          step_id: "fi.mau.whatsapp.login.phone",
          user_input: { fields: [{ type: "phone_number", id: "phone_number" }] },
        });
      }
      if (path.endsWith("/user_input")) {
        if (body.phone_number === "+12") {
          return json({ errcode: "FI.MAU.WHATSAPP.PHONE_NUMBER_TOO_SHORT", error: "Phone number too short" }, 400);
        }
        return json({
          login_id: path.split("/")[3],
          type: "display_and_wait",
          step_id: "fi.mau.whatsapp.login.code",
          instructions: "Input the pairing code in the WhatsApp mobile app to log in",
          display_and_wait: { type: "code", data: "ABCD-EFGH" },
        });
      }
      if (path.endsWith("/display_and_wait")) {
        return new Promise<Response>((resolve) => pendingWaits.push({ resolve }));
      }
      if (path.startsWith("/login/cancel/")) return json({});
      if (path === "/logout/all") return json({});
      if (path === "/whoami") {
        return json({
          logins: [{ id: "33612345678", name: "+33 6 12 34 56 78", state: { state_event: "CONNECTED" } }],
        });
      }
    }
    throw new Error(`unexpected fetch ${url.toString()}`);
  });
}

function app() {
  const a = express();
  a.use(express.json());
  a.use(matrixRoutes);
  return a;
}

const headers = { "x-api-key": API_KEY, "x-org-id": ORG, "x-user-id": USER };

async function poll(brandId = BRAND) {
  const res = await request(app()).get(`/orgs/matrix/links?brandId=${brandId}`).set(headers);
  expect(res.status).toBe(200);
  return res.body.links.find((l: { channel: string }) => l.channel === "whatsapp");
}

/** Let the background driver pick up the next bridge answer. */
async function nextWait(): Promise<Deferred> {
  for (let i = 0; i < 200 && pendingWaits.length === 0; i++) await new Promise((r) => setTimeout(r, 5));
  const w = pendingWaits.shift();
  if (!w) throw new Error("driver never asked the bridge for the next step");
  return w;
}

async function settle() {
  await new Promise((r) => setTimeout(r, 50));
}

describe.skipIf(!RUN)("self-serve Matrix linking", () => {
  beforeEach(async () => {
    installFetchStub();
    await db.execute(sql`DELETE FROM matrix_links WHERE org_id = ${ORG}`);
    await db.execute(sql`DELETE FROM contacts WHERE org_id = ${ORG}`);
    await db.execute(sql`DELETE FROM matrix_connections WHERE org_id = ${ORG}`);
  });

  it("answers Telegram with a legible 'not available yet', never a 500", async () => {
    const res = await request(app())
      .post("/orgs/matrix/links")
      .set(headers)
      .send({ brandId: BRAND, channel: "telegram", method: "qr" });
    expect(res.status).toBe(409);
    expect(res.body).toEqual({
      type: "channel_unavailable",
      channel: "telegram",
      error: "Linking Telegram is not available yet.",
    });
    const links = (await request(app()).get(`/orgs/matrix/links?brandId=${BRAND}`).set(headers)).body.links;
    expect(links.find((l: { channel: string }) => l.channel === "telegram")).toMatchObject({
      available: false,
      status: "not_linked",
      methods: [],
    });
  });

  it("QR: start → code → refreshed code → linked, with a connection on the account's own token", async () => {
    const res = await request(app())
      .post("/orgs/matrix/links")
      .set(headers)
      .send({ brandId: BRAND, channel: "whatsapp", method: "qr" });
    expect(res.status).toBe(200);
    expect(res.body.link.status).toBe("waiting");
    expect(res.body.link.qr.data).toBe("2@first-qr");
    expect(res.body.link.qr.imageDataUrl).toMatch(/^data:image\/png;base64,/);
    expect(registered).toHaveLength(1);
    expect(registered[0]).toMatch(/^@crm_[0-9a-f]{16}:matrix\.test$/);
    // Every bridge call acts as the brand's dedicated account.
    expect(bridgeCalls.every((c) => c.userId === registered[0])).toBe(true);

    // WhatsApp refreshes the QR: the next poll shows the new one.
    (await nextWait()).resolve(json(qrStep("proc-1", "2@second-qr")));
    await settle();
    expect((await poll()).qr.data).toBe("2@second-qr");

    // The phone scans it.
    (await nextWait()).resolve(
      json({
        login_id: "proc-1",
        type: "complete",
        step_id: "fi.mau.whatsapp.login.complete",
        instructions: "Successfully logged in as +33 6 12 34 56 78",
        complete: { user_login_id: "33612345678" },
      }),
    );
    await settle();
    const linked = await poll();
    expect(linked).toMatchObject({
      status: "linked",
      qr: null,
      pairingCode: null,
      account: { id: "33612345678", name: "+33 6 12 34 56 78" },
      bridgeState: { state: "CONNECTED" },
      error: null,
    });

    const [conn] = await db
      .select()
      .from(matrixConnections)
      .where(and(eq(matrixConnections.orgId, ORG), eq(matrixConnections.brandId, BRAND)));
    expect(conn).toMatchObject({
      channel: "whatsapp",
      matrixUserId: registered[0],
      counterpartPrefix: "@whatsapp_",
      createdByUserId: USER,
      status: "active",
    });
    expect(conn.accessToken).toBe(`tok-${registered[0].slice(1).split(":")[0]}`);
    expect(linked.connection.id).toBe(conn.id);
    // The first sync ran as the brand's own account, not the platform one.
    expect(syncAuth).toContain(`Bearer ${conn.accessToken}`);
  });

  it("phone: answers the 8-character pairing code", async () => {
    const res = await request(app())
      .post("/orgs/matrix/links")
      .set(headers)
      .send({ brandId: BRAND, channel: "whatsapp", method: "phone", phoneNumber: "+33612345678" });
    expect(res.status).toBe(200);
    expect(res.body.link).toMatchObject({ status: "waiting", method: "phone", pairingCode: "ABCD-EFGH", qr: null });
    const submit = bridgeCalls.find((c) => c.path.endsWith("/user_input"));
    expect(submit?.body).toEqual({ phone_number: "+33612345678" });
  });

  it("a bridge refusal is answered and recorded in the bridge's own words", async () => {
    const res = await request(app())
      .post("/orgs/matrix/links")
      .set(headers)
      .send({ brandId: BRAND, channel: "whatsapp", method: "phone", phoneNumber: "+12" });
    expect(res.status).toBe(422);
    expect(res.body.bridgeError).toEqual({
      code: "FI.MAU.WHATSAPP.PHONE_NUMBER_TOO_SHORT",
      message: "Phone number too short",
    });
    expect((await poll()).error).toEqual({
      code: "FI.MAU.WHATSAPP.PHONE_NUMBER_TOO_SHORT",
      message: "Phone number too short",
    });
  });

  it("each brand gets its own Matrix account", async () => {
    await request(app()).post("/orgs/matrix/links").set(headers).send({ brandId: BRAND, channel: "whatsapp", method: "qr" });
    await request(app()).post("/orgs/matrix/links").set(headers).send({ brandId: BRAND_2, channel: "whatsapp", method: "qr" });
    expect(new Set(registered).size).toBe(2);
    const users = new Set(bridgeCalls.filter((c) => c.path.startsWith("/login/start")).map((c) => c.userId));
    expect(users.size).toBe(2);
    await db.execute(sql`DELETE FROM matrix_links WHERE org_id = ${ORG}`);
  });

  it("a waiting link whose driver died with the process reads as failed, not waiting", async () => {
    await db.insert(matrixLinks).values({
      orgId: ORG,
      brandId: BRAND,
      channel: "whatsapp",
      createdByUserId: USER,
      matrixUserId: "@crm_dead:matrix.test",
      status: "waiting",
      method: "qr",
      bridgeProcessId: "proc-from-a-previous-boot",
      displayType: "qr",
      displayData: "2@stale",
    });
    const view = await poll();
    expect(view.status).toBe("failed");
    expect(view.qr).toBeNull();
    expect(view.error.code).toBe("INTERRUPTED");
  });

  it("unlink: bridge logout, token revoked, mirror and Matrix contacts deleted", async () => {
    await request(app()).post("/orgs/matrix/links").set(headers).send({ brandId: BRAND, channel: "whatsapp", method: "qr" });
    (await nextWait()).resolve(
      json({ login_id: "x", type: "complete", step_id: "c", complete: { user_login_id: "33612345678" } }),
    );
    await settle();
    // The step answered for a different process id: the driver must not finalize someone else's login.
    expect((await poll()).status).not.toBe("linked");

    await db.execute(sql`DELETE FROM matrix_links WHERE org_id = ${ORG}`);
    await request(app()).post("/orgs/matrix/links").set(headers).send({ brandId: BRAND, channel: "whatsapp", method: "qr" });
    const proc = `proc-${processSeq}`;
    (await nextWait()).resolve(
      json({ login_id: proc, type: "complete", step_id: "c", complete: { user_login_id: "33612345678" } }),
    );
    await settle();
    const linked = await poll();
    expect(linked.status).toBe("linked");
    const connId = linked.connection.id;

    // Something was mirrored for the connection.
    const [c] = await db
      .insert(contacts)
      .values({
        orgId: ORG,
        brandId: BRAND,
        source: "matrix",
        channel: "whatsapp",
        channelHandle: "@whatsapp_33600000000:matrix.test",
        sourceConnectionId: connId,
        rawAttributes: {},
      })
      .returning();
    await db.insert(conversations).values({
      orgId: ORG,
      brandId: BRAND,
      connectionId: connId,
      contactId: c.id,
      channel: "whatsapp",
      roomId: "!r:matrix.test",
      firstMessageAt: new Date(),
      lastMessageAt: new Date(),
      messageCount: 1,
      inboundCount: 1,
      outboundCount: 0,
      lastEventId: "$e",
    });
    await db.insert(matrixRawEvents).values({
      orgId: ORG,
      brandId: BRAND,
      connectionId: connId,
      eventId: `$e-${Date.now()}`,
      roomId: "!r:matrix.test",
      sender: "@whatsapp_33600000000:matrix.test",
      eventType: "m.room.message",
      originServerTs: new Date(),
      payload: {},
    });

    const res = await request(app()).delete(`/orgs/matrix/links/whatsapp?brandId=${BRAND}`).set(headers);
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ unlinked: true, contactsRemoved: 1, connectionRemoved: true });
    expect(res.body.link.status).toBe("not_linked");
    expect(bridgeCalls.some((b) => b.path === "/logout/all")).toBe(true);
    expect(logouts).toHaveLength(1);
    expect(await db.select().from(matrixConnections).where(eq(matrixConnections.id, connId))).toHaveLength(0);
    expect(await db.select().from(matrixRawEvents).where(eq(matrixRawEvents.connectionId, connId))).toHaveLength(0);
    expect(await db.select().from(contacts).where(eq(contacts.sourceConnectionId, connId))).toHaveLength(0);

    // A second unlink has nothing to do.
    expect((await request(app()).delete(`/orgs/matrix/links/whatsapp?brandId=${BRAND}`).set(headers)).status).toBe(404);
  });
});
