import { describe, it, expect, beforeAll, beforeEach, vi } from "vitest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import {
  contacts,
  conversations,
  matrixConnections,
  matrixLeads,
  matrixRawEvents,
} from "../../src/db/schema.js";
import { runSyncPass, rebuildFromBronze } from "../../src/lib/matrix/sync.js";
import { serveNext } from "../../src/lib/serve.js";
import type { MatrixEvent, MatrixSyncResponse } from "../../src/lib/matrix/client.js";

/**
 * DB-backed Matrix ingestion tests. Gated on CRM_TEST_DB so a mock
 * CRM_SERVICE_DATABASE_URL skips them. Run against a real database:
 *   CRM_SERVICE_DATABASE_URL=<url> CRM_TEST_DB=1 pnpm vitest run tests/integration/matrix-sync.test.ts
 *
 * The homeserver, runs-service and chat-service are all stubbed at `fetch`, so
 * the test exercises the real bronze → silver → gold pipeline end to end.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "aaaaaaaa-0000-0000-0000-000000000001";
const BRAND = "aaaaaaaa-0000-0000-0000-000000000002";
const CSV_UPLOAD = "aaaaaaaa-0000-0000-0000-000000000003";
const OWN = "@kevin:hs.example";
const PREFIX = "@whatsapp_";
const GHOST = "@whatsapp_33612345678:hs.example";
const ROOM = "!room1:hs.example";
const FLOOR = "2026-08-01";

function message(id: string, sender: string, iso: string, body: string): MatrixEvent {
  return {
    event_id: id,
    type: "m.room.message",
    sender,
    origin_server_ts: Date.parse(iso),
    content: { msgtype: "m.text", body },
  };
}

function member(mxid: string, iso: string, displayname?: string): MatrixEvent {
  return {
    event_id: `$member-${mxid}`,
    type: "m.room.member",
    sender: mxid,
    origin_server_ts: Date.parse(iso),
    state_key: mxid,
    content: { membership: "join", ...(displayname ? { displayname } : {}) },
  };
}

function page(nextBatch: string, timeline: MatrixEvent[]): MatrixSyncResponse {
  return {
    next_batch: nextBatch,
    rooms: {
      join: {
        [ROOM]: {
          state: {
            events: [member(OWN, "2026-08-01T00:00:00Z"), member(GHOST, "2026-08-01T00:00:00Z", "Alice Martin")],
          },
          timeline: { events: timeline },
        },
      },
    },
  };
}

/** A page with no rooms — the homeserver has nothing more for us. */
function emptyPage(nextBatch: string): MatrixSyncResponse {
  return { next_batch: nextBatch, rooms: { join: {} } };
}

let syncPages: MatrixSyncResponse[] = [];
let chatCalls = 0;
let chatReply = {
  status: "qualifying",
  nextStep: "Send June availability",
  estimatedValueUsd: 2500,
  summary: "Alice asked about a June wedding.",
};

function installFetchStub() {
  vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
    const url = String(input);
    if (url.includes("/_matrix/client/v3/sync")) {
      const next = syncPages.shift() ?? emptyPage("s-end");
      return new Response(JSON.stringify(next), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    }
    if (url.includes("/complete")) {
      chatCalls += 1;
      return new Response(
        JSON.stringify({
          content: JSON.stringify(chatReply),
          json: chatReply,
          tokensInput: 10,
          tokensOutput: 10,
          model: "stub-model-1",
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    if (url.includes("/v1/runs")) {
      return new Response(
        JSON.stringify({
          id: "run-stub-1",
          parentRunId: null,
          organizationId: ORG,
          userId: "user-1",
          serviceName: "crm-service",
          taskName: "matrix.sync",
          status: "running",
          startedAt: new Date().toISOString(),
          completedAt: null,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      );
    }
    throw new Error(`unexpected fetch in test: ${url}`);
  });
}

async function wipe() {
  await db.delete(matrixLeads);
  await db.delete(conversations);
  await db.delete(matrixRawEvents);
  await db.delete(matrixConnections);
  await db.execute(sql`DELETE FROM contact_serves`);
  await db.delete(contacts);
}

async function seedConnection(): Promise<string> {
  const [row] = await db
    .insert(matrixConnections)
    .values({
      orgId: ORG,
      brandId: BRAND,
      channel: "whatsapp",
      matrixUserId: OWN,
      counterpartPrefix: PREFIX,
      createdByUserId: "user-1",
      status: "active",
    })
    .returning({ id: matrixConnections.id });
  return row.id;
}

/** A pre-existing CSV contact — must stay sendable, unchanged, forever. */
async function seedCsvContact(email: string) {
  await db.insert(contacts).values({
    orgId: ORG,
    brandId: BRAND,
    primaryEmail: email,
    phoneE164: null,
    fullName: "Csv Person",
    firstName: "Csv",
    lastName: "Person",
    rawAttributes: {},
    consentStatus: "unknown",
    unsubscribed: false,
    sourceUploadId: CSV_UPLOAD,
    sourceRowId: sql`gen_random_uuid()` as unknown as string,
  });
}

describe.skipIf(!RUN)("matrix ingestion", () => {
  beforeAll(() => {
    process.env.MATRIX_HOMESERVER_URL = "http://homeserver.test";
    process.env.MATRIX_ACCESS_TOKEN = "test-token";
    process.env.MATRIX_INGESTION_FLOOR = FLOOR;
    process.env.CRM_LEAD_READING_CHAT_CONFIG = "anthropic/haiku";
    installFetchStub();
  });

  beforeEach(async () => {
    await wipe();
    chatCalls = 0;
    syncPages = [];
  });

  it("ingests only events at or after the floor, and is idempotent", async () => {
    const connectionId = await seedConnection();
    const timeline = [
      message("$old", GHOST, "2026-07-15T10:00:00Z", "message from before the floor"),
      message("$m1", GHOST, "2026-08-02T10:00:00Z", "hi, do you do weddings?"),
      message("$m2", OWN, "2026-08-02T11:00:00Z", "yes! which month?"),
    ];
    syncPages = [page("s2", timeline), emptyPage("s3")];

    await runSyncPass(connectionId);

    const raw = await db
      .select()
      .from(matrixRawEvents)
      .where(eq(matrixRawEvents.connectionId, connectionId));
    const ids = raw.map((r) => r.eventId);
    expect(ids).not.toContain("$old"); // floor — never mirrored into bronze
    expect(ids).toContain("$m1");
    expect(ids).toContain("$m2");

    const [conn] = await db
      .select()
      .from(matrixConnections)
      .where(eq(matrixConnections.id, connectionId));
    expect(conn.sinceToken).toBe("s3"); // cursor advanced
    expect(conn.status).toBe("active");
    expect(conn.lastSyncedAt).not.toBeNull();

    // Re-running the SAME batch inserts nothing new (event_id is the key).
    const countBefore = raw.length;
    syncPages = [page("s3", timeline), emptyPage("s4")];
    await runSyncPass(connectionId);
    const rawAfter = await db
      .select()
      .from(matrixRawEvents)
      .where(eq(matrixRawEvents.connectionId, connectionId));
    expect(rawAfter.length).toBe(countBefore);
  });

  it("produces exactly one contact and one conversation with correct counts, no LLM in that path", async () => {
    const connectionId = await seedConnection();
    syncPages = [
      page("s2", [
        message("$m1", GHOST, "2026-08-02T10:00:00Z", "hi, do you do weddings?"),
        message("$m2", GHOST, "2026-08-02T10:05:00Z", "for june"),
        message("$m3", OWN, "2026-08-02T11:00:00Z", "yes, june works"),
      ]),
      emptyPage("s3"),
    ];

    await runSyncPass(connectionId);

    const contactRows = await db.select().from(contacts).where(eq(contacts.orgId, ORG));
    expect(contactRows).toHaveLength(1);
    expect(contactRows[0].source).toBe("matrix");
    expect(contactRows[0].channel).toBe("whatsapp");
    expect(contactRows[0].channelHandle).toBe(GHOST);
    expect(contactRows[0].primaryEmail).toBeNull();
    expect(contactRows[0].phoneE164).toBe("+33612345678");
    expect(contactRows[0].fullName).toBe("Alice Martin");

    const convRows = await db.select().from(conversations).where(eq(conversations.orgId, ORG));
    expect(convRows).toHaveLength(1);
    expect(convRows[0].messageCount).toBe(3);
    expect(convRows[0].inboundCount).toBe(2);
    expect(convRows[0].outboundCount).toBe(1);
    expect(convRows[0].lastEventId).toBe("$m3");

    // Exactly ONE chat-service call happened, and it was for the gold layer —
    // silver (contact + conversation) is deterministic.
    expect(chatCalls).toBe(1);
  });

  it("computes a lead and recomputes it ONLY when the conversation advanced", async () => {
    const connectionId = await seedConnection();
    syncPages = [
      page("s2", [message("$m1", GHOST, "2026-08-02T10:00:00Z", "hi")]),
      emptyPage("s3"),
    ];
    await runSyncPass(connectionId);
    expect(chatCalls).toBe(1);

    const [lead] = await db.select().from(matrixLeads);
    expect(lead.status).toBe("qualifying");
    expect(lead.nextStep).toBe("Send June availability");
    expect(lead.summary).toBe(chatReply.summary);
    expect(lead.estimatedValueUsd).toBe(2500);
    expect(lead.model).toBe("stub-model-1");
    expect(lead.computedThroughEventId).toBe("$m1");

    // Same thread, nothing new → the watermark matches → zero LLM spend.
    syncPages = [page("s3", []), emptyPage("s4")];
    await runSyncPass(connectionId);
    expect(chatCalls).toBe(1);

    // A new message moves the watermark → exactly one recompute.
    syncPages = [
      page("s4", [message("$m2", GHOST, "2026-08-03T09:00:00Z", "still interested")]),
      emptyPage("s5"),
    ];
    await runSyncPass(connectionId);
    expect(chatCalls).toBe(2);
    const [updated] = await db.select().from(matrixLeads);
    expect(updated.computedThroughEventId).toBe("$m2");
    const leadRows = await db.select().from(matrixLeads);
    expect(leadRows).toHaveLength(1);
  });

  it("NEVER exposes a Matrix contact to sendable_contacts / serve-next, and keeps CSV contacts sendable", async () => {
    const connectionId = await seedConnection();
    await seedCsvContact("csv-person@example.com");
    syncPages = [
      page("s2", [message("$m1", GHOST, "2026-08-02T10:00:00Z", "hi")]),
      emptyPage("s3"),
    ];
    await runSyncPass(connectionId);

    const sendable = (await db.execute(sql`
      SELECT primary_email, source FROM sendable_contacts WHERE org_id = ${ORG}
    `)) as unknown as { primary_email: string | null; source: string }[];
    expect(sendable).toHaveLength(1);
    expect(sendable[0].primary_email).toBe("csv-person@example.com");
    expect(sendable[0].source).toBe("csv");

    const served = await serveNext(ORG, BRAND, 100, "run-serve-1");
    expect(served.contacts.map((c) => c.primaryEmail)).toEqual(["csv-person@example.com"]);
    expect(served.exhausted).toBe(true);
  });

  it("still resolves a room whose membership predates the floor", async () => {
    const connectionId = await seedConnection();
    // A DM opened in 2019: its member events carry that old timestamp, but they
    // are identity, not content, so bronze keeps them and the room resolves.
    syncPages = [
      {
        next_batch: "s2",
        rooms: {
          join: {
            [ROOM]: {
              state: {
                events: [
                  member(OWN, "2019-03-01T00:00:00Z"),
                  member(GHOST, "2019-03-01T00:00:00Z", "Alice Martin"),
                ],
              },
              timeline: {
                events: [
                  message("$ancient", GHOST, "2019-04-01T10:00:00Z", "old chat"),
                  message("$m1", GHOST, "2026-08-02T10:00:00Z", "hi again"),
                ],
              },
            },
          },
        },
      },
      emptyPage("s3"),
    ];

    await runSyncPass(connectionId);

    const ids = (
      await db.select().from(matrixRawEvents).where(eq(matrixRawEvents.connectionId, connectionId))
    ).map((r) => r.eventId);
    expect(ids).not.toContain("$ancient"); // pre-floor MESSAGE: never mirrored
    expect(ids).toContain("$m1");

    const convRows = await db.select().from(conversations).where(eq(conversations.orgId, ORG));
    expect(convRows).toHaveLength(1);
    expect(convRows[0].messageCount).toBe(1);
    expect(convRows[0].inboundCount).toBe(1);
  });

  it("rebuilds the gold leads table from bronze after a truncate", async () => {
    const connectionId = await seedConnection();
    syncPages = [
      page("s2", [
        message("$m1", GHOST, "2026-08-02T10:00:00Z", "hi"),
        message("$m2", OWN, "2026-08-02T10:30:00Z", "hello!"),
      ]),
      emptyPage("s3"),
    ];
    await runSyncPass(connectionId);

    const [before] = await db.select().from(matrixLeads);
    expect(before).toBeDefined();

    // Truncate gold, then rebuild from bronze alone — no /sync involved.
    await db.delete(matrixLeads);
    expect(await db.select().from(matrixLeads)).toHaveLength(0);

    const [conn] = await db
      .select()
      .from(matrixConnections)
      .where(eq(matrixConnections.id, connectionId));
    const result = await rebuildFromBronze(conn);
    expect(result.leadsComputed).toBe(1);

    const [after] = await db.select().from(matrixLeads);
    expect(after.status).toBe(before.status);
    expect(after.nextStep).toBe(before.nextStep);
    expect(after.summary).toBe(before.summary);
    expect(after.estimatedValueUsd).toBe(before.estimatedValueUsd);
    expect(after.computedThroughEventId).toBe(before.computedThroughEventId);
    expect(after.conversationId).toBe(before.conversationId);
  });
});
