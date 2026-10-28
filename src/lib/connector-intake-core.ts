/**
 * Connector intake rule, pure (GHL-MIRROR-FROZEN-1028). A mirror connection (GoHighLevel, PostHog, Stripe, Clerk) can
 * sync "fine" every 15 min and still take in nothing: the sync proves the credential, not that the account still
 * lives. Doc Dinners' GoHighLevel took in no new contact, form, deal nor appointment from 2026-10-20 to 10-28 while
 * reporting `active`; GoHighLevel's own API showed the same (the account itself went quiet), and nobody could see it.
 *
 * QUIET = days since the newest record the VENDOR dates (creation date, never our mirror time) on a UTC day.
 * UNUSUAL = quieter than the connection's own longest quiet stretch over the 180 days before its newest record (and
 * at least 3 days), only for a connection with enough history to have a habit (20+ active days). A sparse account
 * (a Stripe with a payment a month) is never red for being itself.
 */

export const HISTORY_DAYS = 180;
export const MIN_ACTIVE_DAYS = 20;
export const MIN_QUIET_DAYS = 3;
/** Every mirror cron runs each 15 min: a connection not synced for 2 h is late. */
export const SYNC_LATE_AFTER_MS = 2 * 60 * 60_000;

const DAY_MS = 86_400_000;
const dayNumber = (day: string) => Math.round(Date.parse(`${day}T00:00:00Z`) / DAY_MS);
export const utcDay = (ms: number) => new Date(ms).toISOString().slice(0, 10);

export type IntakeReasonCode = "sync_error" | "sync_late" | "quiet_unusual";

export interface IntakeAssessment {
  status: "ok" | "red" | "paused";
  reasons: { code: IntakeReasonCode; text: string }[];
  newestRecordDay: string | null;
  quietDays: number | null;
  usualLongestQuietDays: number | null;
  activeDaysInHistory: number;
}

export function assessIntake(args: {
  /** UTC days (YYYY-MM-DD) holding at least one record the vendor dates on that day; any order, duplicates ok. */
  activeDays: string[];
  syncStatus: string;
  lastSyncedAt: Date | null;
  lastError: string | null;
  now: number;
}): IntakeAssessment {
  const today = dayNumber(utcDay(args.now));
  const days = [...new Set(args.activeDays)].map(dayNumber).filter((d) => d <= today).sort((a, b) => a - b);
  const newest = days.length ? days[days.length - 1] : null;
  const history = newest === null ? [] : days.filter((d) => d >= newest - HISTORY_DAYS);
  let usual: number | null = null;
  for (let i = 1; i < history.length; i++) usual = Math.max(usual ?? 0, history[i] - history[i - 1]);
  const quietDays = newest === null ? null : today - newest;

  const base = {
    newestRecordDay: newest === null ? null : utcDay(newest * DAY_MS),
    quietDays,
    usualLongestQuietDays: usual,
    activeDaysInHistory: history.length,
  };
  if (args.syncStatus === "paused") return { status: "paused", reasons: [], ...base };

  const reasons: IntakeAssessment["reasons"] = [];
  if (args.syncStatus === "error") reasons.push({ code: "sync_error", text: `The sync fails: ${args.lastError ?? "no message"}` });
  if (!args.lastSyncedAt || args.now - args.lastSyncedAt.getTime() > SYNC_LATE_AFTER_MS) {
    reasons.push({ code: "sync_late", text: args.lastSyncedAt ? `Last good sync ${args.lastSyncedAt.toISOString()}` : "Never synced" });
  }
  if (
    quietDays !== null &&
    history.length >= MIN_ACTIVE_DAYS &&
    quietDays > Math.max(MIN_QUIET_DAYS, usual ?? 0)
  ) {
    reasons.push({
      code: "quiet_unusual",
      text: `Nothing new for ${quietDays} days (longest quiet stretch in the 180 days before: ${usual ?? 0} days)`,
    });
  }
  return { status: reasons.length ? "red" : "ok", reasons, ...base };
}

/** The last `days` UTC days up to today, zero-filled. */
export function dailySeries(counts: Map<string, number>, days: number, now: number): { day: string; records: number }[] {
  const out: { day: string; records: number }[] = [];
  for (let i = days - 1; i >= 0; i--) {
    const day = utcDay(now - i * DAY_MS);
    out.push({ day, records: counts.get(day) ?? 0 });
  }
  return out;
}
