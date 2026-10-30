/**
 * CLIENT-ACTIVITY-1030: the pure half of an account activity (the line on the thread) and the thread read, kept free
 * of the ping's imports so the people timeline reads it without a cycle (lib/account-activity/activity.ts).
 */
import { and, asc, eq, inArray, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { accountActivities, type AccountActivity } from "../../db/schema.js";
import { normalizeEmail } from "../people/identity.js";

/** The timeline channel of an account activity (same as billing's account events). */
export const ACTIVITY_CHANNEL = "account";

export interface ActivityChange {
  label: string;
  before: string | null;
  after: string | null;
}

/** PURE: the owner's copy rule: no em / en dash, ever (a range keeps a plain hyphen). */
export function noDashes(s: string): string {
  return s.replace(/\s*[—–]\s*/g, (m) => (/\s/.test(m) ? " - " : "-")).replace(/\s+/g, " ").trim();
}

/**
 * PURE: the line on the thread, plain English:
 *   Chaim Tesser · Campaign created: "ABA Owners Meetings"
 *   Chaim Tesser · Budget changed: "ABA Owners Meetings" · Daily budget: $20/day to $50/day
 */
export function activityLine(a: {
  title: string;
  subject: { name?: string | null } | null;
  changes: ActivityChange[];
  actorName?: string | null;
}): string {
  const parts: string[] = [];
  if (a.actorName?.trim()) parts.push(a.actorName.trim());
  const name = a.subject?.name?.trim();
  parts.push(name ? `${a.title.trim()}: "${name}"` : a.title.trim());
  for (const c of a.changes) parts.push(`${c.label.trim()}: ${c.before?.trim() || "none"} to ${c.after?.trim() || "none"}`);
  return noDashes(parts.join(" · "));
}

/** Every FILED fact acted by one of these addresses, oldest first (the staff Unibox thread). */
export async function readActivityThread(emails: string[]): Promise<AccountActivity[]> {
  const keys = [...new Set(emails.map((e) => normalizeEmail(e)).filter((e): e is string => !!e))];
  if (keys.length === 0) return [];
  return db
    .select()
    .from(accountActivities)
    .where(and(eq(accountActivities.status, "filed"), inArray(accountActivities.actorEmail, keys)))
    .orderBy(asc(accountActivities.occurredAt), asc(accountActivities.id));
}

export async function countFiledActivities(): Promise<number> {
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(accountActivities).where(eq(accountActivities.status, "filed"));
  return n;
}
