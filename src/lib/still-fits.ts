/**
 * STILL FITS — does ONE person still belong to a pool, right now? (STILL-FITS-1012)
 *
 * A serve evaluates the pool once, at find time. lead-service hands a found
 * person to an outreach pipe hours later (a source's stock), and by then the
 * person may have left the pool: Distribute.you 2026-10-12, 3 signups found as
 * "never answered" had 32-54 message WhatsApp threads once those threads merged
 * into their person (#114), and were still handed to WhatsApp outreach.
 * human-service asks here at handover, so the pool's rule is judged by the
 * service that owns it, never re-implemented downstream.
 *
 * A QUESTION, not a serve: nothing is marked served, nothing is excluded, and
 * the no-re-serve guard (`contact_serves`) is deliberately NOT a clause, since
 * the person asked about was served by definition.
 *
 *  - people pool: every named clause of `peoplePoolClauses` (the SAME list the
 *    serve's WHERE is built from) is evaluated on the person holding the
 *    address; each failing clause comes back with its plain words. A failed
 *    "never answered" names the channels the person wrote on.
 *  - CSV pool: the contact must still be in `sendable_contacts` (and in one of
 *    `uploadIds` when bound).
 *  - nobody holds the address → `null` (the route answers 404): unknown is
 *    never "fits".
 */
import { sql } from "drizzle-orm";
import { db } from "../db/index.js";
import { personReplied } from "./people/conversation.js";
import type { Presence } from "./people/identity.js";
import { csvStepFilterSql, type StepFilter } from "./people/segment.js";
import { peoplePoolClauses, type PeopleFilter } from "./serve.js";

export interface FailedClause {
  code: string;
  reason: string;
}

export type StillFits =
  | { fits: true; pool: "people" | "csv" }
  | { fits: false; pool: "people" | "csv"; reason: string; failed: FailedClause[] };

export class AmbiguousPersonError extends Error {
  constructor(count: number) {
    super(`${count} people of the brand hold this address; cannot judge one person`);
    this.name = "AmbiguousPersonError";
  }
}

const CHANNEL_NAMES: Record<string, string> = {
  whatsapp: "WhatsApp",
  linkedin: "LinkedIn",
  telegram: "Telegram",
  discord: "Discord",
  signal: "Signal",
  instagram: "Instagram",
  messenger: "Messenger",
};

/** Where the person wrote to the brand, in plain words, from the same evidence as `personReplied`. */
export function repliedChannels(presences: Pick<Presence, "source" | "inboundCount" | "detail">[]): string[] {
  const out: string[] = [];
  for (const p of presences) {
    if (!personReplied([p])) continue;
    let name: string;
    if (p.source === "gmail") name = "email";
    else if (p.source === "instantly") name = "a reply to our cold email";
    else {
      const ch = typeof p.detail?.channel === "string" ? p.detail.channel.toLowerCase() : "";
      name = CHANNEL_NAMES[ch] ?? (ch ? ch : "direct message");
    }
    if (!out.includes(name)) out.push(name);
  }
  return out;
}

const joinWords = (xs: string[]) => (xs.length <= 1 ? xs.join("") : `${xs.slice(0, -1).join(", ")} and ${xs[xs.length - 1]}`);

/** The one readable reason: every failed clause's words, joined. */
export function summarize(failed: FailedClause[]): string {
  return failed.map((f) => f.reason).join("; ");
}

interface PersonRow {
  presences: Pick<Presence, "source" | "inboundCount" | "detail">[];
  [clause: `c${number}`]: boolean;
}

export async function stillFitsPeople(orgId: string, brandId: string, email: string, filter: PeopleFilter): Promise<StillFits | null> {
  const clauses = peoplePoolClauses(orgId, brandId, filter);
  const cols = clauses.length ? sql.join(clauses.map((c, i) => sql`(${c.sql}) AS ${sql.raw(`c${i}`)}`), sql`, `) : sql`true AS c_none`;
  const rows = (await db.execute(sql`
    SELECT p.presences, ${cols}
    FROM people p
    WHERE p.org_id = ${orgId} AND p.brand_id = ${brandId}
      AND EXISTS (SELECT 1 FROM jsonb_array_elements_text(p.emails) AS e(email) WHERE lower(e.email) = ${email.trim().toLowerCase()})
    LIMIT 2
  `)) as unknown as PersonRow[];
  if (rows.length === 0) return null;
  if (rows.length > 1) throw new AmbiguousPersonError(rows.length);
  const row = rows[0];

  const failed: FailedClause[] = [];
  clauses.forEach((c, i) => {
    if (row[`c${i}`] === true) return;
    if (c.code === "replied" && filter.replied === false) {
      const where = repliedChannels(row.presences ?? []);
      failed.push({ code: c.code, reason: where.length ? `Has written to the brand on ${joinWords(where)}` : c.reason });
      return;
    }
    failed.push({ code: c.code, reason: c.reason });
  });
  if (failed.length === 0) return { fits: true, pool: "people" };
  return { fits: false, pool: "people", reason: summarize(failed), failed };
}

interface ContactRow {
  sendable: boolean;
  unsubscribed: boolean;
  consent_status: string;
  in_files: boolean;
  steps_ok: boolean;
}

export async function stillFitsCsv(
  orgId: string,
  brandId: string,
  email: string,
  uploadIds?: string[],
  steps?: StepFilter,
): Promise<StillFits | null> {
  const files =
    uploadIds && uploadIds.length > 0
      ? sql`c.source_upload_id IN (${sql.join(uploadIds.map((id) => sql`${id}::uuid`), sql`, `)})`
      : sql`true`;
  const rows = (await db.execute(sql`
    SELECT EXISTS (SELECT 1 FROM sendable_contacts s WHERE s.id = c.id) AS sendable,
           c.unsubscribed, c.consent_status, (${files}) AS in_files,
           (true${csvStepFilterSql(orgId, brandId, steps)}) AS steps_ok
    FROM contacts c
    WHERE c.org_id = ${orgId} AND c.brand_id = ${brandId} AND c.source = 'csv'
      AND lower(c.primary_email) = ${email.trim().toLowerCase()}
    LIMIT 2
  `)) as unknown as ContactRow[];
  if (rows.length === 0) return null;
  if (rows.length > 1) throw new AmbiguousPersonError(rows.length);
  const r = rows[0];
  const failed: FailedClause[] = [];
  if (r.unsubscribed) failed.push({ code: "opted_out", reason: "Marked do not contact in the brand's CRM" });
  if (r.consent_status === "denied") failed.push({ code: "consent_denied", reason: "Refused consent in the brand's CRM" });
  if (!r.sendable && failed.length === 0) failed.push({ code: "not_sendable", reason: "No longer holds a usable email address" });
  if (!r.in_files) failed.push({ code: "not_in_file", reason: "No longer in the imported file the audience uses" });
  if (!r.steps_ok) failed.push({ code: "step_filter", reason: "No longer at the funnel steps the pipe serves (or became a client)" });
  if (failed.length === 0) return { fits: true, pool: "csv" };
  return { fits: false, pool: "csv", reason: summarize(failed), failed };
}
