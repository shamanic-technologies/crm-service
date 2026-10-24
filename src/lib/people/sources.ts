/**
 * Reading each source's people for one (org, brand) — from the source's own
 * served read (siblings) or crm-service's own silver (Matrix, GoHighLevel, CSV).
 * No sibling bronze is ever copied: what is kept is who the person is and how
 * much was exchanged, not the messages.
 *
 * Every reader answers a `SourceRead` whose `status` keeps the three cases a
 * consumer must not confuse:
 *  - `not_connected` — the brand/org has no such source at all;
 *  - `ok`            — connected; `presences` may legitimately be empty;
 *  - `failed`        — connected (or unknown) but could not be read: `error`.
 */

import { and, eq, isNotNull, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { authConnections, contacts, ghlConnections, matrixConnections, posthogConnections, stripeConnections, personMerges, transactionalEmails, whatsappSends, creditEvents } from "../../db/schema.js";
import { GHL_SOURCE } from "../gohighlevel/records.js";
import { POSTHOG_SOURCE } from "../posthog/records.js";
import { STRIPE_SOURCE } from "../stripe/records.js";
import {
  handleKey,
  normalizeEmail,
  type Evidence,
  type PeopleSource,
  type Presence,
} from "./identity.js";
import { siblingGet, siblingGetOk, type SiblingIdentity } from "./siblings.js";
import { handleOf } from "../matrix/events.js";
import type { GhlDeal, LeadCompanyTags, LeadDisqualification, LeadHumanTags, LeadStanding } from "./state.js";
import { copilotPresences, isCopilotDestination, readCopilotRows } from "../copilot/messages.js";
import { apiCallPresences, readApiCallPresenceRows } from "../api-calls/calls.js";

export const SOURCE_STATUSES = ["not_connected", "ok", "failed"] as const;
export type SourceStatus = (typeof SOURCE_STATUSES)[number];

export interface SourceRead {
  source: PeopleSource;
  status: SourceStatus;
  presences: Presence[];
  /** What the SOURCE itself counts, for reconciliation (null when not read). */
  sourceCount: number | null;
  /** What `sourceCount` counts, in words. */
  sourceCountBasis: string;
  error: string | null;
  /** Scope of the source: Gmail is connected per ORG, the rest per brand. */
  scope: "org" | "brand";
}

export interface EvidenceRead {
  kind: Evidence["kind"];
  status: SourceStatus;
  evidence: Evidence[];
  error: string | null;
}

const iso = (v: string | Date | null | undefined): string | null =>
  v === null || v === undefined ? null : new Date(v).toISOString();

const maxIso = (values: (string | null | undefined)[]): string | null => {
  const present = values.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (present.length === 0) return null;
  return present.reduce((a, b) => (new Date(a) > new Date(b) ? a : b));
};
const minIso = (values: (string | null | undefined)[]): string | null => {
  const present = values.filter((v): v is string => typeof v === "string" && v.length > 0);
  if (present.length === 0) return null;
  return present.reduce((a, b) => (new Date(a) < new Date(b) ? a : b));
};

// ─── instantly-service: every lead our cold email WROTE to ──────────────────

/** One instantly-service `GET /orgs/written-to-leads` row: one (sequence, lead) we sent at least one real email to. */
export interface WrittenToLead {
  campaignId: string | null;
  instantlyCampaignId: string;
  leadEmail: string;
  brandIds: string[];
  firstSentAt: string;
  lastSentAt: string;
  /** `(replied AND NOT unsubscribed) OR clicked` — exactly the rows engaged-leads serves. */
  engaged: boolean;
  replied: boolean;
  clicked: boolean;
  unsubscribed: boolean;
  bounced: boolean;
  firstRepliedAt: string | null;
  firstClickedAt: string | null;
  replyClassification: string | null;
  replyKind: string | null;
  disqualified: boolean;
}

interface WrittenToPage {
  count: number;
  nextCursor: string | null;
  leads: WrittenToLead[];
}

const WRITTEN_TO_PAGE = 5000;

/**
 * PURE: one presence per address over its (sequence, lead) rows. Every lead we
 * wrote to is a person in conversation, answered or not (owner, 2026-10-09:
 * "toutes nos conversations, y compris celles où c'est que nous qui avons
 * écrit"). The engagement half (`replied`, `clicked`, the reply's
 * classification) reads ONLY the `engaged` rows, so a person who replied or
 * clicked keeps exactly the signals engaged-leads used to give them, and a
 * reply asking to stop (replied + unsubscribed, never engaged) states no reply.
 */
export function writtenToPresences(leads: WrittenToLead[]): Presence[] {
  const byEmail = new Map<string, WrittenToLead[]>();
  for (const lead of leads) {
    const email = normalizeEmail(lead.leadEmail);
    if (!email) continue;
    const list = byEmail.get(email) ?? [];
    list.push(lead);
    byEmail.set(email, list);
  }
  return [...byEmail.entries()].map(([email, rows]) => {
    const engaged = rows.filter((r) => r.engaged);
    const latestReply = engaged
      .filter((r) => r.replied && r.firstRepliedAt)
      .sort((a, b) => (a.firstRepliedAt! < b.firstRepliedAt! ? 1 : -1))[0];
    return {
      source: "instantly",
      sourceRef: email,
      displayName: null,
      company: null,
      emails: [email],
      phones: [],
      firstActivityAt: minIso(rows.map((r) => r.firstSentAt)),
      lastActivityAt: maxIso(
        rows.flatMap((r) => [r.lastSentAt, r.engaged ? r.firstRepliedAt : null, r.engaged ? r.firstClickedAt : null]),
      ),
      messageCount: null,
      inboundCount: null,
      outboundCount: null,
      detail: {
        campaignIds: [...new Set(rows.map((r) => r.campaignId).filter((c): c is string => !!c))],
        platformSends: rows.filter((r) => !r.campaignId).length,
        engaged: engaged.length > 0,
        replied: engaged.some((r) => r.replied),
        // ANY answer, a reply asking to stop included (never engaged): the
        // person answered us, so outreach treats them as having replied.
        anyReply: rows.some((r) => r.replied),
        clicked: engaged.some((r) => r.clicked),
        replyClassification: latestReply?.replyClassification ?? null,
        replyKind: latestReply?.replyKind ?? null,
        disqualified: rows.some((r) => r.disqualified),
        firstSentAt: minIso(rows.map((r) => r.firstSentAt)),
        lastSentAt: maxIso(rows.map((r) => r.lastSentAt)),
      },
    };
  });
}

/**
 * instantly-service `GET /orgs/written-to-leads?brand_id=` — every lead we
 * actually sent at least one email to, whether or not they answered, walked
 * page by page until `nextCursor` is null. One presence per address;
 * `sourceCount` is instantly's own row count (one per sequence × lead).
 */
export async function readInstantly(identity: SiblingIdentity): Promise<SourceRead> {
  const base = {
    source: "instantly" as const,
    scope: "brand" as const,
    sourceCountBasis: "instantly-service written-to-leads rows (one per sequence × lead we sent at least one email to)",
  };
  try {
    const leads: WrittenToLead[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = `brand_id=${encodeURIComponent(identity.brandId)}&limit=${WRITTEN_TO_PAGE}${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ""}`;
      const page: WrittenToPage = await siblingGetOk<WrittenToPage>("instantly", `/orgs/written-to-leads?${qs}`, identity);
      leads.push(...page.leads);
      cursor = page.nextCursor;
    } while (cursor);
    return { ...base, status: "ok", presences: writtenToPresences(leads), sourceCount: leads.length, error: null };
  } catch (err) {
    return { ...base, status: "failed", presences: [], sourceCount: null, error: (err as Error).message };
  }
}

// ─── google-service: the people the org's mailbox exchanged mail with ───────

interface Correspondent {
  email: string;
  name: string | null;
  outboundMessages: number;
  inboundMessages: number;
  twoWay: boolean;
  firstMessageAt: string | null;
  lastMessageAt: string | null;
}

interface CorrespondentsPage {
  ownerAddresses: string[];
  total: number;
  twoWayTotal: number;
  limit: number;
  offset: number;
  correspondents: Correspondent[];
}

const CORRESPONDENTS_PAGE = 1000;

/**
 * google-service `GET /orgs/google/correspondents` — every address the
 * connected mailbox has been IN CONVERSATION with (the owner wrote to them);
 * pure inbound noise is excluded there. Its documented 404
 * `no_google_account_connected` is "not connected", not an empty mailbox.
 *
 * Gmail is connected per ORG (google-service scopes the mailbox to the org, not
 * to a brand), so every brand of the org shares its mailbox's people.
 */
export async function readGmail(identity: SiblingIdentity): Promise<SourceRead> {
  const base = {
    source: "gmail" as const,
    scope: "org" as const,
    sourceCountBasis: "google-service correspondents total (addresses the mailbox wrote to)",
  };
  try {
    const presences: Presence[] = [];
    let total = 0;
    for (let offset = 0; ; offset += CORRESPONDENTS_PAGE) {
      const r = await siblingGet(
        "google",
        `/orgs/google/correspondents?limit=${CORRESPONDENTS_PAGE}&offset=${offset}`,
        identity,
      );
      if (r.status === 404 && (r.body as { reason?: string } | null)?.reason === "no_google_account_connected") {
        return { ...base, status: "not_connected", presences: [], sourceCount: null, error: null };
      }
      if (r.status !== 200) {
        throw new Error(
          `google-service GET /orgs/google/correspondents returned ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`,
        );
      }
      const page = r.body as CorrespondentsPage;
      total = page.total;
      for (const c of page.correspondents) {
        const email = normalizeEmail(c.email);
        if (!email) continue;
        presences.push({
          source: "gmail",
          sourceRef: email,
          displayName: c.name,
          company: null,
          emails: [email],
          phones: [],
          firstActivityAt: c.firstMessageAt,
          lastActivityAt: c.lastMessageAt,
          messageCount: c.outboundMessages + c.inboundMessages,
          inboundCount: c.inboundMessages,
          outboundCount: c.outboundMessages,
          detail: { twoWay: c.twoWay },
        });
      }
      if (page.correspondents.length < CORRESPONDENTS_PAGE || offset + CORRESPONDENTS_PAGE >= page.total) break;
    }
    return { ...base, status: "ok", presences, sourceCount: total, error: null };
  } catch (err) {
    return { ...base, status: "failed", presences: [], sourceCount: null, error: (err as Error).message };
  }
}

// ─── crm-service silver: Matrix DMs ─────────────────────────────────────────

export async function readMatrix(orgId: string, brandId: string): Promise<SourceRead> {
  const base = {
    source: "matrix" as const,
    scope: "brand" as const,
    sourceCountBasis: "crm-service Matrix conversations",
  };
  const connections = await db
    .select({ id: matrixConnections.id })
    .from(matrixConnections)
    .where(and(eq(matrixConnections.orgId, orgId), eq(matrixConnections.brandId, brandId)));
  if (connections.length === 0) {
    return { ...base, status: "not_connected", presences: [], sourceCount: null, error: null };
  }
  const rows = (await db.execute(sql`
    SELECT c.id AS contact_id, c.full_name, c.phone_e164, c.channel, c.channel_handle,
           mc.counterpart_prefix,
           v.id AS conversation_id, v.first_message_at, v.last_message_at,
           v.message_count, v.inbound_count, v.outbound_count,
           l.status AS lead_status
    FROM conversations v
    JOIN contacts c ON c.id = v.contact_id
    JOIN matrix_connections mc ON mc.id = v.connection_id
    LEFT JOIN matrix_leads l ON l.conversation_id = v.id
    WHERE v.org_id = ${orgId} AND v.brand_id = ${brandId}
    ORDER BY v.last_message_at DESC, v.id
  `)) as unknown as {
    contact_id: string;
    full_name: string | null;
    phone_e164: string | null;
    channel: string;
    channel_handle: string | null;
    counterpart_prefix: string;
    conversation_id: string;
    first_message_at: string | Date;
    last_message_at: string | Date;
    message_count: number;
    inbound_count: number;
    outbound_count: number;
    lead_status: string | null;
  }[];
  // Every group the brand's accounts are in, per member contact (RELATIONSHIP-TAGS-1014).
  const memberRows = (await db.execute(sql`
    SELECT gm.contact_id, c.full_name, c.phone_e164, c.channel, c.channel_handle, mc.counterpart_prefix,
           g.room_id, g.name AS group_name, g.member_count, gm.membership, gm.joined_at,
           gm.authored_count, gm.first_authored_at, gm.last_authored_at
    FROM matrix_group_members gm
    JOIN matrix_groups g ON g.id = gm.group_id
    JOIN contacts c ON c.id = gm.contact_id
    JOIN matrix_connections mc ON mc.id = g.connection_id
    WHERE gm.org_id = ${orgId} AND gm.brand_id = ${brandId}
    ORDER BY gm.contact_id, g.room_id
  `)) as unknown as {
    contact_id: string;
    full_name: string | null;
    phone_e164: string | null;
    channel: string;
    channel_handle: string | null;
    counterpart_prefix: string;
    room_id: string;
    group_name: string | null;
    member_count: number;
    membership: string;
    joined_at: string | Date | null;
    authored_count: number;
    last_authored_at: string | Date | null;
    first_authored_at: string | Date | null;
  }[];
  const groupsOf = new Map<string, MatrixGroupMembership[]>();
  for (const m of memberRows) {
    const list = groupsOf.get(m.contact_id) ?? [];
    list.push({
      roomId: m.room_id,
      name: m.group_name,
      memberCount: Number(m.member_count),
      membership: m.membership,
      joinedAt: iso(m.joined_at),
      authoredCount: Number(m.authored_count),
      firstAuthoredAt: iso(m.first_authored_at),
      lastAuthoredAt: iso(m.last_authored_at),
    });
    groupsOf.set(m.contact_id, list);
  }
  // `matrix:<contactId>` stays exactly where it was the person's key before (a contact with no
  // phone), so nobody's person key or id moves; the handle is the new key beside it.
  const keysOfContact = (contactId: string, channel: string, handle: string | null, prefix: string, phone: string | null) => {
    const h = handle ? handleOf(channel, handle, prefix) : null;
    return [...(phone ? [] : [`matrix:${contactId}`]), ...(h ? [handleKey(h.network, h.id)] : [])];
  };
  const presences: Presence[] = rows.map((r) => ({
    source: "matrix",
    sourceRef: r.contact_id,
    displayName: r.full_name,
    company: null,
    emails: [],
    phones: r.phone_e164 ? [r.phone_e164] : [],
    keys: keysOfContact(r.contact_id, r.channel, r.channel_handle, r.counterpart_prefix, r.phone_e164),
    firstActivityAt: iso(r.first_message_at),
    lastActivityAt: iso(r.last_message_at),
    messageCount: Number(r.message_count),
    inboundCount: Number(r.inbound_count),
    outboundCount: Number(r.outbound_count),
    detail: {
      kind: "dm",
      contactId: r.contact_id,
      conversationId: r.conversation_id,
      channel: r.channel,
      channelHandle: r.channel_handle,
      leadStatus: r.lead_status,
      groups: groupsOf.get(r.contact_id) ?? [],
    },
  }));
  // A member the brand has no DM with is a person all the same: one presence per member contact.
  const withDm = new Set(rows.map((r) => r.contact_id));
  const seen = new Set<string>();
  for (const m of memberRows) {
    if (withDm.has(m.contact_id) || seen.has(m.contact_id)) continue;
    seen.add(m.contact_id);
    const groups = groupsOf.get(m.contact_id)!;
    const authored = groups.reduce((n, g) => n + g.authoredCount, 0);
    const firsts = groups.map((g) => g.firstAuthoredAt).filter((x): x is string => !!x).sort();
    const lasts = groups.map((g) => g.lastAuthoredAt).filter((x): x is string => !!x).sort();
    presences.push({
      source: "matrix",
      sourceRef: m.contact_id,
      displayName: m.full_name,
      company: null,
      emails: [],
      phones: m.phone_e164 ? [m.phone_e164] : [],
      keys: keysOfContact(m.contact_id, m.channel, m.channel_handle, m.counterpart_prefix, m.phone_e164),
      firstActivityAt: firsts[0] ?? null,
      lastActivityAt: lasts[lasts.length - 1] ?? null,
      messageCount: authored,
      inboundCount: authored,
      outboundCount: 0,
      detail: {
        kind: "group_member",
        contactId: m.contact_id,
        channel: m.channel,
        channelHandle: m.channel_handle,
        groups,
      },
    });
  }
  return { ...base, status: "ok", presences, sourceCount: rows.length + seen.size, error: null };
}

/** One group a Matrix contact is a member of (RELATIONSHIP-TAGS-1014). */
export interface MatrixGroupMembership {
  roomId: string;
  name: string | null;
  memberCount: number;
  membership: string;
  joinedAt: string | null;
  /** Messages the person wrote in the group. */
  authoredCount: number;
  firstAuthoredAt: string | null;
  lastAuthoredAt: string | null;
}

/**
 * PURE: a person known ONLY as a member of the brand's groups, who never wrote
 * a word there or anywhere else: listed only on demand (people.group_only).
 */
export function isGroupOnly(presences: Presence[]): boolean {
  return (
    presences.length > 0 &&
    presences.every((p) => p.source === "matrix" && p.detail.kind === "group_member" && (p.messageCount ?? 0) === 0)
  );
}

// ─── crm-service silver: GoHighLevel contacts ───────────────────────────────

export async function readGoHighLevel(orgId: string, brandId: string): Promise<SourceRead> {
  const base = {
    source: "gohighlevel" as const,
    scope: "brand" as const,
    sourceCountBasis: "crm-service mirrored GoHighLevel contacts",
  };
  const connections = await db
    .select({ id: ghlConnections.id })
    .from(ghlConnections)
    .where(and(eq(ghlConnections.orgId, orgId), eq(ghlConnections.brandId, brandId)));
  if (connections.length === 0) {
    return { ...base, status: "not_connected", presences: [], sourceCount: null, error: null };
  }
  const rows = (await db.execute(sql`
    SELECT c.id, c.external_id, c.full_name, c.first_name, c.last_name, c.primary_email,
           c.phone_e164, c.company_name, c.source_created_at, c.source_updated_at,
           COALESCE((
             SELECT json_agg(json_build_object(
               'status', o.status, 'pipelineName', o.pipeline_name,
               'stageName', o.stage_name, 'updatedAt', o.ghl_updated_at
             ) ORDER BY o.ghl_updated_at DESC NULLS LAST, o.id)
             FROM ghl_opportunities o WHERE o.contact_id = c.id
           ), '[]'::json) AS deals,
           (SELECT max(a.booked_at) FROM ghl_appointments a WHERE a.contact_id = c.id) AS last_booked_at,
           (SELECT max(f.submitted_at) FROM ghl_form_submissions f WHERE f.contact_id = c.id) AS last_form_at
    FROM contacts c
    WHERE c.org_id = ${orgId} AND c.brand_id = ${brandId} AND c.source = ${GHL_SOURCE}
    ORDER BY c.external_id, c.id
  `)) as unknown as {
    id: string;
    external_id: string;
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    primary_email: string | null;
    phone_e164: string | null;
    company_name: string | null;
    source_created_at: string | Date | null;
    source_updated_at: string | Date | null;
    deals: GhlDeal[];
    last_booked_at: string | Date | null;
    last_form_at: string | Date | null;
  }[];
  const presences: Presence[] = rows.map((r) => {
    const name = r.full_name ?? ([r.first_name, r.last_name].filter(Boolean).join(" ") || null);
    return {
      source: "gohighlevel",
      sourceRef: r.id,
      displayName: name,
      company: r.company_name,
      emails: r.primary_email ? [r.primary_email] : [],
      phones: r.phone_e164 ? [r.phone_e164] : [],
      firstActivityAt: iso(r.source_created_at),
      lastActivityAt: maxIso([
        iso(r.source_updated_at),
        iso(r.source_created_at),
        iso(r.last_booked_at),
        iso(r.last_form_at),
        ...r.deals.map((d) => (d.updatedAt ? iso(d.updatedAt) : null)),
      ]),
      messageCount: null,
      inboundCount: null,
      outboundCount: null,
      detail: { contactId: r.id, externalId: r.external_id, deals: r.deals },
    };
  });
  return { ...base, status: "ok", presences, sourceCount: rows.length, error: null };
}

// ─── connection health, shared by PostHog and Stripe ─────────────────────────

/**
 * A connection whose sync has never succeeded has nothing to read: `failed`
 * with its error. One that synced before and failed since is still read (its
 * mirror is real, only stale): `ok`, with the last error carried beside it.
 */
function connectionHealth(conns: { status: string; lastError: string | null; lastSyncedAt: Date | null }[]):
  | { status: "not_connected" }
  | { status: "failed"; error: string }
  | { status: "ok"; error: string | null } {
  if (conns.length === 0) return { status: "not_connected" };
  // A brand may connect several accounts of one source (two Stripe accounts):
  // the source reads ok once ANY of them has synced, and every account still
  // failing or not yet synced is named in `error` rather than hidden.
  const pending = (c: (typeof conns)[number]) =>
    c.lastSyncedAt === null
      ? c.status === "error"
        ? (c.lastError ?? "first sync failed")
        : "connected, first sync not finished yet"
      : c.status === "error"
        ? c.lastError
        : null;
  const errors = conns.map(pending).filter((e): e is string => !!e);
  if (!conns.some((c) => c.lastSyncedAt !== null)) return { status: "failed", error: errors[0] };
  return { status: "ok", error: errors.length ? errors.join("; ") : null };
}

// ─── crm-service silver: PostHog identified persons ─────────────────────────

/**
 * Every identified PostHog person — someone who signed up or otherwise told the
 * brand who they are (see posthog/client.ts). Their visits and key events are
 * the activity span; anonymous visitors are never mirrored. A person PostHog
 * holds no email for still carries their distinct ids (`userIds`), which is how
 * they join the signed-up user of the brand's auth provider.
 */
export async function readPosthog(orgId: string, brandId: string): Promise<SourceRead> {
  const base = {
    source: "posthog" as const,
    scope: "brand" as const,
    sourceCountBasis: "crm-service mirrored PostHog known persons (identified, an email, a phone, a name, a website, or named by an auth user id)",
  };
  const conns = await db
    .select({ status: posthogConnections.status, lastError: posthogConnections.lastError, lastSyncedAt: posthogConnections.lastSyncedAt })
    .from(posthogConnections)
    .where(and(eq(posthogConnections.orgId, orgId), eq(posthogConnections.brandId, brandId)));
  const health = connectionHealth(conns);
  if (health.status === "not_connected") return { ...base, status: "not_connected", presences: [], sourceCount: null, error: null };
  if (health.status === "failed") return { ...base, status: "failed", presences: [], sourceCount: null, error: health.error };
  const rows = (await db.execute(sql`
    SELECT c.id, c.external_id, c.full_name, c.primary_email, c.phone_e164, c.source_created_at,
           c.raw_attributes->'distinctIds' AS distinct_ids, c.raw_attributes->>'website' AS website,
           min(a.occurred_at) AS first_at, max(coalesce(a.ended_at, a.occurred_at)) AS last_at,
           count(a.id) FILTER (WHERE a.kind = 'visit')::int AS visits,
           count(a.id) FILTER (WHERE a.kind = 'event')::int AS events
    FROM contacts c
    LEFT JOIN posthog_activities a ON a.contact_id = c.id
    WHERE c.org_id = ${orgId} AND c.brand_id = ${brandId} AND c.source = ${POSTHOG_SOURCE}
    GROUP BY c.id
    ORDER BY c.external_id, c.id
  `)) as unknown as {
    id: string;
    external_id: string;
    full_name: string | null;
    primary_email: string | null;
    phone_e164: string | null;
    source_created_at: string | Date | null;
    distinct_ids: string[] | null;
    website: string | null;
    first_at: string | Date | null;
    last_at: string | Date | null;
    visits: number;
    events: number;
  }[];
  const presences: Presence[] = rows.map((r) => ({
    source: "posthog",
    sourceRef: r.id,
    displayName: r.full_name,
    company: null,
    emails: r.primary_email ? [r.primary_email] : [],
    // A phone the person's PostHog properties carry (WA-GIVEN-TRIGGER-1015): a visitor known by it alone is a person.
    phones: r.phone_e164 ? [r.phone_e164] : [],
    userIds: Array.isArray(r.distinct_ids) ? r.distinct_ids : [],
    firstActivityAt: minIso([iso(r.first_at), iso(r.source_created_at)]),
    lastActivityAt: maxIso([iso(r.last_at), iso(r.source_created_at)]),
    messageCount: null,
    inboundCount: null,
    outboundCount: null,
    // The website they typed (ONBOARDING-IN-UNIBOX-1015): a visitor known by it is a person, "Visitor from <domain>".
    detail: { contactId: r.id, externalId: r.external_id, visits: Number(r.visits), events: Number(r.events), website: r.website },
  }));
  return { ...base, status: "ok", presences, sourceCount: rows.length, error: health.error };
}

// ─── crm-service silver: Stripe customers ───────────────────────────────────

/** What a customer's Stripe record states about their money, for the person's state. */
export interface StripeStanding {
  subscriptionStatuses: string[];
  /** Succeeded charges not fully refunded. */
  paidCharges: number;
  /** Succeeded charges fully refunded. */
  refundedCharges: number;
  /** Net collected per currency, minor units (succeeded charges minus refunded amounts). */
  netPaidMinor: Record<string, number>;
}

export async function readStripe(orgId: string, brandId: string): Promise<SourceRead> {
  const base = {
    source: "stripe" as const,
    scope: "brand" as const,
    sourceCountBasis: "crm-service mirrored Stripe customers",
  };
  const conns = await db
    .select({ status: stripeConnections.status, lastError: stripeConnections.lastError, lastSyncedAt: stripeConnections.lastSyncedAt })
    .from(stripeConnections)
    .where(and(eq(stripeConnections.orgId, orgId), eq(stripeConnections.brandId, brandId)));
  const health = connectionHealth(conns);
  if (health.status === "not_connected") return { ...base, status: "not_connected", presences: [], sourceCount: null, error: null };
  if (health.status === "failed") return { ...base, status: "failed", presences: [], sourceCount: null, error: health.error };
  const rows = (await db.execute(sql`
    SELECT c.id, c.external_id, c.full_name, c.primary_email, c.phone_e164, c.source_created_at,
           min(t.occurred_at) AS first_at, max(t.occurred_at) AS last_at,
           COALESCE(json_agg(json_build_object(
             'kind', t.kind, 'status', t.status, 'amountMinor', t.amount_minor, 'currency', t.currency,
             'amountRefunded', t.detail->'amountRefunded', 'refunded', t.detail->'refunded'
           )) FILTER (WHERE t.id IS NOT NULL), '[]'::json) AS txs
    FROM contacts c
    LEFT JOIN stripe_transactions t ON t.contact_id = c.id
    WHERE c.org_id = ${orgId} AND c.brand_id = ${brandId} AND c.source = ${STRIPE_SOURCE}
    GROUP BY c.id
    ORDER BY c.external_id, c.id
  `)) as unknown as {
    id: string;
    external_id: string;
    full_name: string | null;
    primary_email: string | null;
    phone_e164: string | null;
    source_created_at: string | Date | null;
    first_at: string | Date | null;
    last_at: string | Date | null;
    txs: { kind: string; status: string | null; amountMinor: number | null; currency: string | null; amountRefunded: number | null; refunded: boolean | null }[];
  }[];
  const presences: Presence[] = rows.map((r) => {
    const charges = r.txs.filter((t) => t.kind === "payment" && t.status === "succeeded");
    const netPaidMinor: Record<string, number> = {};
    for (const t of charges) {
      if (!t.currency || t.amountMinor === null) continue;
      netPaidMinor[t.currency] = (netPaidMinor[t.currency] ?? 0) + Number(t.amountMinor) - Number(t.amountRefunded ?? 0);
    }
    const standing: StripeStanding = {
      subscriptionStatuses: r.txs.filter((t) => t.kind === "subscription" && t.status).map((t) => t.status!),
      paidCharges: charges.filter((t) => t.refunded !== true).length,
      refundedCharges: charges.filter((t) => t.refunded === true).length,
      netPaidMinor,
    };
    return {
      source: "stripe",
      sourceRef: r.id,
      displayName: r.full_name,
      company: null,
      emails: r.primary_email ? [r.primary_email] : [],
      phones: r.phone_e164 ? [r.phone_e164] : [],
      firstActivityAt: minIso([iso(r.first_at), iso(r.source_created_at)]),
      lastActivityAt: maxIso([iso(r.last_at), iso(r.source_created_at)]),
      messageCount: null,
      inboundCount: null,
      outboundCount: null,
      detail: { contactId: r.id, externalId: r.external_id, stripe: standing },
    };
  });
  return { ...base, status: "ok", presences, sourceCount: rows.length, error: health.error };
}

// ─── crm-service silver: auth-provider users (Clerk) ────────────────────────

/**
 * Every user of the brand's auth provider: someone who SIGNED UP to the brand's
 * product. Their email(s), phone(s) and the provider's user id (`userIds`, the
 * key PostHog persons join on). Activity span = signup → last sign-in.
 */
export async function readAuthUsers(orgId: string, brandId: string, provider: "clerk"): Promise<SourceRead> {
  const base = {
    source: provider,
    scope: "brand" as const,
    sourceCountBasis: `crm-service mirrored ${provider} users (every account of the brand's product)`,
  };
  const conns = await db
    .select({ status: authConnections.status, lastError: authConnections.lastError, lastSyncedAt: authConnections.lastSyncedAt })
    .from(authConnections)
    .where(and(eq(authConnections.orgId, orgId), eq(authConnections.brandId, brandId), eq(authConnections.provider, provider)));
  const health = connectionHealth(conns);
  if (health.status === "not_connected") return { ...base, status: "not_connected", presences: [], sourceCount: null, error: null };
  if (health.status === "failed") return { ...base, status: "failed", presences: [], sourceCount: null, error: health.error };
  const rows = await db
    .select({
      id: contacts.id,
      externalId: contacts.externalId,
      fullName: contacts.fullName,
      rawAttributes: contacts.rawAttributes,
      createdAt: contacts.sourceCreatedAt,
    })
    .from(contacts)
    .where(and(eq(contacts.orgId, orgId), eq(contacts.brandId, brandId), eq(contacts.source, provider)))
    .orderBy(contacts.externalId, contacts.id);
  const presences: Presence[] = rows.map((r) => {
    const raw = r.rawAttributes as {
      emails?: string[];
      phones?: string[];
      phoneSources?: { phone: string; via: string }[];
      lastActiveAt?: string | null;
      signedUp?: boolean;
    };
    return {
      source: provider,
      sourceRef: r.id,
      displayName: r.fullName,
      company: null,
      emails: raw.emails ?? [],
      phones: raw.phones ?? [],
      userIds: r.externalId ? [r.externalId] : [],
      firstActivityAt: iso(r.createdAt),
      lastActivityAt: maxIso([iso(r.createdAt), raw.lastActiveAt ?? null]),
      messageCount: null,
      inboundCount: null,
      outboundCount: null,
      // signedUp false = a teammate invited into an organization someone else created (auth/provider.ts isSignup).
      detail: { contactId: r.id, externalId: r.externalId, phoneSources: raw.phoneSources ?? [], signedUp: raw.signedUp !== false },
    };
  });
  return { ...base, status: "ok", presences, sourceCount: rows.length, error: health.error };
}

// ─── crm-service bronze: the Copilot's chat turns (staff Unibox only) ─────────

/**
 * Everyone who chatted with the distribute.you Copilot. Only the staff Unibox
 * scope holds any (`lib/copilot/messages.ts`); every other (org, brand) is
 * `not_connected`, whatever brand id it carries.
 */
export async function readCopilot(orgId: string, brandId: string): Promise<SourceRead> {
  const base = {
    source: "copilot" as const,
    scope: "brand" as const,
    sourceCountBasis: "crm-service stored Copilot chat addresses (staff Unibox only)",
  };
  if (!isCopilotDestination(orgId, brandId)) {
    return { ...base, status: "not_connected", presences: [], sourceCount: null, error: null };
  }
  const presences = copilotPresences(await readCopilotRows(orgId, brandId));
  return { ...base, status: "ok", presences, sourceCount: presences.length, error: null };
}

// ─── crm-service bronze: calls to our API / MCP with a client's key (staff Unibox only) ─

/**
 * Everyone who called our API or MCP server with their own key. Only the staff
 * Unibox scope holds any (`lib/api-calls/calls.ts`); every other (org, brand)
 * is `not_connected`.
 */
export async function readApiCalls(orgId: string, brandId: string): Promise<SourceRead> {
  const base = {
    source: "api" as const,
    scope: "brand" as const,
    sourceCountBasis: "crm-service stored API / MCP caller addresses (staff Unibox only)",
  };
  if (!isCopilotDestination(orgId, brandId)) {
    return { ...base, status: "not_connected", presences: [], sourceCount: null, error: null };
  }
  const presences = apiCallPresences(await readApiCallPresenceRows(orgId, brandId));
  return { ...base, status: "ok", presences, sourceCount: presences.length, error: null };
}

// ─── billing-service: our clients' account events (staff Unibox only) ──────

/**
 * billing-service's credit events (lib/credit-events/feed.ts, CREDIT-RAN-OUT-UNIBOX-EVENT-1024): thread events only,
 * never a presence (an org member is a person through the brand's own tools, e.g. its auth provider). Only the staff
 * Unibox scope reads them; every other (org, brand) is `not_connected`.
 */
export async function readBilling(orgId: string, brandId: string): Promise<SourceRead> {
  const base = {
    source: "billing" as const,
    scope: "brand" as const,
    sourceCountBasis: "crm-service mirrored billing credit events tied to people (staff Unibox only; thread events, no presences)",
  };
  if (!isCopilotDestination(orgId, brandId)) {
    return { ...base, status: "not_connected", presences: [], sourceCount: null, error: null };
  }
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(creditEvents).where(isNotNull(creditEvents.membersResolvedAt));
  return { ...base, status: "ok", presences: [], sourceCount: n, error: null };
}

// ─── transactional-email-service: what the platform emailed its clients (staff Unibox only) ─

/**
 * The transactional emails distribute.you sent (lib/transactional/sent-emails.ts, TX-EMAIL-IN-UNIBOX-1024):
 * thread items only, never a presence (a recipient only WE wrote to brings nobody in). Only the staff
 * Unibox scope reads them; every other (org, brand) is `not_connected`.
 */
export async function readTransactional(orgId: string, brandId: string): Promise<SourceRead> {
  const base = {
    source: "transactional" as const,
    scope: "brand" as const,
    sourceCountBasis: "crm-service mirrored transactional emails (staff Unibox only; thread items, no presences)",
  };
  if (!isCopilotDestination(orgId, brandId)) {
    return { ...base, status: "not_connected", presences: [], sourceCount: null, error: null };
  }
  const [{ n }] = await db.select({ n: sql<number>`count(*)::int` }).from(transactionalEmails);
  return { ...base, status: "ok", presences: [], sourceCount: n, error: null };
}

// ─── crm-service silver: contacts the client added one by one ──────────────

/**
 * MANUAL-CONTACT-IS-A-PERSON-1024 (owner 2026-10-24): a contact the client added by hand (`POST /orgs/contacts`, the
 * brand's ONE `contact_uploads` row of kind `manual`, lib/contacts/manual.ts) is a person of the brand: the client
 * said "this person matters to my business". Before, every CSV contact was merge evidence only, so a person added
 * by hand appeared nowhere (no search hit, no Unibox row, nothing to merge an anonymous visitor into).
 * A contact of an uploaded FILE stays evidence (a list of people to reach, not people the brand deals with).
 * The add is OUR action: its date is the activity span (when the client stated it), never an act of theirs.
 * `not_connected` = the brand never added anyone by hand.
 */
export async function readManualContacts(orgId: string, brandId: string): Promise<SourceRead> {
  const base = {
    source: "csv" as const,
    scope: "brand" as const,
    sourceCountBasis: "crm-service contacts the client added one by one (uploaded files are merge evidence, not people)",
  };
  const rows = (await db.execute(sql`
    SELECT u.id AS upload_id, c.id, c.full_name, c.first_name, c.last_name, c.primary_email, c.phone_e164,
           c.company_name, c.linkedin_url, coalesce(r.fetched_at, u.uploaded_at) AS added_at
    FROM contact_uploads u
    LEFT JOIN contacts c ON c.source_upload_id = u.id AND c.source = 'csv'
    LEFT JOIN contact_rows_raw r ON r.id = c.source_row_id
    WHERE u.org_id = ${orgId} AND u.brand_id = ${brandId} AND u.kind = 'manual'
    ORDER BY c.id
  `)) as unknown as {
    upload_id: string;
    id: string | null;
    full_name: string | null;
    first_name: string | null;
    last_name: string | null;
    primary_email: string | null;
    phone_e164: string | null;
    company_name: string | null;
    linkedin_url: string | null;
    added_at: string | Date | null;
  }[];
  if (rows.length === 0) return { ...base, status: "not_connected", presences: [], sourceCount: null, error: null };
  const presences: Presence[] = rows
    .filter((r): r is typeof r & { id: string } => r.id !== null)
    .map((r) => ({
      source: "csv",
      sourceRef: r.id,
      displayName: r.full_name?.trim() || [r.first_name, r.last_name].filter((v) => v?.trim()).join(" ").trim() || null,
      company: r.company_name?.trim() || null,
      emails: r.primary_email ? [r.primary_email] : [],
      phones: r.phone_e164 ? [r.phone_e164] : [],
      firstActivityAt: iso(r.added_at),
      lastActivityAt: iso(r.added_at),
      messageCount: null,
      inboundCount: null,
      outboundCount: null,
      // The company domain the client typed is organization evidence through `contactWebsites` (organizations.ts).
      detail: { contactId: r.id, uploadId: r.upload_id, origin: "manual", linkedinUrl: r.linkedin_url },
    }));
  return { ...base, status: "ok", presences, sourceCount: presences.length, error: null };
}

// ─── merge evidence ─────────────────────────────────────────────────────────

/**
 * A WhatsApp message we SENT naming the person by email AND phone: the caller
 * stated "this person, at this number", and the number answered on WhatsApp.
 * It is what joins the thread the send opened (a Matrix contact holding only
 * the phone) to the person it was meant for.
 */
export async function readWhatsappSendEvidence(orgId: string, brandId: string): Promise<EvidenceRead> {
  const rows = await db
    .select({ id: whatsappSends.id, email: whatsappSends.email, phone: whatsappSends.phone })
    .from(whatsappSends)
    .where(
      and(
        eq(whatsappSends.orgId, orgId),
        eq(whatsappSends.brandId, brandId),
        eq(whatsappSends.status, "sent"),
        sql`${whatsappSends.email} IS NOT NULL AND ${whatsappSends.phone} IS NOT NULL`,
      ),
    );
  return {
    kind: "whatsapp_send",
    status: "ok",
    error: null,
    evidence: rows.map((r) => ({
      kind: "whatsapp_send",
      ref: r.id,
      displayName: null,
      company: null,
      emails: [r.email!],
      phones: [r.phone!],
    })),
  };
}

/**
 * Every ACTIVE stated merge (`person_merges`) ties every key both people held
 * when it was stated: someone said they are one human, and that statement
 * outlives every rebuild until it is taken back.
 */
export async function readStatedMergeEvidence(orgId: string, brandId: string): Promise<EvidenceRead> {
  const rows = await db
    .select({ id: personMerges.id, keysA: personMerges.keysA, keysB: personMerges.keysB, statedBy: personMerges.statedByUserId })
    .from(personMerges)
    .where(and(eq(personMerges.orgId, orgId), eq(personMerges.brandId, brandId), isNull(personMerges.undoneAt)));
  return {
    kind: "stated_merge",
    status: "ok",
    error: null,
    evidence: rows.map((r) => {
      const keys = [...new Set([...(r.keysA as string[]), ...(r.keysB as string[])])].sort();
      const side = (ks: string[]) => ({
        emails: ks.filter((k) => k.startsWith("email:")).map((k) => k.slice(6)),
        phones: ks.filter((k) => k.startsWith("phone:")).map((k) => k.slice(6)),
      });
      return {
        kind: "stated_merge",
        ref: r.id,
        displayName: null,
        company: null,
        ...side(keys),
        keys,
        sides: [side(r.keysA as string[]), side(r.keysB as string[])],
        judgedBy: `person:${r.statedBy}`,
      };
    }),
  };
}

/** CSV rows carrying an email AND a phone tie the two together. */
export async function readCsvEvidence(orgId: string, brandId: string): Promise<EvidenceRead> {
  const rows = await db
    .select({
      id: contacts.id,
      email: contacts.primaryEmail,
      phone: contacts.phoneE164,
      fullName: contacts.fullName,
    })
    .from(contacts)
    .where(
      and(
        eq(contacts.orgId, orgId),
        eq(contacts.brandId, brandId),
        eq(contacts.source, "csv"),
        sql`${contacts.primaryEmail} IS NOT NULL AND ${contacts.phoneE164} IS NOT NULL`,
      ),
    );
  return {
    kind: "csv_contact",
    status: "ok",
    error: null,
    evidence: rows.map((r) => ({
      kind: "csv_contact",
      ref: r.id,
      displayName: r.fullName,
      company: null,
      emails: [r.email!],
      phones: [r.phone!],
    })),
  };
}

interface GoogleContactsPage {
  items: {
    id: string;
    displayName: string | null;
    emails: string[];
    phones: string[];
    organization: string | null;
    deleted: boolean;
  }[];
  nextCursor: string | null;
}

/** Google contacts (People API mirror): one contact holding several keys ties them. */
export async function readGoogleContactEvidence(identity: SiblingIdentity): Promise<EvidenceRead> {
  try {
    const evidence: Evidence[] = [];
    let cursor: string | null = null;
    do {
      const qs: string = cursor ? `?limit=200&cursor=${encodeURIComponent(cursor)}` : "?limit=200";
      const page: GoogleContactsPage = await siblingGetOk<GoogleContactsPage>(
        "google",
        `/orgs/google/contacts${qs}`,
        identity,
      );
      for (const c of page.items) {
        if (c.deleted) continue;
        if (c.emails.length + c.phones.length === 0) continue;
        evidence.push({
          kind: "google_contact",
          ref: c.id,
          displayName: c.displayName,
          company: c.organization,
          emails: c.emails,
          phones: c.phones,
        });
      }
      cursor = page.nextCursor;
    } while (cursor);
    return { kind: "google_contact", status: "ok", evidence, error: null };
  } catch (err) {
    return { kind: "google_contact", status: "failed", evidence: [], error: (err as Error).message };
  }
}

interface PairingsPage {
  crmConnected: boolean;
  pairings: LeadPairingRow[];
  nextOffset: number | null;
}

export interface LeadPairingRow {
  crmContact: { id: string; email: string | null; phone: string | null; fullName: string | null; company: string | null };
  pairing: {
    state: "paired" | "unconfirmed" | "rejected" | "unpaired";
    /** lead-service: paired on a judgment between its thresholds — a guess, listed for a person to confirm. */
    toConfirm: boolean;
    lead: { leadId?: string | null; email: string | null; fullName: string | null; company: string | null } | null;
  };
}

/** A CRM contact lead-service MAY have paired with one of our leads: shown beside it, never merged. */
export interface PossibleLead {
  crmContactId: string;
  /** lead-service's lead id: what its pairing rulings take beside crmContactId. */
  leadId: string | null;
  email: string | null;
  fullName: string | null;
  company: string | null;
}

const isConfidentPairing = (row: LeadPairingRow): boolean => {
  if (row.pairing.state !== "paired" || !row.pairing.lead) return false;
  if (typeof row.pairing.toConfirm !== "boolean") {
    throw new Error(`lead-service pairing for CRM contact ${row.crmContact.id} carries no toConfirm`);
  }
  return !row.pairing.toConfirm;
};

/**
 * One lead-service pairing → merge evidence, or null. lead-service OWNS who in
 * the customer's CRM is one of our leads (its matcher, its Jev judgment, a
 * human ruling). Only a CONFIDENT `paired` verdict merges: a signal, a judgment
 * at or above lead-service's pair threshold, or a human acceptance. A `paired`
 * row with `toConfirm` is a judgment between the thresholds (Brice Jackson's
 * gmail paired by full name at 0.69, 2026-10-10): lead-service still COUNTS it
 * (its stats rule), but the Unibox does not show a guess as one person — the
 * CRM contact stays its own person carrying a `possibleLeads` hint
 * (`possibleLeadOf`). Rejected / unconfirmed / unpaired tie nothing.
 * crm-service runs no matcher of its own.
 */
export function pairingEvidence(row: LeadPairingRow): Evidence | null {
  if (!isConfidentPairing(row)) return null;
  const lead = row.pairing.lead!;
  return {
    kind: "lead_pairing",
    ref: row.crmContact.id,
    displayName: row.crmContact.fullName ?? lead.fullName,
    company: row.crmContact.company ?? lead.company,
    emails: [row.crmContact.email, lead.email].filter((e): e is string => !!e),
    phones: row.crmContact.phone ? [row.crmContact.phone] : [],
    sides: [
      { emails: row.crmContact.email ? [row.crmContact.email] : [], phones: row.crmContact.phone ? [row.crmContact.phone] : [] },
      { emails: lead.email ? [lead.email] : [], phones: [] },
    ],
    judgedBy: "lead-service",
  };
}

/** A `paired` + `toConfirm` row → the hint its CRM contact carries; anything else → null. */
export function possibleLeadOf(row: LeadPairingRow): PossibleLead | null {
  if (row.pairing.state !== "paired" || !row.pairing.lead || isConfidentPairing(row)) return null;
  return {
    crmContactId: row.crmContact.id,
    leadId: row.pairing.lead.leadId ?? null,
    email: normalizeEmail(row.pairing.lead.email),
    fullName: row.pairing.lead.fullName,
    company: row.pairing.lead.company,
  };
}

/** lead-service `GET /orgs/leads/crm-pairings?state=paired`, every page. */
export async function readLeadPairingEvidence(
  identity: SiblingIdentity,
): Promise<EvidenceRead & { possibleLeads: PossibleLead[] }> {
  try {
    const evidence: Evidence[] = [];
    const possibleLeads: PossibleLead[] = [];
    let offset: number | null = 0;
    while (offset !== null) {
      const page: PairingsPage = await siblingGetOk<PairingsPage>(
        "lead",
        `/orgs/leads/crm-pairings?brandId=${encodeURIComponent(identity.brandId)}&state=paired&limit=200&offset=${offset}`,
        identity,
      );
      if (!page.crmConnected) break;
      for (const p of page.pairings) {
        const e = pairingEvidence(p);
        if (e) evidence.push(e);
        const hint = possibleLeadOf(p);
        if (hint) possibleLeads.push(hint);
      }
      offset = page.nextOffset;
    }
    return { kind: "lead_pairing", status: "ok", evidence, possibleLeads, error: null };
  } catch (err) {
    return { kind: "lead_pairing", status: "failed", evidence: [], possibleLeads: [], error: (err as Error).message };
  }
}

// ─── lead-service: one address's standing ───────────────────────────────────

export interface LeadRow {
  id: string;
  leadId: string | null;
  email: string;
  campaignId: string | null;
  standing: (Record<string, unknown> & { state: string; tag?: unknown }) | null;
  /** lead-service's Disqualified mark (v0.83.59+): null or the mark; absent = an older answer. */
  disqualification?: unknown;
  /** lead-service's company block (LEAD-REFONTE-1013): null or the block; absent = an older answer. */
  company?: unknown;
  /** lead-service's human block (LEAD-REFONTE-1013, v0.83.67): null or the block; absent = an older answer. */
  human?: unknown;
}

export type LeadStandingAnswer =
  | { found: false }
  | {
      found: true;
      standing: LeadStanding;
      disqualification: LeadDisqualification | null;
      company: LeadCompanyTags | null;
      human: LeadHumanTags | null;
      leadCampaignId: string;
      leadId: string | null;
      campaignId: string | null;
      campaignIds: string[];
    };

/**
 * PURE: lead-service's Disqualified mark on one row, verbatim. Absent or
 * malformed fails loud (the address reads `unavailable`), never "not
 * disqualified": only lead-service's explicit null means that.
 */
export function disqualificationFromRow(row: LeadRow): LeadDisqualification | null {
  if (row.disqualification === undefined) throw new Error(`lead-service row ${row.id} carries no disqualification`);
  return readMark(row.id, row.disqualification, "disqualification");
}

function readMark(rowId: string, d: unknown, what: string): LeadDisqualification | null {
  if (d === null) return null;
  const m = d as Record<string, unknown>;
  const nullableString = (v: unknown) => v === null || typeof v === "string";
  if (
    typeof d !== "object" ||
    typeof m.level !== "string" ||
    typeof m.source !== "string" ||
    typeof m.statedAt !== "string" ||
    !nullableString(m.offerId) ||
    !nullableString(m.note) ||
    !nullableString(m.statedByUserId)
  ) {
    throw new Error(`lead-service row ${rowId} carries an unreadable ${what}: ${JSON.stringify(d).slice(0, 200)}`);
  }
  return {
    level: m.level,
    offerId: m.offerId as string | null,
    note: m.note as string | null,
    source: m.source,
    statedByUserId: m.statedByUserId as string | null,
    statedAt: m.statedAt,
  };
}

/**
 * PURE: lead-service's company block on one row, verbatim (LEAD-REFONTE-1013:
 * client / signed up / Disqualified "not our target" are COMPANY-level tags).
 * Absent or malformed fails loud, never "no company": only lead-service's
 * explicit null means that.
 */
export function companyTagsFromRow(row: LeadRow): LeadCompanyTags | null {
  const c = row.company;
  if (c === null) return null;
  if (c === undefined) throw new Error(`lead-service row ${row.id} carries no company`);
  const m = c as Record<string, unknown>;
  if (
    typeof c !== "object" ||
    !(m.id === null || typeof m.id === "string") ||
    typeof m.key !== "string" ||
    typeof m.isClient !== "boolean" ||
    typeof m.signedUp !== "boolean" ||
    m.disqualification === undefined
  ) {
    throw new Error(`lead-service row ${row.id} carries an unreadable company: ${JSON.stringify(c).slice(0, 200)}`);
  }
  return {
    id: m.id as string | null,
    key: m.key,
    isClient: m.isClient,
    signedUp: m.signedUp,
    disqualification: readMark(row.id, m.disqualification, "company disqualification"),
  };
}

/** PURE: a cached lead-service answer carries every field the current read relays. */
export function cachedAnswerIsCurrent(payload: unknown): boolean {
  const p = payload as { standing?: { tag?: unknown }; disqualification?: { level?: unknown } | null; company?: unknown; human?: unknown } | null;
  if (typeof p?.standing?.tag !== "string") return false;
  if (p.disqualification === undefined) return false;
  if (p.disqualification !== null && typeof p.disqualification.level !== "string") return false;
  return p.company !== undefined && p.human !== undefined;
}

/**
 * PURE: lead-service's human block on one row, verbatim (opted out / do not
 * contact, wherever the human works). Absent or malformed fails loud; null is
 * lead-service's own "standing unresolved", relayed as null, never as false.
 */
export function humanTagsFromRow(row: LeadRow): LeadHumanTags | null {
  const h = row.human;
  if (h === null) return null;
  if (h === undefined) throw new Error(`lead-service row ${row.id} carries no human`);
  const m = h as Record<string, unknown>;
  if (typeof h !== "object" || typeof m.optedOut !== "boolean" || typeof m.doNotContact !== "boolean") {
    throw new Error(`lead-service row ${row.id} carries an unreadable human: ${JSON.stringify(h).slice(0, 200)}`);
  }
  return { optedOut: m.optedOut, doNotContact: m.doNotContact };
}

/**
 * PURE: one address's answer from ITS rows, in lead-service's `sort=activity`
 * order. The first row's standing is the person's; we never pick a "better" one.
 */
export function standingFromRows(rows: LeadRow[]): LeadStandingAnswer {
  if (rows.length === 0) return { found: false };
  const first = rows[0];
  if (!first.standing || typeof first.standing.state !== "string") {
    throw new Error(`lead-service row ${first.id} carries no standing`);
  }
  if (typeof first.standing.tag !== "string") {
    throw new Error(`lead-service row ${first.id} standing carries no tag`);
  }
  return {
    found: true,
    standing: { ...first.standing, tag: first.standing.tag },
    disqualification: disqualificationFromRow(first),
    company: companyTagsFromRow(first),
    human: humanTagsFromRow(first),
    leadCampaignId: first.id,
    leadId: first.leadId,
    campaignId: first.campaignId,
    campaignIds: [...new Set(rows.map((x) => x.campaignId).filter((c): c is string => !!c))],
  };
}

const leadsPath = (identity: SiblingIdentity, extra: string) =>
  `/orgs/leads?brandId=${encodeURIComponent(identity.brandId)}${extra}&view=basic&sort=activity&status=all`;

/**
 * What lead-service says about one address for the brand. Its own search, in
 * its own `sort=activity` order (newest proving evidence first), filtered to
 * the EXACT address (the search is a substring match).
 */
export async function lookupLeadStanding(identity: SiblingIdentity, email: string): Promise<LeadStandingAnswer> {
  const r = await siblingGet("lead", `${leadsPath(identity, `&q=${encodeURIComponent(email)}`)}&limit=50`, identity);
  if (r.status < 200 || r.status >= 300) {
    throw new Error(`lead-service GET /orgs/leads returned ${r.status}: ${JSON.stringify(r.body).slice(0, 300)}`);
  }
  return standingFromRows(((r.body as { leads: LeadRow[] }).leads ?? []).filter((row) => normalizeEmail(row.email) === email));
}

const LEAD_WALK_PAGE = 2000;

/**
 * The same answer as `lookupLeadStanding`, for MANY addresses in one walk of
 * the brand's whole lead list (same view, same `sort=activity` order, paged).
 * Taking each address's rows in list order gives exactly the rows its own
 * search would return, in the same order. Built for a brand whose cold email
 * wrote to thousands of people: one lookup per address was ~50 ms each, so
 * 17.5k addresses cost ~15 minutes of lead-service searches per build; the
 * walk is ~10 pages. An address absent from the list is not one of our leads.
 * Any page failing fails the walk, loud (every address it was for reads
 * `unavailable`, never a guess); a malformed row fails only its own address.
 */
export async function walkLeadStandings(
  identity: SiblingIdentity,
  wanted: Set<string>,
): Promise<Map<string, LeadStandingAnswer | Error>> {
  const rowsByEmail = new Map<string, LeadRow[]>();
  for (let offset = 0; ; offset += LEAD_WALK_PAGE) {
    const page = await siblingGetOk<{ leads: LeadRow[] }>(
      "lead",
      `${leadsPath(identity, "")}&limit=${LEAD_WALK_PAGE}&offset=${offset}`,
      identity,
    );
    const leads = page.leads ?? [];
    for (const row of leads) {
      const email = normalizeEmail(row.email);
      if (!email || !wanted.has(email)) continue;
      const list = rowsByEmail.get(email) ?? [];
      list.push(row);
      rowsByEmail.set(email, list);
    }
    if (leads.length < LEAD_WALK_PAGE) break;
  }
  const answers = new Map<string, LeadStandingAnswer | Error>();
  for (const email of wanted) {
    try {
      answers.set(email, standingFromRows(rowsByEmail.get(email) ?? []));
    } catch (err) {
      answers.set(email, err as Error);
    }
  }
  return answers;
}

// ─── the brand's OWN addresses: never a person it is in conversation with ───

export interface OwnAddresses {
  status: "ok" | "failed";
  /** Our own sending mailboxes (instantly-service accounts: address + mailbox login). */
  addresses: Set<string>;
  /** The brand's own domain (brand-service), so a colleague is not a prospect. */
  domain: string | null;
  error: string | null;
}

/**
 * Who the brand itself is, from the services that record it: every mailbox we
 * send from (instantly-service) and the brand's domain (brand-service). Those
 * addresses show up in a mailbox's sent mail (warm-up tests, forwards between
 * one's own inboxes) and are not people. A recorded fact, never a guess from
 * the address's shape.
 */
export async function readOwnAddresses(identity: SiblingIdentity): Promise<OwnAddresses> {
  try {
    const [accounts, brand] = await Promise.all([
      siblingGetOk<{ accounts: { email: string | null; mailboxLogin: string | null }[] }>(
        "instantly",
        "/internal/accounts",
        identity,
      ),
      siblingGetOk<{ brand: { domain: string | null } }>(
        "brand",
        `/internal/brands/${encodeURIComponent(identity.brandId)}`,
        identity,
      ),
    ]);
    const addresses = new Set<string>();
    for (const a of accounts.accounts) {
      for (const raw of [a.email, a.mailboxLogin]) {
        const e = normalizeEmail(raw);
        if (e) addresses.add(e);
      }
    }
    const domain = brand.brand.domain ? brand.brand.domain.trim().toLowerCase().replace(/^www\./, "") : null;
    return { status: "ok", addresses, domain, error: null };
  } catch (err) {
    return { status: "failed", addresses: new Set(), domain: null, error: (err as Error).message };
  }
}

export function isOwnAddress(email: string, own: OwnAddresses): boolean {
  if (own.addresses.has(email)) return true;
  return own.domain !== null && email.endsWith(`@${own.domain}`);
}

/**
 * Drop presences that are only the brand itself: every email is an own address
 * and there is no phone. A record mixing an own address with someone else's
 * keeps the other keys and loses the own one.
 */
export function withoutOwnAddresses(read: SourceRead, own: OwnAddresses): { read: SourceRead; excluded: number } {
  let excluded = 0;
  const presences: Presence[] = [];
  for (const p of read.presences) {
    const emails = p.emails.filter((e) => {
      const n = normalizeEmail(e);
      return !(n && isOwnAddress(n, own));
    });
    if (emails.length === 0 && p.phones.length === 0 && p.emails.length > 0) {
      excluded++;
      continue;
    }
    presences.push(emails.length === p.emails.length ? p : { ...p, emails });
  }
  return { read: { ...read, presences }, excluded };
}
