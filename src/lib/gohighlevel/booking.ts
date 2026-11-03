/**
 * Book a meeting for a prospect on the brand's GoHighLevel calendar, through
 * the brand's own connection (AUTO-BOOK-1103, owner 2026-11-03: the AI books
 * the slot the prospect accepted instead of sending them a link).
 *
 * Consumer: workflow-service's meeting-booking reply workflows, service key +
 * the run's identity headers. Generic: no brand, pipe or campaign is special.
 *
 * Order, one occurrence (idempotency key) at a time:
 *   1. claim the key (a booked / refused key answers its FIRST answer again);
 *   2. the brand's connection + credential (key-service, no fallback);
 *   3. the calendar: the one the booking page shows, and only if it is one of
 *      the connection's OWN location's calendars, read live from GoHighLevel;
 *   4. the slot: still in GoHighLevel's free slots for that calendar, else
 *      `slot_not_open` and nothing written;
 *   5. upsert the prospect's contact, create the appointment (booking-client.ts).
 * "booked" only once GoHighLevel answered the appointment with its id.
 *
 * A retry after a failure (or a claim stuck 2 min) first looks for the
 * appointment the earlier attempt may have created (same contact, same start)
 * and adopts it: a timeout after GoHighLevel's write never books twice.
 */
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { ghlBookings, ghlConnections } from "../../db/schema.js";
import { GoHighLevelError, listCalendars, type GhlCalendarRecord } from "./client.js";
import {
  createAppointment,
  isScopeRefusal,
  probeBookingAccess,
  readCalendarEvents,
  readFreeSlots,
  upsertContact,
  type BookingAccess,
} from "./booking-client.js";
import { CredentialError, resolveGhlToken } from "./credentials.js";

/** The Private Integration Token scopes each use needs (served on the connection). */
export const GHL_SCOPES = {
  mirror: [
    "contacts.readonly",
    "opportunities.readonly",
    "calendars.readonly",
    "calendars/events.readonly",
    "forms.readonly",
    "locations/customFields.readonly",
  ],
  booking: ["contacts.write", "calendars/events.write"],
} as const;

/** A claim older than this with no answer is a crashed attempt: retried. */
export const BOOKING_STALE_MS = 2 * 60_000;

/** Free slots read around the asked instant (GoHighLevel caps a read at 31 days). */
const SLOT_WINDOW_MS = 36 * 3_600_000;

/** How often the sync re-asks whether the connection can book. */
export const BOOKING_ACCESS_RECHECK_MS = 6 * 3_600_000;

export type RefusalCode =
  | "no_gohighlevel_connection"
  | "connection_paused"
  | "no_gohighlevel_credential"
  | "calendar_not_of_brand"
  | "slot_not_open"
  | "no_write_access"
  | "vendor_refused";

export interface BookingRequest {
  brandId: string;
  idempotencyKey: string;
  bookingPageUrl?: string;
  calendarId?: string;
  startTime: string;
  person: { email: string; phone?: string; name?: string; firstName?: string; lastName?: string };
}

export type BookingOutcome =
  | { kind: "booked"; answer: Record<string, unknown> }
  | { kind: "refused"; answer: Record<string, unknown> }
  | { kind: "in_progress"; answer: Record<string, unknown> }
  | { kind: "failed"; answer: Record<string, unknown> };

// ─── pure ────────────────────────────────────────────────────────────────────

/** Every token of a URL a calendar could be named by: path segments + query values. */
function urlTokens(url: string): string[] {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return [];
  }
  const tokens = parsed.pathname.split("/").filter(Boolean);
  for (const v of parsed.searchParams.values()) tokens.push(v);
  return tokens.map((t) => {
    try {
      return decodeURIComponent(t);
    } catch {
      return t;
    }
  });
}

/**
 * The calendar a booking page shows, among the location's OWN calendars.
 * A page names its calendar by id (`/widget/booking/<id>`) or by its widget
 * slug (`/widget/bookings/<slug>`). `calendarId` (read off the page by the
 * caller) wins when given; it must still be one of the location's calendars.
 */
export function resolveCalendar(
  calendars: GhlCalendarRecord[],
  args: { calendarId?: string; bookingPageUrl?: string },
): GhlCalendarRecord | null {
  if (args.calendarId) return calendars.find((c) => c.id === args.calendarId) ?? null;
  if (!args.bookingPageUrl) return null;
  const tokens = urlTokens(args.bookingPageUrl);
  const byId = calendars.find((c) => tokens.includes(c.id));
  if (byId) return byId;
  const slugs = (c: GhlCalendarRecord) =>
    [c.widgetSlug, c.slug].filter((s): s is string => typeof s === "string" && s.length > 0);
  const bySlug = calendars.filter((c) => slugs(c).some((s) => tokens.includes(s)));
  return bySlug.length === 1 ? bySlug[0] : null;
}

/** GoHighLevel's own slot string for the asked instant, or null when not open. */
export function matchOpenSlot(requested: string, slots: string[]): string | null {
  const at = Date.parse(requested);
  if (Number.isNaN(at)) return null;
  return slots.find((s) => Date.parse(s) === at) ?? null;
}

/** `-05:00` out of `2026-11-05T13:00:00-05:00`, `+00:00` for `Z`, else null. */
export function utcOffsetOf(iso: string): string | null {
  if (/Z$/i.test(iso)) return "+00:00";
  const m = /([+-]\d{2}:?\d{2})$/.exec(iso);
  return m ? m[1] : null;
}

/** The slot's end from the calendar's own slot duration; undefined when unstated. */
export function endTimeOf(slot: string, calendar: GhlCalendarRecord): string | undefined {
  const duration = Number(calendar.slotDuration);
  if (!Number.isFinite(duration) || duration <= 0) return undefined;
  const unit = String(calendar.slotDurationUnit ?? "mins");
  const minutes = unit.startsWith("hour") ? duration * 60 : unit.startsWith("min") ? duration : NaN;
  if (Number.isNaN(minutes)) return undefined;
  return new Date(Date.parse(slot) + minutes * 60_000).toISOString();
}

// ─── access state ────────────────────────────────────────────────────────────

export async function recordBookingAccess(
  connectionId: string,
  access: BookingAccess,
  vendorError: string | null,
): Promise<void> {
  await db
    .update(ghlConnections)
    .set({ bookingAccess: access, bookingAccessCheckedAt: new Date(), bookingAccessError: vendorError })
    .where(eq(ghlConnections.id, connectionId));
}

/**
 * Ask GoHighLevel whether the token can book and store the answer. A probe that
 * cannot reach GoHighLevel stores `unknown` with the reason, never a guess.
 */
export async function checkBookingAccess(connectionId: string, token: string): Promise<BookingAccess> {
  let access: BookingAccess;
  let vendorError: string | null;
  try {
    ({ access, vendorError } = await probeBookingAccess(token));
  } catch (err) {
    access = "unknown";
    vendorError = (err as Error).message;
  }
  if (access === "unknown") {
    console.warn(`[crm-service][ghl] booking access unknown for connection ${connectionId}: ${vendorError}`);
  }
  await recordBookingAccess(connectionId, access, vendorError);
  return access;
}

/** The connection's booking state as served to the dashboard. */
export function bookingView(row: typeof ghlConnections.$inferSelect) {
  return {
    canBook: row.bookingAccess === "granted" ? true : row.bookingAccess === "missing" ? false : null,
    access: row.bookingAccess ?? "unchecked",
    checkedAt: row.bookingAccessCheckedAt,
    vendorError: row.bookingAccessError,
    requiredScopes: [...GHL_SCOPES.booking],
  };
}

// ─── the booking ─────────────────────────────────────────────────────────────

type Row = typeof ghlBookings.$inferSelect;

class Refusal extends Error {
  constructor(
    readonly code: RefusalCode,
    message: string,
    readonly vendor?: { status: number; message: string },
    readonly extra: Record<string, unknown> = {},
  ) {
    super(message);
  }
}

/** A vendor error on a WRITE: scope = no_write_access, other 4xx = refused, 429 / 5xx = failure. */
function classifyWrite(err: unknown, step: string): never {
  if (isScopeRefusal(err)) {
    throw new Refusal(
      "no_write_access",
      `The brand's GoHighLevel connection cannot ${step}: ${err.vendorMessage}`,
      { status: err.status, message: err.vendorMessage },
    );
  }
  classifyRead(err, step);
}

function classifyRead(err: unknown, step: string): never {
  if (err instanceof GoHighLevelError && err.status >= 400 && err.status < 500 && err.status !== 429) {
    throw new Refusal("vendor_refused", `GoHighLevel refused to ${step}: ${err.vendorMessage}`, {
      status: err.status,
      message: err.vendorMessage,
    });
  }
  throw err;
}

function refusalAnswer(row: Row, r: Refusal): Record<string, unknown> {
  return {
    status: "refused",
    bookingId: row.id,
    code: r.code,
    error: r.message,
    vendorStatus: r.vendor?.status ?? null,
    vendorError: r.vendor?.message ?? null,
    ...r.extra,
  };
}

/** Claim the key. Returns the row to work on, or the stored outcome to replay. */
async function claim(
  orgId: string,
  runId: string | undefined,
  req: BookingRequest,
): Promise<{ row: Row; retry: boolean } | BookingOutcome> {
  const fullName =
    req.person.name ?? ([req.person.firstName, req.person.lastName].filter(Boolean).join(" ") || null);
  const [inserted] = await db
    .insert(ghlBookings)
    .values({
      orgId,
      brandId: req.brandId,
      idempotencyKey: req.idempotencyKey,
      bookingPageUrl: req.bookingPageUrl ?? null,
      calendarId: req.calendarId ?? null,
      requestedStart: req.startTime,
      email: req.person.email.trim().toLowerCase(),
      phone: req.person.phone ?? null,
      fullName,
      status: "booking",
      attempts: 1,
      runId: runId ?? null,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { row: inserted, retry: false };

  const [existing] = await db
    .select()
    .from(ghlBookings)
    .where(
      and(
        eq(ghlBookings.orgId, orgId),
        eq(ghlBookings.brandId, req.brandId),
        eq(ghlBookings.idempotencyKey, req.idempotencyKey),
      ),
    );
  if (existing.status === "booked" || existing.status === "refused") {
    const answer = { ...(existing.answer as Record<string, unknown>), duplicate: true };
    return { kind: existing.status, answer };
  }
  if (existing.status === "booking" && Date.now() - existing.updatedAt.getTime() < BOOKING_STALE_MS) {
    return {
      kind: "in_progress",
      answer: { status: "in_progress", bookingId: existing.id, error: "this booking is being made right now; ask again shortly" },
    };
  }
  // A failed attempt, or a claim whose process died: retried under the same key.
  const [row] = await db
    .update(ghlBookings)
    .set({ status: "booking", attempts: sql`${ghlBookings.attempts} + 1`, updatedAt: new Date(), runId: runId ?? existing.runId })
    .where(and(eq(ghlBookings.id, existing.id), eq(ghlBookings.status, existing.status)))
    .returning();
  if (!row) {
    return {
      kind: "in_progress",
      answer: { status: "in_progress", bookingId: existing.id, error: "this booking is being made right now; ask again shortly" },
    };
  }
  return { row, retry: true };
}

async function settle(rowId: string, set: Partial<typeof ghlBookings.$inferInsert>): Promise<void> {
  await db.update(ghlBookings).set({ ...set, updatedAt: new Date() }).where(eq(ghlBookings.id, rowId));
}

function splitName(p: BookingRequest["person"]): { firstName?: string; lastName?: string; name?: string } {
  if (p.firstName || p.lastName) return { firstName: p.firstName, lastName: p.lastName, name: p.name };
  if (!p.name) return {};
  const parts = p.name.trim().split(/\s+/);
  return { firstName: parts[0], lastName: parts.slice(1).join(" ") || undefined, name: p.name.trim() };
}

function bookedAnswer(
  row: Row,
  conn: { locationId: string },
  calendar: GhlCalendarRecord,
  contactId: string,
  slot: string,
  appointment: Record<string, unknown>,
  adopted: boolean,
): Record<string, unknown> {
  const start = typeof appointment.startTime === "string" ? appointment.startTime : slot;
  return {
    status: "booked",
    bookingId: row.id,
    duplicate: false,
    adoptedEarlierAttempt: adopted,
    appointmentId: appointment.id,
    appointmentStatus: appointment.appointmentStatus ?? appointment.status ?? null,
    calendarId: calendar.id,
    calendarName: calendar.name ?? null,
    locationId: conn.locationId,
    contactId,
    startTime: slot,
    startTimeUtc: new Date(Date.parse(start)).toISOString(),
    endTime: typeof appointment.endTime === "string" ? appointment.endTime : null,
    utcOffset: utcOffsetOf(slot),
  };
}

export async function bookMeeting(args: {
  orgId: string;
  userId?: string;
  runId?: string;
  request: BookingRequest;
}): Promise<BookingOutcome> {
  const { orgId, request: req } = args;
  const claimed = await claim(orgId, args.runId, req);
  if ("kind" in claimed) return claimed;
  const { row, retry } = claimed;

  let connectionId: string | null = null;
  try {
    const [conn] = await db
      .select()
      .from(ghlConnections)
      .where(and(eq(ghlConnections.orgId, orgId), eq(ghlConnections.brandId, req.brandId)));
    if (!conn) {
      throw new Refusal("no_gohighlevel_connection", "This brand has no GoHighLevel connection.");
    }
    connectionId = conn.id;
    if (conn.status === "paused") {
      throw new Refusal("connection_paused", "This brand's GoHighLevel connection is paused.");
    }
    await settle(row.id, { connectionId: conn.id, locationId: conn.locationId });

    let token: string;
    try {
      token = await resolveGhlToken(req.brandId, {
        orgId,
        userId: args.userId ?? conn.createdByUserId,
        runId: args.runId,
      });
    } catch (err) {
      if (err instanceof CredentialError && err.kind === "missing") {
        throw new Refusal("no_gohighlevel_credential", "No GoHighLevel credential is stored for this brand.");
      }
      throw err;
    }

    let calendars: GhlCalendarRecord[];
    try {
      calendars = await listCalendars(token, conn.locationId);
    } catch (err) {
      classifyRead(err, "list the location's calendars");
    }
    const calendar = resolveCalendar(calendars, { calendarId: req.calendarId, bookingPageUrl: req.bookingPageUrl });
    if (!calendar || (typeof calendar.locationId === "string" && calendar.locationId !== conn.locationId)) {
      throw new Refusal(
        "calendar_not_of_brand",
        "The booking page is not a calendar of this brand's GoHighLevel location.",
        undefined,
        { locationId: conn.locationId },
      );
    }
    await settle(row.id, { calendarId: calendar.id });

    const at = Date.parse(req.startTime);
    const names = splitName(req.person);
    const contactInput = { email: req.person.email.trim(), phone: req.person.phone, ...names };
    let contactId: string | null = row.ghlContactId;

    // A retry: the earlier attempt may have booked before it died. Same contact,
    // same start on this calendar = that booking, adopted.
    if (retry) {
      if (!contactId) {
        try {
          contactId = (await upsertContact(token, conn.locationId, contactInput)).contactId;
        } catch (err) {
          classifyWrite(err, "create or match the prospect's contact");
        }
        await settle(row.id, { ghlContactId: contactId });
      }
      let events: Record<string, unknown>[];
      try {
        events = await readCalendarEvents(token, conn.locationId, calendar.id, at - 60_000, at + 60_000);
      } catch (err) {
        classifyRead(err, "read the calendar's appointments");
      }
      const earlier = events.find(
        (e) =>
          e.contactId === contactId &&
          typeof e.startTime === "string" &&
          Date.parse(e.startTime) === at &&
          !["cancelled", "invalid"].includes(String(e.appointmentStatus ?? e.status ?? "")),
      );
      if (earlier) {
        const slot = String(earlier.startTime);
        const answer = bookedAnswer(row, conn, calendar, contactId!, slot, earlier, true);
        await settle(row.id, { status: "booked", appointmentId: String(earlier.id), answer, code: null, error: null });
        await recordBookingAccess(conn.id, "granted", null);
        return { kind: "booked", answer };
      }
    }

    let slots: string[];
    try {
      slots = await readFreeSlots(token, calendar.id, at - SLOT_WINDOW_MS, at + SLOT_WINDOW_MS);
    } catch (err) {
      classifyRead(err, "read the calendar's open slots");
    }
    const slot = matchOpenSlot(req.startTime, slots);
    if (!slot) {
      throw new Refusal(
        "slot_not_open",
        `${req.startTime} is not an open slot of the calendar "${calendar.name ?? calendar.id}" anymore.`,
        undefined,
        { openSlotsNearby: slots.slice(0, 40) },
      );
    }

    if (!contactId) {
      try {
        contactId = (await upsertContact(token, conn.locationId, contactInput)).contactId;
      } catch (err) {
        classifyWrite(err, "create or match the prospect's contact");
      }
      await settle(row.id, { ghlContactId: contactId });
    }

    let appointment: Record<string, unknown>;
    try {
      appointment = await createAppointment(token, {
        locationId: conn.locationId,
        calendarId: calendar.id,
        contactId: contactId!,
        startTime: slot,
        endTime: endTimeOf(slot, calendar),
      });
    } catch (err) {
      classifyWrite(err, "book the appointment");
    }
    if (typeof appointment.id !== "string" || !appointment.id) {
      throw new Error("GoHighLevel answered the appointment without an id: not confirmed");
    }

    const answer = bookedAnswer(row, conn, calendar, contactId!, slot, appointment, false);
    await settle(row.id, { status: "booked", appointmentId: appointment.id, answer, code: null, error: null });
    await recordBookingAccess(conn.id, "granted", null);
    return { kind: "booked", answer };
  } catch (err) {
    if (err instanceof Refusal) {
      const answer = refusalAnswer(row, err);
      await settle(row.id, {
        status: "refused",
        code: err.code,
        error: err.message,
        vendorStatus: err.vendor?.status ?? null,
        vendorError: err.vendor?.message ?? null,
        answer,
      });
      if (err.code === "no_write_access" && connectionId) {
        await recordBookingAccess(connectionId, "missing", err.vendor?.message ?? null);
      }
      return { kind: "refused", answer };
    }
    const message = (err as Error).message;
    console.error(`[crm-service][ghl] booking ${row.id} failed:`, err);
    await settle(row.id, { status: "failed", error: message });
    return {
      kind: "failed",
      answer: { status: "failed", bookingId: row.id, error: message, retryable: true },
    };
  }
}
