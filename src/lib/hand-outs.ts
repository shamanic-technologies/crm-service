import { randomUUID } from "node:crypto";
import { sql, type SQL } from "drizzle-orm";
import { db } from "../db/index.js";
import { emailUnknownCandidates, emailUnknownRemainingForAsker } from "./contacts/email-lookup.js";
import { csvStepFilterSql, type StepFilter } from "./people/segment.js";
import type { SiblingIdentity } from "./people/siblings.js";
import {
  csvReachFilter,
  idFilter,
  NOT_SERVED,
  peoplePoolWhere,
  pickBusinessOnly,
  toServedContact,
  toServedPerson,
  uploadFilter,
  type PeopleFilter,
  type RawContactRow,
  type RawPersonRow,
  type Reach,
  type RelationshipsServeSummary,
  type ServedContact,
  type ServedPerson,
} from "./serve.js";

/**
 * HAND-OUTS PER ASKER (AUDIENCE-PER-OFFER-1107, owner 2026-11-07).
 *
 * A brand has several offers, each with ONE audience; the brand's CRM pool (its files and its
 * people) belongs to the BRAND, and every offer's campaign walks it. lead-service's screen
 * (Jev) judges each person against THAT offer's audience. So looking at a contact must not
 * consume it: serve-next burns a contact for the whole brand the moment it hands it out, and a
 * decline by the first offer lost the person for every other offer.
 *
 *  - hand out (`handOut`): the next contact of the pool, same pool words as serve-next
 *    (uploadIds, people, reachableBy, relationships, stepFilter, includeEmailUnknown), NOT
 *    burned. Recorded per ASKER (an opaque caller-chosen name, one per offer audience): the
 *    same asker is never handed the same contact twice (keys `email:<addr>` / `row:<bronze
 *    row>`, UNIQUE per brand x asker), any other asker of the brand still can be.
 *  - serve (`serveHandOut`): the asker serves it = `contact_serves` for every address of the
 *    hand-out, the SAME permanent brand-wide no-re-serve as serve-next. Someone else served the
 *    person first = refused `already_served`, nothing written.
 *  - decline (`declineHandOut`): bookkeeping (the asker's key already keeps it away from that
 *    asker); the contact stays open to every other asker.
 *
 * A contact burned for the brand (by serve-next, an email lookup found, or a hand-out served)
 * is never handed out again, to any asker. serve-next itself is unchanged.
 */

export const MAX_ASKER_LENGTH = 200;

export type HandedOutContact = (ServedContact | ServedPerson) & { handOutId: string };

export interface HandOutResult {
  asker: string;
  contacts: HandedOutContact[];
  /** How many contacts this call handed out (nothing burned). */
  handedOut: number;
  /** True when this asker has nothing left to be handed in this pool (live count). */
  exhausted: boolean;
  relationships?: RelationshipsServeSummary;
  emailUnknown?: { handedOut: number; remaining: number };
}

export interface HandOutRequest {
  asker: string;
  limit: number;
  runId: string;
  uploadIds?: string[];
  people?: PeopleFilter;
  reach: readonly Reach[];
  steps?: StepFilter;
  businessOnly: boolean;
  includeEmailUnknown: boolean;
}

type Exec = (q: SQL) => Promise<unknown>;

const emailKey = (email: string) => `email:${email}`;

/** Not yet handed to this asker (CSV pool, alias `c`). */
function csvNotAsked(asker: string): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM contact_hand_out_keys k
    WHERE k.brand_id = c.brand_id AND k.asker = ${asker} AND k.key = 'email:' || c.primary_email
  )`;
}

/** Not yet handed to this asker on ANY of the person's addresses (people pool, alias `p`). */
function peopleNotAsked(asker: string): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM jsonb_array_elements_text(p.emails) AS ae(email)
    JOIN contact_hand_out_keys k ON k.brand_id = p.brand_id AND k.asker = ${asker} AND k.key = 'email:' || ae.email
  )`;
}

/** Email-unknown contact not yet handed to this asker (alias `c`). */
function rowNotAsked(asker: string): SQL {
  return sql`NOT EXISTS (
    SELECT 1 FROM contact_hand_out_keys k
    WHERE k.brand_id = c.brand_id AND k.asker = ${asker} AND k.key = 'row:' || c.source_row_id::text
  )`;
}

const NOT_BURNED_CSV = sql`NOT EXISTS (SELECT 1 FROM contact_serves s WHERE s.brand_id = c.brand_id AND s.email = c.primary_email)`;

function csvFilters(orgId: string, brandId: string, r: HandOutRequest): SQL {
  return sql`${uploadFilter(r.uploadIds)}${csvReachFilter(r.reach)}${csvStepFilterSql(orgId, brandId, r.steps)}`;
}

function peopleFilterOf(r: HandOutRequest): PeopleFilter {
  return { ...r.people, stepFilter: r.steps };
}

async function csvCandidates(exec: Exec, orgId: string, brandId: string, r: HandOutRequest, limit: number, onlyIds?: string[]) {
  return (await exec(sql`
    SELECT c.id, c.org_id, c.brand_id, c.primary_email, c.phone_e164,
           c.full_name, c.first_name, c.last_name, c.raw_attributes,
           c.consent_status, c.unsubscribed, c.source_upload_id,
           c.source_row_id, c.last_rebuilt_at, c.company_name, c.company_domain,
           c.job_title, c.linkedin_url, c.note
    FROM sendable_contacts c
    WHERE c.org_id = ${orgId} AND c.brand_id = ${brandId}${csvFilters(orgId, brandId, r)}${idFilter("c", onlyIds)}
      AND ${NOT_BURNED_CSV} AND ${csvNotAsked(r.asker)}
    ORDER BY c.last_rebuilt_at ASC, c.id ASC
    LIMIT ${limit}
  `)) as unknown as RawContactRow[];
}

async function peopleCandidates(exec: Exec, orgId: string, brandId: string, r: HandOutRequest, limit: number, onlyIds?: string[]) {
  const where = peoplePoolWhere(orgId, brandId, peopleFilterOf(r), r.reach);
  return (await exec(sql`
    SELECT p.id, p.org_id, p.brand_id, p.person_id, p.human_id, p.display_name, p.emails, p.phones,
           p.sources, p.presences, p.built_at
    FROM people p
    WHERE ${where} AND ${NOT_SERVED} AND ${peopleNotAsked(r.asker)}${idFilter("p", onlyIds)}
    ORDER BY p.first_activity_at ASC NULLS LAST, p.person_key ASC
    LIMIT ${limit}
  `)) as unknown as RawPersonRow[];
}

async function remainingForAsker(orgId: string, brandId: string, r: HandOutRequest): Promise<number> {
  if (r.people) {
    const where = peoplePoolWhere(orgId, brandId, peopleFilterOf(r), r.reach);
    const [row] = (await db.execute(sql`
      SELECT count(*)::int AS n FROM people p WHERE ${where} AND ${NOT_SERVED} AND ${peopleNotAsked(r.asker)}
    `)) as unknown as { n: number }[];
    return row?.n ?? 0;
  }
  const [row] = (await db.execute(sql`
    SELECT count(*)::int AS n FROM sendable_contacts c
    WHERE c.org_id = ${orgId} AND c.brand_id = ${brandId}${csvFilters(orgId, brandId, r)}
      AND ${NOT_BURNED_CSV} AND ${csvNotAsked(r.asker)}
  `)) as unknown as { n: number }[];
  return row?.n ?? 0;
}

interface Picked {
  contact: ServedContact | ServedPerson;
  pool: "csv" | "people";
  emails: string[];
  keys: string[];
}

/** Record the picked contacts as handed out to the asker (inside the asker's lock). */
async function record(tx: Exec, orgId: string, brandId: string, r: HandOutRequest, picked: Picked[]): Promise<HandedOutContact[]> {
  if (picked.length === 0) return [];
  const rows = picked.map((p) => ({ ...p, id: randomUUID() }));
  await tx(sql`
    INSERT INTO contact_hand_outs (id, org_id, brand_id, asker, pool, contact_id, emails, handed_out_run_id)
    VALUES ${sql.join(
      rows.map((p) => sql`(${p.id}::uuid, ${orgId}::uuid, ${brandId}::uuid, ${r.asker}, ${p.pool}, ${p.contact.id}::uuid, ${JSON.stringify(p.emails)}::jsonb, ${r.runId})`),
      sql`, `,
    )}
  `);
  await tx(sql`
    INSERT INTO contact_hand_out_keys (org_id, brand_id, asker, key, hand_out_id)
    VALUES ${sql.join(
      rows.flatMap((p) => p.keys.map((k) => sql`(${orgId}::uuid, ${brandId}::uuid, ${r.asker}, ${k}, ${p.id}::uuid)`)),
      sql`, `,
    )}
    ON CONFLICT (brand_id, asker, key) DO NOTHING
  `);
  return rows.map((p) => ({ ...p.contact, handOutId: p.id }));
}

/**
 * Hand out up to `limit` contacts of the brand's pool to ONE asker, burning nothing. Serialized
 * per (brand, asker) so one asker never gets one contact twice, even concurrently.
 */
export async function handOut(identity: SiblingIdentity, r: HandOutRequest): Promise<HandOutResult> {
  const { orgId, brandId } = identity;
  let onlyIds: string[] | undefined;
  let relationships: RelationshipsServeSummary | undefined;
  let pickState: { walkedAll: boolean; waiting: number; allowed: number } | undefined;

  if (r.businessOnly) {
    // Same rule as serve-next's business_only: lead-service says who each candidate is; only
    // business people are handed out, the others stay in the pool untouched.
    const run: Exec = (q) => db.execute(q);
    const pick = r.people
      ? await pickBusinessOnly(identity, r.limit, async (offset, size) =>
          (await run(sql`
            SELECT p.id, p.human_id FROM people p
            WHERE ${peoplePoolWhere(orgId, brandId, peopleFilterOf(r), r.reach)} AND ${NOT_SERVED} AND ${peopleNotAsked(r.asker)}
            ORDER BY p.first_activity_at ASC NULLS LAST, p.person_key ASC
            LIMIT ${size} OFFSET ${offset}
          `)) as unknown as { id: string; human_id: string | null }[])
      : await pickBusinessOnly(identity, r.limit, async (offset, size) =>
          (await run(sql`
            SELECT c.id, hk.human_id
            FROM sendable_contacts c
            LEFT JOIN human_keys hk ON hk.org_id = c.org_id AND hk.identity_key = 'email:' || c.primary_email
            WHERE c.org_id = ${orgId} AND c.brand_id = ${brandId}${csvFilters(orgId, brandId, r)}
              AND ${NOT_BURNED_CSV} AND ${csvNotAsked(r.asker)}
            ORDER BY c.last_rebuilt_at ASC, c.id ASC
            LIMIT ${size} OFFSET ${offset}
          `)) as unknown as { id: string; human_id: string | null }[]);
    onlyIds = pick.allowed;
    relationships = pick.summary;
    pickState = { walkedAll: pick.walkedAll, waiting: pick.waiting, allowed: pick.allowed.length };
  }

  const csvExtra = csvFilters(orgId, brandId, r);
  const handed = await db.transaction(async (t) => {
    const exec: Exec = (q) => t.execute(q);
    await exec(sql`SELECT pg_advisory_xact_lock(hashtext(${`hand-out|${brandId}|${r.asker}`}))`);
    const picked: Picked[] = [];
    if (r.people) {
      for (const row of await peopleCandidates(exec, orgId, brandId, r, r.limit, onlyIds)) {
        picked.push({ contact: toServedPerson(row), pool: "people", emails: row.emails, keys: row.emails.map(emailKey) });
      }
    } else {
      for (const row of await csvCandidates(exec, orgId, brandId, r, r.limit, onlyIds)) {
        const email = row.primary_email!;
        picked.push({ contact: toServedContact(row), pool: "csv", emails: [email], keys: [emailKey(email)] });
      }
      // Email-unknown contacts fill the rest (no human to judge under business_only: none).
      if (r.includeEmailUnknown && !r.businessOnly) {
        const rest = r.limit - picked.length;
        for (const row of await emailUnknownCandidates(exec, orgId, brandId, rest, csvExtra, rowNotAsked(r.asker))) {
          picked.push({ contact: toServedContact(row), pool: "csv", emails: [], keys: [`row:${row.source_row_id}`] });
        }
      }
    }
    return record(exec, orgId, brandId, r, picked);
  });

  const remaining = await remainingForAsker(orgId, brandId, r);
  const unknownRemaining =
    r.includeEmailUnknown && !r.people ? await emailUnknownRemainingForAsker(orgId, brandId, csvExtra, rowNotAsked(r.asker)) : 0;
  let exhausted = remaining === 0 && unknownRemaining === 0;
  if (pickState) exhausted = pickState.walkedAll && pickState.waiting === 0 && pickState.allowed <= handed.length;

  return {
    asker: r.asker,
    contacts: handed,
    handedOut: handed.length,
    exhausted,
    ...(relationships ? { relationships } : {}),
    ...(r.includeEmailUnknown && !r.people
      ? { emailUnknown: { handedOut: handed.filter((c) => c.emailStatus === "unknown").length, remaining: unknownRemaining } }
      : {}),
  };
}

export class HandOutError extends Error {
  constructor(
    readonly status: 404 | 409,
    readonly type: string,
    message: string,
  ) {
    super(message);
  }
}

export interface HandOutDecision {
  handOutId: string;
  asker: string;
  status: "served" | "declined";
  /** True when this hand-out was already in that state (a retry). */
  duplicate: boolean;
  /** Every address now burned for the brand (served only). */
  emails: string[];
}

interface HandOutRow {
  id: string;
  asker: string;
  status: string;
  emails: string[];
  contact_id: string;
}

async function lockHandOut(exec: Exec, orgId: string, brandId: string, handOutId: string): Promise<HandOutRow> {
  const [row] = (await exec(sql`
    SELECT id, asker, status, emails, contact_id FROM contact_hand_outs
    WHERE id = ${handOutId} AND org_id = ${orgId} AND brand_id = ${brandId}
    FOR UPDATE
  `)) as unknown as HandOutRow[];
  if (!row) throw new HandOutError(404, "hand_out_not_found", "No hand-out of this brand has this id");
  return row;
}

/**
 * The asker serves the contact: burn every address of the hand-out for the brand, forever (the
 * same `contact_serves` rows serve-next writes). All or nothing: a person someone already
 * served is refused `already_served` and nothing is written.
 */
export async function serveHandOut(identity: { orgId: string; brandId: string; runId: string }, handOutId: string): Promise<HandOutDecision> {
  const { orgId, brandId, runId } = identity;
  return db.transaction(async (t) => {
    const exec: Exec = (q) => t.execute(q);
    const h = await lockHandOut(exec, orgId, brandId, handOutId);
    if (h.status === "served") return { handOutId, asker: h.asker, status: "served", duplicate: true, emails: h.emails };
    if (h.status === "declined") throw new HandOutError(409, "declined", "This asker declined this contact; it cannot serve it");
    if (h.emails.length === 0) {
      throw new HandOutError(
        409,
        "email_unknown",
        "This contact has no email yet: write the lookup back (POST /orgs/contacts/{contactId}/email-lookup), found = served for the brand",
      );
    }
    const inserted = (await exec(sql`
      INSERT INTO contact_serves (org_id, brand_id, contact_id, email, served_run_id)
      VALUES ${sql.join(h.emails.map((e) => sql`(${orgId}::uuid, ${brandId}::uuid, ${h.contact_id}::uuid, ${e}, ${runId})`), sql`, `)}
      ON CONFLICT (brand_id, email) DO NOTHING
      RETURNING email
    `)) as unknown as { email: string }[];
    if (inserted.length !== h.emails.length) {
      // Someone (another asker, serve-next) served this person first: roll back, refuse.
      throw new HandOutError(409, "already_served", "This contact was already served for the brand; do not write to it");
    }
    await exec(sql`
      UPDATE contact_hand_outs SET status = 'served', decided_at = now(), decided_run_id = ${runId} WHERE id = ${handOutId}
    `);
    return { handOutId, asker: h.asker, status: "served", duplicate: false, emails: h.emails };
  });
}

/** The asker declines the contact: never offered to it again; still open to every other asker. */
export async function declineHandOut(
  identity: { orgId: string; brandId: string; runId: string },
  handOutId: string,
  reason: string | null,
): Promise<HandOutDecision> {
  const { orgId, brandId, runId } = identity;
  return db.transaction(async (t) => {
    const exec: Exec = (q) => t.execute(q);
    const h = await lockHandOut(exec, orgId, brandId, handOutId);
    if (h.status === "declined") return { handOutId, asker: h.asker, status: "declined", duplicate: true, emails: [] };
    if (h.status === "served") throw new HandOutError(409, "already_served", "This asker already served this contact");
    await exec(sql`
      UPDATE contact_hand_outs SET status = 'declined', reason = ${reason}, decided_at = now(), decided_run_id = ${runId}
      WHERE id = ${handOutId}
    `);
    return { handOutId, asker: h.asker, status: "declined", duplicate: false, emails: [] };
  });
}
