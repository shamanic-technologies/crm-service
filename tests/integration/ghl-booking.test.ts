import { describe, it, expect, beforeAll, beforeEach, afterAll, vi } from "vitest";
import express from "express";
import request from "supertest";
import { eq, sql } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { ghlBookings, ghlConnections } from "../../src/db/schema.js";
import { runSyncPass } from "../../src/lib/gohighlevel/sync.js";
import { readFunnelEvents } from "../../src/lib/gohighlevel/funnel-events.js";
import gohighlevelRoutes from "../../src/routes/gohighlevel.js";

/**
 * AUTO-BOOK-1103: booking a prospect on the brand's GoHighLevel calendar.
 * GoHighLevel, key-service and runs-service are stubbed at `fetch`: no real
 * calendar is ever touched by this suite.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "bdbdbdbd-1111-4111-8111-000000000001";
const BRAND = "bdbdbdbd-1111-4111-8111-000000000002";
const OTHER_BRAND = "bdbdbdbd-1111-4111-8111-000000000003";
const USER = "user-book-1";
const LOCATION = "LocBook0001";
const API_KEY = process.env.CRM_SERVICE_API_KEY || "test-crm-key";

const CALENDAR = {
  id: "calBook1",
  name: "Discovery call",
  locationId: LOCATION,
  widgetSlug: "discovery-30",
  slotDuration: 30,
  slotDurationUnit: "mins",
};
const SLOT = "2026-11-05T13:00:00-05:00";

interface Vendor {
  writeScope: boolean;
  freeSlots: string[];
  appointments: Record<string, unknown>[];
  /** Make the next appointment POST create the appointment then fail (lost answer). */
  loseNextAppointmentAnswer: boolean;
  upserts: number;
  appointmentPosts: number;
  contacts: Record<string, unknown>[];
}
let vendor: Vendor;

function json(body: unknown, status = 200) {
  return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
}

function installFetchStub() {
  vendor = {
    writeScope: true,
    freeSlots: ["2026-11-05T12:30:00-05:00", SLOT, "2026-11-05T13:30:00-05:00"],
    appointments: [],
    loseNextAppointmentAnswer: false,
    upserts: 0,
    appointmentPosts: 0,
    contacts: [],
  };
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    if (url.includes("/keys/brands/")) {
      return json({ brandId: BRAND, provider: "gohighlevel", key: "pit-token", keySource: "brand", userId: USER });
    }
    if (url.includes("/v1/runs") || url.includes("/v1/platform-runs")) {
      return json({ id: "run-stub-book", organizationId: ORG, userId: USER, status: "running" });
    }
    if (url.endsWith("/orgs/judgments")) {
      return json({ model: "jev", answers: {}, usage: { inputTokens: 0, outputTokens: 0 } });
    }
    if (!url.includes("services.leadconnectorhq.com")) throw new Error(`unexpected fetch: ${url}`);
    const u = new URL(url);
    const scopeRefusal = () => json({ statusCode: 401, message: "The token is not authorized for this scope." }, 401);

    if (method === "POST" && u.pathname === "/contacts/upsert") {
      if (!vendor.writeScope) return scopeRefusal();
      const body = JSON.parse(String(init?.body));
      if (!body.locationId) return json({ statusCode: 422, message: ["locationId must be a string"] }, 422);
      vendor.upserts += 1;
      let contact = vendor.contacts.find((c) => c.email === body.email);
      const created = !contact;
      if (!contact) {
        contact = { id: `ghlc-${vendor.contacts.length + 1}`, email: body.email, firstName: body.firstName, lastName: body.lastName, phone: body.phone };
        vendor.contacts.push(contact);
      }
      return json({ new: created, contact });
    }
    if (method === "POST" && u.pathname === "/calendars/events/appointments") {
      if (!vendor.writeScope) return scopeRefusal();
      const body = JSON.parse(String(init?.body));
      if (!body.calendarId) return json({ statusCode: 422, message: ["calendarId should not be empty"] }, 422);
      vendor.appointmentPosts += 1;
      const appt = {
        id: `appt-${vendor.appointmentPosts}`,
        calendarId: body.calendarId,
        locationId: body.locationId,
        contactId: body.contactId,
        startTime: body.startTime,
        endTime: body.endTime,
        appointmentStatus: "confirmed",
        title: "Discovery call",
        dateAdded: "2026-11-03T10:00:00.000Z",
        dateUpdated: "2026-11-03T10:00:00.000Z",
      };
      vendor.appointments.push(appt);
      vendor.freeSlots = vendor.freeSlots.filter((s) => Date.parse(s) !== Date.parse(body.startTime));
      if (vendor.loseNextAppointmentAnswer) {
        vendor.loseNextAppointmentAnswer = false;
        return json({ message: "Internal server error" }, 500);
      }
      return json(appt, 201);
    }
    if (u.pathname.endsWith("/free-slots")) {
      return json({ "2026-11-05": { slots: vendor.freeSlots }, traceId: "t" });
    }
    if (u.pathname === "/calendars/events") {
      const from = Number(u.searchParams.get("startTime"));
      const to = Number(u.searchParams.get("endTime"));
      return json({
        events: vendor.appointments.filter((a) => {
          const t = Date.parse(String(a.startTime));
          return t >= from && t <= to;
        }),
      });
    }
    if (u.pathname === "/calendars/") return json({ calendars: [CALENDAR] });
    if (u.pathname === "/contacts/") return json({ contacts: u.searchParams.get("startAfterId") ? [] : vendor.contacts, meta: {} });
    if (u.pathname === "/opportunities/pipelines") return json({ pipelines: [] });
    if (u.pathname === "/opportunities/search") return json({ opportunities: [] });
    if (u.pathname === "/forms/") return json({ forms: [], total: 0 });
    if (u.pathname === "/forms/submissions") return json({ submissions: [], meta: { nextPage: null } });
    if (u.pathname.includes("/customFields")) return json({ customFields: [] });
    throw new Error(`unexpected GoHighLevel call: ${method} ${url}`);
  });
}

function app() {
  const server = express();
  server.use(express.json());
  server.use(gohighlevelRoutes);
  return server;
}

async function wipe() {
  await db.execute(sql`DELETE FROM ghl_bookings WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM contacts WHERE org_id = ${ORG}`);
  await db.execute(sql`DELETE FROM ghl_connections WHERE org_id = ${ORG}`);
}

async function seedConnection(brandId = BRAND, status = "active") {
  const [row] = await db
    .insert(ghlConnections)
    .values({ orgId: ORG, brandId, locationId: LOCATION, createdByUserId: USER, status })
    .returning();
  return row;
}

function book(body: Record<string, unknown>) {
  return request(app())
    .post("/orgs/gohighlevel/bookings")
    .set("x-api-key", API_KEY)
    .set("x-org-id", ORG)
    .set("x-user-id", USER)
    .send({
      brandId: BRAND,
      idempotencyKey: "occ-1",
      bookingPageUrl: "https://link.example.com/widget/bookings/discovery-30",
      startTime: "2026-11-05T13:00:00-05:00",
      person: { email: "Prospect@Example.com", name: "Pat Prospect", phone: "+15551234567" },
      ...body,
    });
}

describe.skipIf(!RUN)("POST /orgs/gohighlevel/bookings (AUTO-BOOK-1103)", () => {
  beforeAll(() => {
    process.env.CRM_SERVICE_API_KEY = API_KEY;
  });
  beforeEach(async () => {
    installFetchStub();
    await wipe();
  });
  afterAll(async () => {
    await wipe();
    vi.unstubAllGlobals();
  });

  it("books the slot once; the same key answers the same booking, nothing new created", async () => {
    await seedConnection();
    const first = await book({});
    expect(first.status).toBe(200);
    expect(first.body).toMatchObject({
      status: "booked",
      duplicate: false,
      appointmentId: "appt-1",
      calendarId: "calBook1",
      calendarName: "Discovery call",
      locationId: LOCATION,
      contactId: "ghlc-1",
      startTime: SLOT,
      startTimeUtc: "2026-11-05T18:00:00.000Z",
      utcOffset: "-05:00",
    });
    expect(vendor.appointments[0]).toMatchObject({ endTime: "2026-11-05T18:30:00.000Z" });
    expect(vendor.contacts[0]).toMatchObject({ email: "Prospect@Example.com", firstName: "Pat", lastName: "Prospect", phone: "+15551234567" });

    const again = await book({});
    expect(again.status).toBe(200);
    expect(again.body).toMatchObject({ status: "booked", duplicate: true, appointmentId: "appt-1", bookingId: first.body.bookingId });
    expect(vendor.appointmentPosts).toBe(1);
    expect(vendor.upserts).toBe(1);

    const [conn] = await db.select().from(ghlConnections).where(eq(ghlConnections.brandId, BRAND));
    expect(conn.bookingAccess).toBe("granted");
  });

  it("a read-only connection answers no_write_access with GoHighLevel's words; nothing booked", async () => {
    await seedConnection();
    vendor.writeScope = false;
    const res = await book({});
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({
      type: "refused",
      code: "no_write_access",
      vendorStatus: 401,
      vendorError: "The token is not authorized for this scope.",
    });
    expect(vendor.appointmentPosts).toBe(0);
    const list = await request(app())
      .get(`/orgs/gohighlevel/connections?brandId=${BRAND}`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG);
    expect(list.body.connections[0].booking).toMatchObject({
      canBook: false,
      access: "missing",
      vendorError: "The token is not authorized for this scope.",
      requiredScopes: ["contacts.write", "calendars/events.write"],
    });
    // Same key again: the first answer, still nothing booked.
    const again = await book({});
    expect(again.status).toBe(422);
    expect(again.body).toMatchObject({ code: "no_write_access", duplicate: true });
  });

  it("a taken slot is slot_not_open with the open slots nearby; nothing written", async () => {
    await seedConnection();
    vendor.freeSlots = ["2026-11-05T13:30:00-05:00"];
    const res = await book({});
    expect(res.status).toBe(422);
    expect(res.body).toMatchObject({ code: "slot_not_open", openSlotsNearby: ["2026-11-05T13:30:00-05:00"] });
    expect(vendor.upserts).toBe(0);
    expect(vendor.appointmentPosts).toBe(0);
  });

  it("a booking page whose calendar is not of the brand's location is calendar_not_of_brand", async () => {
    await seedConnection();
    const byUrl = await book({ bookingPageUrl: "https://link.example.com/widget/booking/someoneElsesCal" });
    expect(byUrl.status).toBe(422);
    expect(byUrl.body).toMatchObject({ code: "calendar_not_of_brand" });
    const byId = await book({ idempotencyKey: "occ-2", calendarId: "someoneElsesCal" });
    expect(byId.body).toMatchObject({ code: "calendar_not_of_brand" });
    expect(vendor.upserts + vendor.appointmentPosts).toBe(0);
  });

  it("the calendar id in the page URL path resolves too", async () => {
    await seedConnection();
    const res = await book({ bookingPageUrl: "https://api.leadconnectorhq.com/widget/booking/calBook1" });
    expect(res.status).toBe(200);
    expect(res.body.calendarId).toBe("calBook1");
  });

  it("no connection / paused connection: each its named refusal", async () => {
    const none = await book({});
    expect(none.status).toBe(422);
    expect(none.body).toMatchObject({ code: "no_gohighlevel_connection" });
    await seedConnection(BRAND, "paused");
    const paused = await book({ idempotencyKey: "occ-paused" });
    expect(paused.body).toMatchObject({ code: "connection_paused" });
  });

  it("never books on another brand's location: the brand's own connection only", async () => {
    await seedConnection(OTHER_BRAND);
    const res = await book({});
    expect(res.body).toMatchObject({ code: "no_gohighlevel_connection" });
    expect(vendor.appointmentPosts).toBe(0);
  });

  it("a lost answer (5xx after GoHighLevel booked) fails; the retry adopts that booking, never books twice", async () => {
    await seedConnection();
    vendor.loseNextAppointmentAnswer = true;
    const first = await book({});
    expect(first.status).toBe(502);
    expect(first.body).toMatchObject({ code: "booking_failed", retryable: true });
    const retry = await book({});
    expect(retry.status).toBe(200);
    expect(retry.body).toMatchObject({ status: "booked", appointmentId: "appt-1", adoptedEarlierAttempt: true });
    expect(vendor.appointmentPosts).toBe(1);
    const rows = await db.select().from(ghlBookings).where(eq(ghlBookings.orgId, ORG));
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ status: "booked", attempts: 2 });
  });

  it("an invalid body is a 400 naming the field", async () => {
    await seedConnection();
    const res = await book({ startTime: "next wednesday" });
    expect(res.status).toBe(400);
    expect(res.body.error).toContain("startTime");
  });

  it("once synced, the booked appointment is a meeting_booked fact like a self-booked one", async () => {
    const conn = await seedConnection();
    const res = await book({});
    expect(res.status).toBe(200);
    await runSyncPass(conn.id);
    const events = await readFunnelEvents({ orgId: ORG, brandId: BRAND, limit: 10, offset: 0 });
    const prospect = events.contacts.find((c) => c.externalContactId === "ghlc-1");
    expect(prospect?.events.map((e) => [e.step, e.source, e.occurredAt])).toEqual([
      ["meeting_booked", "appointment", "2026-11-03T10:00:00.000Z"],
    ]);
  });

  it("connect probes whether the token can book (empty-body write, nothing created)", async () => {
    vendor.writeScope = false;
    const res = await request(app())
      .post("/orgs/gohighlevel/connections")
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", USER)
      .send({ brandId: BRAND, locationId: LOCATION });
    expect(res.status).toBe(200);
    expect(res.body.connection.booking).toMatchObject({ canBook: false, access: "missing" });

    vendor.writeScope = true;
    const recheck = await request(app())
      .post(`/orgs/gohighlevel/connections/${res.body.connection.id}/booking-access`)
      .set("x-api-key", API_KEY)
      .set("x-org-id", ORG)
      .set("x-user-id", USER);
    expect(recheck.body.connection.booking).toMatchObject({ canBook: true, access: "granted" });
    expect(vendor.upserts + vendor.appointmentPosts).toBe(0);
  });
});
