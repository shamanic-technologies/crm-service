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
process.env.MATRIX_LINKEDIN_PROVISIONING_URL = "http://li.test";
process.env.MATRIX_LINKEDIN_PROVISIONING_SECRET = SECRET;
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
/** The bridge login each Matrix account holds (whoami), by account. Absent = the default number. */
let logins: Record<string, { id: string; name: string; state: string }> = {};

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
  logins = {};
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
    if (url.host === "li.test") {
      // mautrix-linkedin: password flow = credentials form, then the code LinkedIn emails.
      const userId = url.searchParams.get("user_id")!;
      const path = url.pathname.replace("/_matrix/provision/v3", "");
      bridgeCalls.push({ path, userId, auth, body });
      if (auth !== `Bearer ${SECRET}`) return json({ errcode: "M_UNKNOWN_TOKEN", error: "Invalid auth token" }, 401);
      if (path === "/login/start/password") {
        return json({
          login_id: `li-${++processSeq}`,
          type: "user_input",
          step_id: "fi.mau.linkedin.login.credentials",
          instructions: "Enter your LinkedIn email or phone and password",
          user_input: {
            fields: [
              { type: "email", id: "identifier", name: "Email or phone" },
              { type: "password", id: "password", name: "Password" },
            ],
          },
        });
      }
      if (path.endsWith("/fi.mau.linkedin.login.credentials/user_input")) {
        if (body.password === "wrong") {
          return json({ errcode: "FI.MAU.LINKEDIN.BAD_CREDENTIALS", error: "Wrong email or password" }, 400);
        }
        return json({
          login_id: path.split("/")[3],
          type: "user_input",
          step_id: "fi.mau.linkedin.login.email_code",
          instructions: "LinkedIn emailed you a code",
          user_input: { fields: [{ type: "2fa_code", id: "code", name: "Code", pattern: "^[0-9]{6}$" }] },
        });
      }
      if (path.endsWith("/fi.mau.linkedin.login.email_code/user_input")) {
        return json({
          login_id: path.split("/")[3],
          type: "complete",
          step_id: "fi.mau.linkedin.login.complete",
          instructions: "Logged in as Jane Doe",
          complete: { user_login_id: "ACoAAjane" },
        });
      }
      if (path.startsWith("/login/cancel/")) return json({});
      if (path === "/logout/all") return json({});
      if (path === "/whoami") return json({ logins: [{ id: "ACoAAjane", name: "Jane Doe", state: { state_event: "CONNECTED" } }] });
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
        const l = logins[userId] ?? { id: "33612345678", name: "+33 6 12 34 56 78", state: "CONNECTED" };
        return json({ logins: [{ id: l.id, name: l.name, state: { state_event: l.state } }] });
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

  // ─── Several accounts per channel ─────────────────────────────────────────

  async function linkWhatsApp(remoteId: string) {
    const res = await request(app())
      .post("/orgs/matrix/links")
      .set(headers)
      .send({ brandId: BRAND, channel: "whatsapp", method: "qr" });
    expect(res.status).toBe(200);
    const link = res.body.link;
    expect(link.status).toBe("waiting");
    const account = registered[registered.length - 1];
    logins[account] = { id: remoteId, name: `+${remoteId}`, state: "CONNECTED" };
    (await nextWait()).resolve(
      json({ login_id: `proc-${processSeq}`, type: "complete", step_id: "c", complete: { user_login_id: remoteId } }),
    );
    for (let i = 0; i < 100; i++) {
      const [row] = await db.select().from(matrixLinks).where(eq(matrixLinks.id, link.linkId));
      if (row.status === "linked") break;
      await new Promise((r) => setTimeout(r, 10));
    }
    return { linkId: link.linkId as string, account };
  }

  async function accounts() {
    const res = await request(app()).get(`/orgs/matrix/links?brandId=${BRAND}`).set(headers);
    expect(res.status).toBe(200);
    return res.body.accounts.filter((a: { channel: string }) => a.channel === "whatsapp");
  }

  it("a second WhatsApp: a fresh QR on its own account, the first stays linked; unlink one leaves the other", async () => {
    const first = await linkWhatsApp("33611111111");

    // Starting again while one account is linked ADDS an account.
    const res = await request(app())
      .post("/orgs/matrix/links")
      .set(headers)
      .send({ brandId: BRAND, channel: "whatsapp", method: "qr" });
    expect(res.status).toBe(200);
    expect(res.body.link).toMatchObject({ status: "waiting", qr: { data: "2@first-qr" } });
    expect(res.body.link.linkId).not.toBe(first.linkId);
    expect(registered).toHaveLength(2);
    const during = await accounts();
    expect(during.map((a: { status: string }) => a.status).sort()).toEqual(["linked", "waiting"]);
    expect(during.find((a: { linkId: string }) => a.linkId === first.linkId)).toMatchObject({
      status: "linked",
      account: { id: "33611111111" },
      linkedAccounts: 1,
    });

    const secondAccount = registered[1];
    logins[secondAccount] = { id: "33622222222", name: "+33622222222", state: "CONNECTED" };
    (await nextWait()).resolve(
      json({ login_id: `proc-${processSeq}`, type: "complete", step_id: "c", complete: { user_login_id: "33622222222" } }),
    );
    await settle();
    const both = await accounts();
    expect(both).toHaveLength(2);
    expect(both.every((a: { status: string }) => a.status === "linked")).toBe(true);
    expect(both.map((a: { account: { id: string } }) => a.account.id).sort()).toEqual(["33611111111", "33622222222"]);
    expect(both[0].linkedAccounts).toBe(2);
    const conns = await db.select().from(matrixConnections).where(eq(matrixConnections.orgId, ORG));
    expect(new Set(conns.map((c) => c.matrixUserId))).toEqual(new Set(registered));

    // Which account to unlink is never guessed.
    const ambiguous = await request(app()).delete(`/orgs/matrix/links/whatsapp?brandId=${BRAND}`).set(headers);
    expect(ambiguous.status).toBe(409);
    expect(ambiguous.body.type).toBe("link_id_required");
    expect(ambiguous.body.linkIds).toHaveLength(2);

    const second = both.find((a: { account: { id: string } }) => a.account.id === "33622222222");
    const del = await request(app())
      .delete(`/orgs/matrix/links/whatsapp?brandId=${BRAND}&linkId=${second.linkId}`)
      .set(headers);
    expect(del.status).toBe(200);
    expect(del.body).toMatchObject({ unlinked: true, linkId: second.linkId, connectionRemoved: true });
    expect(bridgeCalls.filter((b) => b.path === "/logout/all").map((b) => b.userId)).toEqual([secondAccount]);
    const left = await accounts();
    expect(left).toHaveLength(1);
    expect(left[0]).toMatchObject({ linkId: first.linkId, status: "linked", account: { id: "33611111111" } });
    const connsLeft = await db.select().from(matrixConnections).where(eq(matrixConnections.orgId, ORG));
    expect(connsLeft.map((c) => c.matrixUserId)).toEqual([first.account]);
  });

  it("the same counterpart writing to two linked accounts is one contact per account", async () => {
    const a = await linkWhatsApp("33611111111");
    const b = await linkWhatsApp("33622222222");
    const conns = await db.select().from(matrixConnections).where(eq(matrixConnections.orgId, ORG));
    expect(conns).toHaveLength(2);
    for (const c of conns) {
      await db.insert(contacts).values({
        orgId: ORG,
        brandId: BRAND,
        source: "matrix",
        channel: "whatsapp",
        channelHandle: "@whatsapp_lid-1:matrix.test",
        sourceConnectionId: c.id,
        rawAttributes: {},
      });
    }
    expect(a.linkId).not.toBe(b.linkId);
    expect(await db.select().from(contacts).where(eq(contacts.orgId, ORG))).toHaveLength(2);
  });

  it("the same WhatsApp number linked twice is refused, the first link untouched", async () => {
    const first = await linkWhatsApp("33611111111");
    await request(app()).post("/orgs/matrix/links").set(headers).send({ brandId: BRAND, channel: "whatsapp", method: "qr" });
    (await nextWait()).resolve(
      json({ login_id: `proc-${processSeq}`, type: "complete", step_id: "c", complete: { user_login_id: "33611111111" } }),
    );
    await settle();
    const all = await accounts();
    expect(all.find((x: { linkId: string }) => x.linkId === first.linkId).status).toBe("linked");
    const dup = all.find((x: { linkId: string }) => x.linkId !== first.linkId);
    expect(dup).toMatchObject({ status: "failed", error: { code: "ACCOUNT_ALREADY_LINKED" } });
    expect(await db.select().from(matrixConnections).where(eq(matrixConnections.orgId, ORG))).toHaveLength(1);
  });

  it("an expired session says so, and relinking keeps the same account and mirror", async () => {
    const first = await linkWhatsApp("33611111111");
    logins[first.account] = { id: "33611111111", name: "+33611111111", state: "BAD_CREDENTIALS" };
    const [view] = await accounts();
    expect(view).toMatchObject({ status: "linked", needsRelink: true, bridgeState: { state: "BAD_CREDENTIALS" } });
    const [connBefore] = await db.select().from(matrixConnections).where(eq(matrixConnections.orgId, ORG));

    const res = await request(app())
      .post("/orgs/matrix/links")
      .set(headers)
      .send({ brandId: BRAND, channel: "whatsapp", method: "qr", linkId: first.linkId });
    expect(res.status).toBe(200);
    expect(res.body.link).toMatchObject({ linkId: first.linkId, status: "waiting" });
    expect(registered).toHaveLength(1);
    logins[first.account] = { id: "33611111111", name: "+33611111111", state: "CONNECTED" };
    (await nextWait()).resolve(
      json({ login_id: `proc-${processSeq}`, type: "complete", step_id: "c", complete: { user_login_id: "33611111111" } }),
    );
    await settle();
    const [after] = await accounts();
    expect(after).toMatchObject({ linkId: first.linkId, status: "linked", needsRelink: false });
    const [connAfter] = await db.select().from(matrixConnections).where(eq(matrixConnections.orgId, ORG));
    expect(connAfter.id).toBe(connBefore.id);
    expect(connAfter.accessToken).toBe(connBefore.accessToken);
  });

  // ─── LinkedIn ──────────────────────────────────────────────────────────────

  it("LinkedIn: password form, then the emailed code, then linked; methods say so", async () => {
    const tile = (await request(app()).get(`/orgs/matrix/links?brandId=${BRAND}`).set(headers)).body.links.find(
      (l: { channel: string }) => l.channel === "linkedin",
    );
    expect(tile).toMatchObject({ available: true, methods: ["password", "cookies"], status: "not_linked" });

    const start = await request(app())
      .post("/orgs/matrix/links")
      .set(headers)
      .send({ brandId: BRAND, channel: "linkedin", method: "password" });
    expect(start.status).toBe(200);
    const linkId = start.body.link.linkId;
    expect(start.body.link).toMatchObject({
      status: "waiting",
      qr: null,
      input: {
        type: "user_input",
        stepId: "fi.mau.linkedin.login.credentials",
        fields: [
          { id: "identifier", type: "email" },
          { id: "password", type: "password" },
        ],
      },
    });

    // A missing field is refused before the bridge sees anything.
    const missing = await request(app())
      .post("/orgs/matrix/links")
      .set(headers)
      .send({ brandId: BRAND, channel: "linkedin", linkId, input: { identifier: "jane@x.com" } });
    expect(missing.status).toBe(400);

    const creds = await request(app())
      .post("/orgs/matrix/links")
      .set(headers)
      .send({ brandId: BRAND, channel: "linkedin", linkId, input: { identifier: "jane@x.com", password: "s3cret" } });
    expect(creds.status).toBe(200);
    expect(creds.body.link.input).toMatchObject({ stepId: "fi.mau.linkedin.login.email_code", fields: [{ id: "code" }] });
    // What the user typed is relayed, never stored.
    const [row] = await db.select().from(matrixLinks).where(eq(matrixLinks.id, linkId));
    expect(JSON.stringify(row)).not.toContain("s3cret");

    // A second submit of an answered step cannot reach the bridge twice.
    const replay = await request(app())
      .post("/orgs/matrix/links")
      .set(headers)
      .send({ brandId: BRAND, channel: "linkedin", linkId, input: { identifier: "jane@x.com", password: "s3cret" } });
    expect(replay.status).toBe(400);

    const code = await request(app())
      .post("/orgs/matrix/links")
      .set(headers)
      .send({ brandId: BRAND, channel: "linkedin", linkId, input: { code: "123456" } });
    expect(code.status).toBe(200);
    await settle();
    expect(code.body.link).toMatchObject({
      status: "linked",
      input: null,
      account: { id: "ACoAAjane", name: "Jane Doe" },
      connection: { status: "active" },
    });
    const [conn] = await db.select().from(matrixConnections).where(eq(matrixConnections.orgId, ORG));
    expect(conn).toMatchObject({ channel: "linkedin", counterpartPrefix: "@linkedin_" });
  });

  it("LinkedIn: a refused password is answered in the bridge's words and the link reads failed", async () => {
    const start = await request(app())
      .post("/orgs/matrix/links")
      .set(headers)
      .send({ brandId: BRAND, channel: "linkedin", method: "password" });
    const linkId = start.body.link.linkId;
    const res = await request(app())
      .post("/orgs/matrix/links")
      .set(headers)
      .send({ brandId: BRAND, channel: "linkedin", linkId, input: { identifier: "jane@x.com", password: "wrong" } });
    expect(res.status).toBe(422);
    expect(res.body.bridgeError).toEqual({ code: "FI.MAU.LINKEDIN.BAD_CREDENTIALS", message: "Wrong email or password" });
    expect(res.body.link).toMatchObject({ linkId, status: "failed", input: null });
  });

  it("LinkedIn says 'not available yet' while its bridge is not configured", async () => {
    const url = process.env.MATRIX_LINKEDIN_PROVISIONING_URL;
    delete process.env.MATRIX_LINKEDIN_PROVISIONING_URL;
    try {
      const res = await request(app())
        .post("/orgs/matrix/links")
        .set(headers)
        .send({ brandId: BRAND, channel: "linkedin", method: "password" });
      expect(res.status).toBe(409);
      expect(res.body.error).toBe("Linking LinkedIn is not available yet.");
    } finally {
      process.env.MATRIX_LINKEDIN_PROVISIONING_URL = url;
    }
  });

  it("a method the channel does not offer is refused", async () => {
    const res = await request(app())
      .post("/orgs/matrix/links")
      .set(headers)
      .send({ brandId: BRAND, channel: "whatsapp", method: "password" });
    expect(res.status).toBe(400);
  });
});
