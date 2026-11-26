/**
 * THREAD-OF-EMAILED-PERSON-1126 — what a person read that finds nobody MEANS.
 *
 * `GET /orgs/people/timeline?personKey=email:x` answered one 404 for two different things:
 *  - the brand never wrote to / heard from this address (a writer writes a first email), and
 *  - the brand did, but the people index (rebuilt per scope, minutes apart) does not hold the
 *    person yet (a writer must NOT write a first email: it waits and reads again).
 * Measured 2026-11-26 (86 addresses refused in 36 h, 37 of them emailed by the same org): all 37
 * were emailed AFTER the refused read (the first email that writer itself wrote), so no follow-up
 * was lost; but the gap is real: dalaal@livespot360.com was emailed 11:47 and indexed 11:54, a read
 * in between would have been told "nobody" about a person we had just written to.
 *
 * So a not-found read is answered with positive evidence either way:
 *  - `not_known_yet`: the scope was never built, or a record of the brand names the key while the
 *    index does not (instantly-service holds an email of ours to the address for this brand, our
 *    message store holds a message with it, one of our WhatsApp sends went to the number), or a
 *    check could not be read (never a "none" from a failed read);
 *  - `none`: the scope is built and every check answered "nothing".
 */

import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { peopleMessageTexts, peopleMessageUnits, whatsappSends, type PeopleScope } from "../../db/schema.js";
import { siblingGet, type SiblingIdentity } from "./siblings.js";

export type ThreadAbsenceStatus = "none" | "not_known_yet";

export interface ThreadAbsenceCheck {
  check: "people_index" | "email_sent" | "message_store" | "whatsapp_sends";
  /** found = the brand holds something with this key; nothing = it does not; unreadable = could not tell. */
  answer: "found" | "nothing" | "unreadable" | "not_built";
  detail?: string;
}

export interface ThreadAbsence {
  status: ThreadAbsenceStatus;
  /** When to read again (not_known_yet only): the index is rebuilt within minutes. */
  retryAfterSeconds?: number;
  indexBuiltAt: string | null;
  checks: ThreadAbsenceCheck[];
}

export const THREAD_RETRY_AFTER_SECONDS = 120;

/** PURE: `none` only when the index is built and every check positively answered nothing. */
export function decideThreadAbsence(lastBuiltAt: Date | null, checks: ThreadAbsenceCheck[]): ThreadAbsence {
  const all: ThreadAbsenceCheck[] = [
    lastBuiltAt ? { check: "people_index", answer: "nothing" } : { check: "people_index", answer: "not_built" },
    ...checks,
  ];
  const none = all.every((c) => c.answer === "nothing");
  return {
    status: none ? "none" : "not_known_yet",
    ...(none ? {} : { retryAfterSeconds: THREAD_RETRY_AFTER_SECONDS }),
    indexBuiltAt: lastBuiltAt ? lastBuiltAt.toISOString() : null,
    checks: all,
  };
}

/** PURE: the address / number a person key names, or null (a `uid:` / record key: no record check). */
export function keyTarget(personKey: string): { kind: "email"; value: string } | { kind: "phone"; value: string } | null {
  if (personKey.startsWith("email:")) {
    const value = personKey.slice(6).trim().toLowerCase();
    return value.includes("@") ? { kind: "email", value } : null;
  }
  if (personKey.startsWith("phone:")) {
    const value = personKey.slice(6).trim();
    return /^\+\d{6,}$/.test(value) ? { kind: "phone", value } : null;
  }
  return null;
}

/** instantly-service: has this org sent this brand's email to the address (any campaign, ever)? Free read there. */
async function emailSentCheck(email: string, identity: SiblingIdentity): Promise<ThreadAbsenceCheck> {
  const q = new URLSearchParams({ emails: email, brandId: identity.brandId, limit: "1" });
  try {
    const r = await siblingGet("instantly", `/orgs/units/email-sent?${q}`, identity);
    if (r.status !== 200) return { check: "email_sent", answer: "unreadable", detail: `instantly-service answered ${r.status}` };
    const units = (r.body as { units?: unknown[] } | null)?.units;
    if (!Array.isArray(units)) return { check: "email_sent", answer: "unreadable", detail: "instantly-service answered no units list" };
    return { check: "email_sent", answer: units.length > 0 ? "found" : "nothing" };
  } catch (err) {
    return { check: "email_sent", answer: "unreadable", detail: String(err).slice(0, 200) };
  }
}

async function messageStoreCheck(scopeId: string, email: string): Promise<ThreadAbsenceCheck> {
  const [unit] = await db
    .select({ n: sql<number>`1` })
    .from(peopleMessageUnits)
    .where(and(eq(peopleMessageUnits.scopeId, scopeId), eq(peopleMessageUnits.address, email), sql`${peopleMessageUnits.messages} > 0`))
    .limit(1);
  if (unit) return { check: "message_store", answer: "found" };
  const [text] = await db
    .select({ n: sql<number>`1` })
    .from(peopleMessageTexts)
    .where(and(eq(peopleMessageTexts.scopeId, scopeId), eq(peopleMessageTexts.address, email)))
    .limit(1);
  return { check: "message_store", answer: text ? "found" : "nothing" };
}

async function whatsappSendsCheck(orgId: string, brandId: string, phone: string): Promise<ThreadAbsenceCheck> {
  const [row] = await db
    .select({ n: sql<number>`1` })
    .from(whatsappSends)
    .where(and(eq(whatsappSends.orgId, orgId), eq(whatsappSends.brandId, brandId), eq(whatsappSends.phone, phone), eq(whatsappSends.status, "sent")))
    .limit(1);
  return { check: "whatsapp_sends", answer: row ? "found" : "nothing" };
}

/** What a not-found person key means for this brand: `none` (write a first message) or `not_known_yet` (read again later). */
export async function threadAbsence(scope: PeopleScope, personKey: string, identity: SiblingIdentity): Promise<ThreadAbsence> {
  const target = keyTarget(personKey);
  const checks: ThreadAbsenceCheck[] = [];
  if (target?.kind === "email") {
    checks.push(...(await Promise.all([emailSentCheck(target.value, identity), messageStoreCheck(scope.id, target.value)])));
  } else if (target?.kind === "phone") {
    checks.push(await whatsappSendsCheck(scope.orgId, scope.brandId, target.value));
  }
  return decideThreadAbsence(scope.lastBuiltAt ?? null, checks);
}
