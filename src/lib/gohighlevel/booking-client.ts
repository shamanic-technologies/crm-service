/**
 * GoHighLevel WRITE calls: the ONLY ones in the fleet (AUTO-BOOK-1103).
 *
 * `client.ts` stays read-only. Booking a meeting for a prospect, on the brand's
 * own calendar, through the brand's own credential, is the one write the owner
 * asked for (2026-11-03: the public booking page refuses machines, 429 +
 * captcha, so the official API is the only path). This module may do exactly
 * two writes: upsert the prospect's contact and create the appointment. Only
 * `booking.ts` imports it (pinned by tests/unit/ghl-booking.test.ts). Do not
 * add another write here.
 *
 * A token without the write scopes answers GoHighLevel's 401 "The token is not
 * authorized for this scope." BEFORE it reads the body (measured 2026-11-03 on
 * a read-only token, `POST {}` on both routes): `probeBookingAccess` uses that
 * with an EMPTY body, which can never create anything.
 */
import {
  GHL_API_BASE_URL,
  GHL_API_VERSION,
  GHL_CALENDARS_API_VERSION,
  GoHighLevelError,
} from "./client.js";

const REQUEST_TIMEOUT_MS = Number(process.env.GOHIGHLEVEL_TIMEOUT_MS) || 20_000;

function readVendorMessage(body: string): string {
  try {
    const parsed = JSON.parse(body) as { message?: unknown; error?: unknown };
    const raw = parsed.message ?? parsed.error;
    if (Array.isArray(raw)) return raw.map(String).join("; ");
    if (typeof raw === "string" && raw.trim()) return raw;
  } catch {
    // Not JSON: the raw body is still the vendor's words.
  }
  return body.trim() || "(no message)";
}

async function ghlCall<T>(
  token: string,
  method: "GET" | "POST",
  path: string,
  version: string,
  opts: { params?: Record<string, string>; body?: unknown } = {},
): Promise<T> {
  const qs = opts.params ? `?${new URLSearchParams(opts.params).toString()}` : "";
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const res = await fetch(`${GHL_API_BASE_URL}${path}${qs}`, {
      method,
      headers: {
        Authorization: `Bearer ${token}`,
        Version: version,
        Accept: "application/json",
        ...(opts.body !== undefined ? { "Content-Type": "application/json" } : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      signal: controller.signal,
    });
    const text = await res.text();
    if (!res.ok) {
      throw new GoHighLevelError({ status: res.status, vendorMessage: readVendorMessage(text), path });
    }
    return (text ? JSON.parse(text) : {}) as T;
  } catch (err) {
    if (err instanceof Error && err.name === "AbortError") {
      throw new Error(`[crm-service][ghl] ${method} ${path} aborted after ${REQUEST_TIMEOUT_MS}ms`);
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

/** GoHighLevel's answer to a token lacking a scope (401 + this sentence). */
export function isScopeRefusal(err: unknown): err is GoHighLevelError {
  return (
    err instanceof GoHighLevelError &&
    (err.status === 401 || err.status === 403) &&
    /scope/i.test(err.vendorMessage)
  );
}

export type BookingAccess = "granted" | "missing" | "unknown";

export interface BookingAccessProbe {
  access: BookingAccess;
  /** GoHighLevel's own words for the route that decided it. */
  vendorError: string | null;
}

/**
 * Does the token hold the two write scopes booking needs? One EMPTY-body POST
 * per write route: GoHighLevel checks the scope first (401 scope = missing),
 * then refuses the empty body (400 / 422 = the scope passed). Nothing can be
 * created: no location, no calendar, no contact is named.
 */
export async function probeBookingAccess(token: string): Promise<BookingAccessProbe> {
  const routes: [string, string][] = [
    ["/contacts/upsert", GHL_API_VERSION],
    ["/calendars/events/appointments", GHL_CALENDARS_API_VERSION],
  ];
  let unknown: string | null = null;
  for (const [path, version] of routes) {
    try {
      await ghlCall(token, "POST", path, version, { body: {} });
      // An empty body accepted would be a vendor change: say we do not know.
      unknown = `${path} accepted an empty body`;
    } catch (err) {
      if (isScopeRefusal(err)) return { access: "missing", vendorError: err.vendorMessage };
      if (err instanceof GoHighLevelError && (err.status === 400 || err.status === 422)) continue;
      unknown = err instanceof GoHighLevelError ? `${path} ${err.status}: ${err.vendorMessage}` : (err as Error).message;
    }
  }
  return unknown ? { access: "unknown", vendorError: unknown } : { access: "granted", vendorError: null };
}

export interface GhlCalendarDetail {
  id: string;
  name?: string;
  locationId?: string;
  slotDuration?: number;
  slotDurationUnit?: string;
  [key: string]: unknown;
}

/**
 * The calendar's open slots between two instants, as GoHighLevel states them
 * (offset-qualified ISO strings in the calendar's own zone), keyed by day.
 */
export async function readFreeSlots(
  token: string,
  calendarId: string,
  fromMs: number,
  toMs: number,
): Promise<string[]> {
  const body = await ghlCall<Record<string, unknown>>(
    token,
    "GET",
    `/calendars/${encodeURIComponent(calendarId)}/free-slots`,
    GHL_CALENDARS_API_VERSION,
    { params: { startDate: String(fromMs), endDate: String(toMs) } },
  );
  const slots: string[] = [];
  for (const day of Object.values(body)) {
    const list = (day as { slots?: unknown })?.slots;
    if (Array.isArray(list)) for (const s of list) if (typeof s === "string") slots.push(s);
  }
  return slots;
}

/** The appointments of one calendar whose start falls in [fromMs, toMs]. */
export async function readCalendarEvents(
  token: string,
  locationId: string,
  calendarId: string,
  fromMs: number,
  toMs: number,
): Promise<Record<string, unknown>[]> {
  const body = await ghlCall<{ events?: Record<string, unknown>[] }>(
    token,
    "GET",
    "/calendars/events",
    GHL_CALENDARS_API_VERSION,
    { params: { locationId, calendarId, startTime: String(fromMs), endTime: String(toMs) } },
  );
  return (body.events ?? []).filter((e) => e && typeof e.id === "string");
}

export interface ContactInput {
  email: string;
  phone?: string;
  firstName?: string;
  lastName?: string;
  name?: string;
}

/**
 * WRITE 1/2: create or match the prospect's contact in the brand's location,
 * the way the booking page does (GoHighLevel matches on email / phone).
 */
export async function upsertContact(
  token: string,
  locationId: string,
  person: ContactInput,
): Promise<{ contactId: string; created: boolean }> {
  const body: Record<string, unknown> = { locationId, email: person.email };
  if (person.phone) body.phone = person.phone;
  if (person.firstName) body.firstName = person.firstName;
  if (person.lastName) body.lastName = person.lastName;
  if (person.name) body.name = person.name;
  const res = await ghlCall<{ new?: boolean; contact?: { id?: unknown } }>(
    token,
    "POST",
    "/contacts/upsert",
    GHL_API_VERSION,
    { body },
  );
  const id = res.contact?.id;
  if (typeof id !== "string" || !id) {
    throw new Error("[crm-service][ghl] contact upsert answered without a contact id");
  }
  return { contactId: id, created: res.new === true };
}

/**
 * WRITE 2/2: the appointment, on the slot GoHighLevel itself just served as
 * open. `ignoreFreeSlotValidation: false` makes GoHighLevel re-check the slot
 * (a race with a person booking the page is refused there, not double-booked);
 * `toNotify: true` sends the calendar's own confirmation / invite, as a page
 * booking does.
 */
export async function createAppointment(
  token: string,
  args: { locationId: string; calendarId: string; contactId: string; startTime: string; endTime?: string },
): Promise<Record<string, unknown>> {
  const body: Record<string, unknown> = {
    calendarId: args.calendarId,
    locationId: args.locationId,
    contactId: args.contactId,
    startTime: args.startTime,
    ignoreFreeSlotValidation: false,
    toNotify: true,
  };
  if (args.endTime) body.endTime = args.endTime;
  return ghlCall<Record<string, unknown>>(
    token,
    "POST",
    "/calendars/events/appointments",
    GHL_CALENDARS_API_VERSION,
    { body },
  );
}
