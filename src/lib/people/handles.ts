/**
 * STATED contact handles (CONTACT-REDIRECT-1101, owner 2026-11-01).
 *
 * A person writing to a brand says "don't message me on this account, reach me
 * here: +8801952666418 (WhatsApp)". Nothing in a source record ties the second
 * number to the first: the person themself said it. Whoever read it (our
 * assistant through chat-service, staff, an agent through the MCP) states it here:
 *
 *  - the handle JOINS the person: every rebuild reads an active statement as
 *    `stated_handle` evidence tying every key the person held when it was said to
 *    the handle's key (a phone, an email), and states it to human-service as an
 *    org-scoped judgment like a stated merge. A thread on the new handle (a
 *    WhatsApp room with the new number) is then the same person, one history;
 *  - `preferred` = that is where they want to be reached from now on: a send to
 *    the person goes to the latest preferred handle; the handle they left is
 *    written to again only once they write there after the statement
 *    (`wroteFromPhoneSince`);
 *  - a phone is looked up on WhatsApp at once (`resolveOneWhatsappPhone`), so the
 *    room the brand already holds with it carries the phone and merges into the
 *    person at the rebuild that starts now.
 *
 * Generic: any channel, any brand, any org. Undo sets `undone_at` (row kept).
 */

import { and, desc, eq, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { personContactHandles, type Person, type PersonContactHandle } from "../../db/schema.js";
import { emailKey, normalizeEmail, normalizePhone, phoneKey } from "./identity.js";
import { findPersonById } from "./person-id.js";
import { findPerson } from "./timeline.js";

export type HandleKind = "phone" | "email";

export interface HandleEvidence {
  source: string;
  channel?: string;
  roomId?: string;
  eventId?: string;
  conversationId?: string;
  text?: string;
}

export type HandleRefusal =
  | { status: 404; reason: "person_not_found"; personId: string; error: string }
  | { status: 422; reason: "invalid_handle"; error: string }
  | { status: 404; reason: "handle_not_found"; error: string };

export type StateHandleOutcome =
  | { ok: true; handle: PersonContactHandle; duplicate: boolean; person: Person }
  | { ok: false; refusal: HandleRefusal };

/** PURE: the normalised handle + its identity key, or null when it is no usable key (a national number, a malformed address). */
export function normalizeHandle(input: { phone?: string | null; email?: string | null }): { kind: HandleKind; handle: string; key: string } | null {
  if (input.phone) {
    const p = normalizePhone(input.phone);
    return p ? { kind: "phone", handle: p, key: phoneKey(p) } : null;
  }
  if (input.email) {
    const e = normalizeEmail(input.email);
    return e ? { kind: "email", handle: e, key: emailKey(e) } : null;
  }
  return null;
}

const keysArray = (keys: string[]) => sql`ARRAY[${sql.join(keys.map((k) => sql`${k}`), sql`, `)}]::text[]`;

/** Active statements naming this person (any key they hold was a key at statement time, or the handle itself is theirs). */
function ofPersonClause(keys: string[]) {
  return keys.length === 0
    ? sql`false`
    : sql`(${personContactHandles.personKeys} ?| ${keysArray(keys)} OR ${personContactHandles.handleKey} = ANY(${keysArray(keys)}))`;
}

export async function stateHandle(input: {
  orgId: string;
  brandId: string;
  /** Exactly one of personId / personKey (any identity key the person holds: `phone:+…`, `email:…`). */
  personId?: string | null;
  personKey?: string | null;
  phone?: string | null;
  email?: string | null;
  preferred: boolean;
  channel: string | null;
  reason: string | null;
  evidence: HandleEvidence | null;
  userId: string;
  runId: string | null;
}): Promise<StateHandleOutcome> {
  const h = normalizeHandle(input);
  if (!h) {
    return {
      ok: false,
      refusal: {
        status: 422,
        reason: "invalid_handle",
        error: input.phone
          ? `${input.phone} is not an international phone number (+ and country code, 8-15 digits)`
          : `${input.email ?? "(none)"} is not an email address`,
      },
    };
  }
  const person = input.personId
    ? await findPersonById(input.orgId, input.brandId, input.personId)
    : await findPerson(input.orgId, input.brandId, input.personKey!);
  if (!person) {
    const named = input.personId ?? input.personKey!;
    return { ok: false, refusal: { status: 404, reason: "person_not_found", personId: named, error: `no person ${named} in this brand (the people index is built in the background: read GET /orgs/people first)` } };
  }
  const keys = person.identityKeys as string[];

  return db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${`person_contact_handles:${input.orgId}:${input.brandId}`}))`);
    const [existing] = await tx
      .select()
      .from(personContactHandles)
      .where(
        and(
          eq(personContactHandles.orgId, input.orgId),
          eq(personContactHandles.brandId, input.brandId),
          eq(personContactHandles.handleKey, h.key),
          isNull(personContactHandles.undoneAt),
          ofPersonClause(keys),
        ),
      )
      .orderBy(desc(personContactHandles.createdAt))
      .limit(1);
    // Said again as preferred: a NEW statement (the latest preferred one wins), the old one stays.
    if (existing && (existing.preferred || !input.preferred)) {
      return { ok: true as const, handle: existing, duplicate: true, person };
    }
    const [row] = await tx
      .insert(personContactHandles)
      .values({
        orgId: input.orgId,
        brandId: input.brandId,
        personId: person.personId!,
        personKeys: keys.filter((k) => k !== h.key),
        handleKind: h.kind,
        handle: h.handle,
        handleKey: h.key,
        preferred: input.preferred,
        channel: input.channel,
        reason: input.reason,
        evidence: input.evidence,
        statedByUserId: input.userId,
        runId: input.runId,
      })
      .returning();
    return { ok: true as const, handle: row, duplicate: false, person };
  });
}

export async function undoHandle(input: {
  orgId: string;
  brandId: string;
  handleId: string;
  userId: string;
  runId: string | null;
}): Promise<{ ok: true; handle: PersonContactHandle; duplicate: boolean } | { ok: false; refusal: HandleRefusal }> {
  const [row] = await db
    .select()
    .from(personContactHandles)
    .where(and(eq(personContactHandles.id, input.handleId), eq(personContactHandles.orgId, input.orgId), eq(personContactHandles.brandId, input.brandId)));
  if (!row) return { ok: false, refusal: { status: 404, reason: "handle_not_found", error: `no stated handle ${input.handleId} in this brand` } };
  if (row.undoneAt) return { ok: true, handle: row, duplicate: true };
  const [undone] = await db
    .update(personContactHandles)
    .set({ undoneAt: new Date(), undoneByUserId: input.userId, undoRunId: input.runId })
    .where(eq(personContactHandles.id, row.id))
    .returning();
  return { ok: true, handle: undone, duplicate: false };
}

/** Every statement of the brand (undone ones included), newest first; `personKeys` narrows to one person's. */
export async function listHandles(orgId: string, brandId: string, personKeys?: string[]): Promise<PersonContactHandle[]> {
  return db
    .select()
    .from(personContactHandles)
    .where(
      and(
        eq(personContactHandles.orgId, orgId),
        eq(personContactHandles.brandId, brandId),
        ...(personKeys ? [ofPersonClause(personKeys)] : []),
      ),
    )
    .orderBy(desc(personContactHandles.createdAt), personContactHandles.id);
}

/** The latest ACTIVE preferred handle of this kind for the person holding these keys, or null. */
export async function preferredHandleOf(orgId: string, brandId: string, personKeys: string[], kind: HandleKind): Promise<PersonContactHandle | null> {
  if (personKeys.length === 0) return null;
  const [row] = await db
    .select()
    .from(personContactHandles)
    .where(
      and(
        eq(personContactHandles.orgId, orgId),
        eq(personContactHandles.brandId, brandId),
        eq(personContactHandles.handleKind, kind),
        eq(personContactHandles.preferred, true),
        isNull(personContactHandles.undoneAt),
        ofPersonClause(personKeys),
      ),
    )
    .orderBy(desc(personContactHandles.createdAt), personContactHandles.id)
    .limit(1);
  return row ?? null;
}

/**
 * Did the person write to the brand FROM this phone after `since` (on any of the
 * brand's mirrored lines)? Yes = they came back to that number: it may be written
 * to again. Senders = every ghost WhatsApp names that number by.
 */
export async function wroteFromPhoneSince(orgId: string, brandId: string, phone: string, since: Date): Promise<boolean> {
  const rows = (await db.execute(sql`
    WITH ghosts AS (
      SELECT ghost_mxid AS g FROM matrix_ghost_phones WHERE phone = ${phone}
      UNION
      SELECT channel_handle FROM contacts
      WHERE org_id = ${orgId} AND brand_id = ${brandId} AND source = 'matrix' AND phone_e164 = ${phone} AND channel_handle IS NOT NULL
    )
    SELECT 1 FROM matrix_raw_events e
    WHERE e.org_id = ${orgId} AND e.brand_id = ${brandId} AND e.event_type = 'm.room.message'
      AND e.origin_server_ts > ${since.toISOString()}::timestamptz
      AND e.sender IN (SELECT g FROM ghosts)
    LIMIT 1
  `)) as unknown as unknown[];
  return rows.length > 0;
}

export function handleView(h: PersonContactHandle) {
  return {
    handleId: h.id,
    brandId: h.brandId,
    personId: h.personId,
    kind: h.handleKind as HandleKind,
    handle: h.handle,
    preferred: h.preferred,
    channel: h.channel,
    reason: h.reason,
    evidence: (h.evidence as HandleEvidence | null) ?? null,
    personKeys: h.personKeys as string[],
    statedByUserId: h.statedByUserId,
    statedAt: h.createdAt.toISOString(),
    runId: h.runId,
    active: h.undoneAt === null,
    undoneAt: h.undoneAt?.toISOString() ?? null,
    undoneByUserId: h.undoneByUserId,
  };
}

/** One merge-evidence entry's statement, as the build stores it on the person (`mergeEvidence[].statement`). */
export interface HandleStatement {
  handleId: string;
  kind: HandleKind;
  handle: string;
  preferred: boolean;
  channel: string | null;
  statedAt: string;
}

/**
 * PURE: the person's preferred contact per kind, read off the evidence the build
 * stored on them: the latest preferred statement of each kind. Null when none.
 */
export function preferredContactOf(mergeEvidence: unknown[]): { phone: HandleStatement | null; email: HandleStatement | null } | null {
  const statements = mergeEvidence
    .map((e) => (e && typeof e === "object" && (e as { kind?: string }).kind === "stated_handle" ? (e as { statement?: HandleStatement }).statement : undefined))
    .filter((s): s is HandleStatement => !!s && s.preferred);
  if (statements.length === 0) return null;
  const latest = (kind: HandleKind) =>
    statements.filter((s) => s.kind === kind).sort((a, b) => (a.statedAt < b.statedAt ? 1 : a.statedAt > b.statedAt ? -1 : 0))[0] ?? null;
  return { phone: latest("phone"), email: latest("email") };
}
