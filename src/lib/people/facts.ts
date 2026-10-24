/**
 * The people FACT FEED: every dated, UNTAGGED thing the client's own accounts
 * say happened to a person, served to lead-service in one total order
 * (`GET /internal/people/facts`). crm-service says WHAT HAPPENED; lead-service
 * owns what it MEANS (the tags). Contract: crm-service#61.
 *
 * Facts are derived from crm-service's own silver (and the Gmail message store)
 * after each people build, and DIFFED against what was already emitted:
 *
 *  - every candidate fact has a NATURAL KEY (the vendor's own record id + what
 *    about it) and a CONTENT HASH. A key never emitted → a new fact. A key
 *    emitted with the same hash → nothing (a re-sync emits 0 facts). A key
 *    emitted with a different hash → `withdrawn` of the old + a new fact.
 *  - a key emitted before and gone now is withdrawn ONLY in a SNAPSHOT family
 *    (a record that can legitimately change: an appointment outcome, a Stripe
 *    charge) AND only while that source is still connected. History families
 *    (stage history, messages, subscription statuses, CSV) never withdraw on
 *    absence. DISCONNECTING A SOURCE STOPS ITS FACTS, IT NEVER WITHDRAWS THEM.
 *  - `occurredAt` is the vendor's own date, null when it gave none, never now().
 *
 * Every fact names its person (`personKey`, emails, phones) at emission time.
 * A person key is not stable: when a build merges or splits people, the facts
 * already emitted change owner and the feed says so with `person_merged` /
 * `person_split` (each old fact in exactly one part).
 *
 * The GoHighLevel funnel facts are built from the SAME evidence query as
 * `/orgs/gohighlevel/funnel-events` (funnel-events.ts `eventsQuery`), so the
 * two can never disagree. Our own outreach (Instantly, self-send) is NOT in the
 * feed: lead-service reads it directly.
 *
 * Emission takes a global advisory lock for its transaction, so feed_seq values
 * commit in order and a reader paging by cursor never skips a fact.
 */

import { createHash } from "node:crypto";
import { and, asc, eq, gt, inArray, sql, type SQL } from "drizzle-orm";
import { db } from "../../db/index.js";
import { humanKeys, people, peopleFacts, personIdAliases, type PeopleFact, type PeopleScope, type Person } from "../../db/schema.js";
import { eventsQuery, type FunnelEventSource } from "../gohighlevel/funnel-events.js";
import { labelEventsQuery, type LabelEventRow } from "../gohighlevel/label-verdicts.js";
import { GHL_SOURCE } from "../gohighlevel/records.js";
import { POSTHOG_SOURCE } from "../posthog/records.js";
import { STRIPE_SOURCE } from "../stripe/records.js";
import { emailKey, keysOf, normalizeEmail, pickPersonKey, type Presence } from "./identity.js";
import type { PersonConnectionTag } from "./connection-tags.js";
import type { PersonOrganization } from "./organizations.js";
import type { PersonRelation } from "./relations.js";
import { voiceNoteText } from "../matrix/voice-notes.js";
import { meetingFactContext, readOrgEvents } from "../calendar/matching.js";
import { meetingCandidateFacts } from "../calendar/meetings.js";
import { isCopilotDestination } from "../copilot/messages.js";
import { creditDateBasis } from "../credit-events/rules.js";
import type { CreditEventType } from "../credit-events/rules.js";

export const FACT_TYPES = [
  "added_to_crm",
  "form_submitted",
  "meeting_booked",
  "meeting_attended",
  "meeting_not_held",
  "deal_status_changed",
  "sale",
  "deal_lost",
  // CRM-WARM-NURTURE-1015: a CRM stage / tag Jev judged as "is or was a paying customer" /
  // "the business judged the person not a fit" (lib/gohighlevel/label-verdicts.ts).
  "client",
  // FORMER-CLIENT-1017: a CRM stage / tag Jev judged as "was a paying customer and stopped" (beside its
  // `client` fact). Stripe states the same with `subscription_changed` status canceled.
  "former_client",
  "disqualified",
  "payment",
  "refund",
  "subscription_changed",
  "website_visit",
  "signup",
  "message_in",
  "message_out",
  // RELATIONSHIP-TAGS-1014: a message the person wrote in one of the brand's
  // messaging GROUPS (never a DM reply to us), and their membership of it.
  "group_message",
  "group_member",
  // CONNECTION-TAGS-1017 / PERSON-ORGANIZATIONS-1017: one per tag a person holds, one per company they
  // speak for (with its professional tags). Snapshot: withdrawn when it no longer holds. lead-service
  // reads them instead of re-deriving the personal / professional split and the company.
  "connection_tag",
  "organization_link",
  // PERSON-RELATIONS-1017: one per person x capacity (personal / professional at a company / company
  // unknown), with ONLY its contact points' emails, phones, keys and tags. Snapshot, like the two above.
  "relation",
  // CREDIT-RAN-OUT-UNIBOX-EVENT-1024: the client's credit with us ran out / came back (billing-service's depletion
  // episodes), stated on every member of that org, staff Unibox scope only (lib/credit-events/).
  "credit_ran_out",
  "credit_restored",
  "person_merged",
  "person_split",
  "withdrawn",
] as const;
export type FactType = (typeof FACT_TYPES)[number];

// `distribute_platform`: retired (see RETIRED_FAMILIES); kept because the feed still serves the facts it stated.
export const FACT_SOURCES = ["gohighlevel", "gmail", "matrix", "stripe", "posthog", "clerk", "csv", "crm", "distribute_platform", "google_calendar", "billing"] as const;
export type FactSource = (typeof FACT_SOURCES)[number];

/**
 * A family groups facts by how their record behaves. SNAPSHOT families are
 * withdrawn when their record disappears (while the source is connected);
 * IMMUTABLE families are emitted once per key and never corrected.
 */
const FAMILIES = {
  ghl_contact: { source: "gohighlevel", snapshot: true, immutable: false },
  ghl_funnel: { source: "gohighlevel", snapshot: true, immutable: false },
  ghl_history: { source: "gohighlevel", snapshot: false, immutable: false },
  matrix_message: { source: "matrix", snapshot: false, immutable: false },
  matrix_membership: { source: "matrix", snapshot: false, immutable: false },
  gmail_message: { source: "gmail", snapshot: false, immutable: false },
  posthog_person: { source: "posthog", snapshot: true, immutable: false },
  posthog_visit: { source: "posthog", snapshot: true, immutable: false },
  stripe_money: { source: "stripe", snapshot: true, immutable: false },
  stripe_subscription: { source: "stripe", snapshot: false, immutable: false },
  clerk_user: { source: "clerk", snapshot: true, immutable: false },
  csv_contact: { source: "csv", snapshot: false, immutable: true },
  crm_connection_tag: { source: "crm", snapshot: true, immutable: false },
  crm_organization: { source: "crm", snapshot: true, immutable: false },
  crm_relation: { source: "crm", snapshot: true, immutable: false },
  // GOOGLE-CALENDAR-MEETING-FACTS-1021: a meeting in a connected Google Calendar with a person of the brand
  // (lib/calendar/meetings.ts). Snapshot: a booking whose attendee is no longer judged the person, or folded
  // into a later booking (a cancel + rebook), is withdrawn.
  calendar_meeting: { source: "google_calendar", snapshot: true, immutable: false },
  // CREDIT-RAN-OUT-UNIBOX-EVENT-1024: one per (billing event, member address); history, stated once, never withdrawn.
  billing_credit: { source: "billing", snapshot: false, immutable: true },
} as const;
export type FactFamily = keyof typeof FAMILIES;

/**
 * Families no candidate is derived for any more. Their live facts are withdrawn
 * (`source_retired`) on the next emission: a retired source states nothing, so
 * nothing it stated stays live. `platform_signup` = distribute.you's signups
 * read from client-service (2026-10-13, crm#124), retired the same day: our own
 * brand plugs its data through the connectors every client can plug (Clerk).
 */
const RETIRED_FAMILIES: ReadonlySet<string> = new Set(["platform_signup"]);

/** Who a fact is about: a presence of the people build, or (CSV) its own keys. */
export interface FactSubject {
  /** `<source>:<stable id>` — the vendor's id, so a reconnect re-finds the person. */
  presence: string | null;
  /** Identity keys the record states (fallback lookup; the person for a standalone record). */
  keys: string[];
  /** A record that is a person on its own when nobody else holds its keys (CSV). */
  standalone: boolean;
  emails: string[];
  phones: string[];
  fullName: string | null;
}

export interface CandidateFact {
  naturalKey: string;
  family: FactFamily;
  type: FactType;
  source: FactSource;
  sourceRef: string;
  sourceContactId: string | null;
  /** crm-service's own contact row id for that source (`contacts.id`); null when there is none (Gmail). */
  crmContactId: string | null;
  occurredAt: string | null;
  dateBasis: string;
  payload: Record<string, unknown>;
  subject: FactSubject;
  /**
   * The record is about NOBODY now (a message the brand's own account posted in
   * a group): never emitted; a live fact an earlier rule filed on someone for it
   * is withdrawn (`subject_changed`).
   */
  unattributed?: boolean;
}

export interface FactPerson {
  personKey: string;
  emails: string[];
  phones: string[];
  fullName: string | null;
  /** The fleet-wide human (human-service) the person is; null when not known. */
  humanId?: string | null;
}

const iso = (v: string | Date | null | undefined): string | null =>
  v === null || v === undefined ? null : new Date(v).toISOString();

/** The content a fact asserts. Same content → same hash → nothing emitted. */
export function contentHash(c: Pick<CandidateFact, "type" | "occurredAt" | "dateBasis" | "payload" | "sourceContactId">): string {
  const stable = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(stable);
    if (v && typeof v === "object" && !(v instanceof Date)) {
      return Object.fromEntries(
        Object.keys(v as object)
          .sort()
          .map((k) => [k, stable((v as Record<string, unknown>)[k])]),
      );
    }
    return v;
  };
  return createHash("sha256")
    .update(JSON.stringify(stable([c.type, c.occurredAt, c.dateBasis, c.sourceContactId, c.payload])))
    .digest("hex");
}

/** The stable id a presence is re-found by across rebuilds and reconnects. */
export function presenceStableKey(p: Presence): string {
  const stable =
    (typeof p.detail.externalId === "string" && p.detail.externalId) ||
    (typeof p.detail.channelHandle === "string" && p.detail.channelHandle) ||
    p.sourceRef;
  return `${p.source}:${stable}`;
}

/** Find the person a subject belongs to now; null = nobody (held, or source gone). */
export class PersonIndex {
  private byPresence = new Map<string, FactPerson>();
  private byKey = new Map<string, FactPerson>();
  /** identity key -> humanId (human-service's answer, `human_keys`): the human of a STANDALONE subject. */
  private humanOfKey = new Map<string, string>();

  /** HUMAN-ID-COVERAGE-1017: a record no person holds (a CSV row) still names its human. */
  setHumans(humanOfKey: Map<string, string>): void {
    this.humanOfKey = humanOfKey;
  }

  constructor(
    rows: (Pick<Person, "personKey" | "emails" | "phones" | "displayName" | "identityKeys" | "presences"> & { humanId?: string | null })[],
  ) {
    for (const r of rows) {
      const person: FactPerson = {
        personKey: r.personKey,
        emails: r.emails as string[],
        phones: r.phones as string[],
        fullName: r.displayName,
        humanId: r.humanId ?? null,
      };
      for (const p of r.presences as Presence[]) this.byPresence.set(presenceStableKey(p), person);
      for (const k of r.identityKeys as string[]) this.byKey.set(k, person);
    }
  }

  resolve(s: Pick<FactSubject, "presence" | "keys" | "standalone" | "emails" | "phones" | "fullName">): FactPerson | null {
    if (s.presence) {
      const hit = this.byPresence.get(s.presence);
      if (hit) return hit;
    }
    for (const k of s.keys) {
      const hit = this.byKey.get(k);
      if (hit) return hit;
    }
    if (s.standalone && s.keys.length > 0) {
      const humanId = [...s.keys].sort().map((k) => this.humanOfKey.get(k)).find((h) => !!h) ?? null;
      return { personKey: pickPersonKey(s.keys), emails: s.emails, phones: s.phones, fullName: s.fullName, humanId };
    }
    return null;
  }
}

/** identity key -> humanId for the org, among `keys` (`human_keys`, refreshed by each people build). */
async function humansOfKeys(tx: Pick<typeof db, "select">, orgId: string, keys: string[]): Promise<Map<string, string>> {
  const out = new Map<string, string>();
  for (let i = 0; i < keys.length; i += 1000) {
    const rows = await tx
      .select({ key: humanKeys.identityKey, humanId: humanKeys.humanId })
      .from(humanKeys)
      .where(and(eq(humanKeys.orgId, orgId), inArray(humanKeys.identityKey, keys.slice(i, i + 1000))));
    for (const r of rows) out.set(r.key, r.humanId);
  }
  return out;
}

/**
 * PURE: a `connection_tag` professional_to_brand for every CSV row no built person holds (a contact of the
 * brand's own CRM nobody talked to yet: not a person of the Unibox, a human of the registry all the same).
 * Keyed on the row's person key (`email:<addr>`), standalone subject, so its humanId comes from `human_keys`.
 */
export function standaloneRegistryCandidates(csv: CandidateFact[], builtKeys: Set<string>, brandId: string): CandidateFact[] {
  const out = new Map<string, CandidateFact>();
  for (const c of csv) {
    if (!c.subject.standalone || c.subject.keys.length === 0 || c.subject.keys.some((k) => builtKeys.has(k))) continue;
    const personKey = pickPersonKey(c.subject.keys);
    out.set(personKey, {
      naturalKey: `crm|connection_tag|${personKey}|professional_to_brand`,
      family: "crm_connection_tag",
      type: "connection_tag",
      source: "crm",
      sourceRef: personKey,
      sourceContactId: null,
      crmContactId: null,
      occurredAt: null,
      dateBasis: "none",
      payload: { tag: "professional_to_brand", userIds: [], brandId, basis: [{ kind: "evidence", ref: "csv_contact" }] },
      subject: c.subject,
    });
  }
  return [...out.values()];
}

// ─── candidates, per source ─────────────────────────────────────────────────

/**
 * PURE: the registry's statements about each person of the build: one `connection_tag` per tag held
 * (people/connection-tags.ts, user corrections applied) and one `organization_link` per company the
 * person speaks for (people/organizations.ts). Keyed on the opaque person id, so a rebuild re-emits
 * nothing; a tag or link that goes is withdrawn (snapshot). Jev's probabilities are NOT in the
 * payload: a re-judgment that keeps the tag is no change.
 */
export function registryCandidates(
  rows: Pick<Person, "personId" | "identityKeys" | "emails" | "phones" | "displayName" | "connectionTags" | "organizations" | "relations">[],
): CandidateFact[] {
  const out: CandidateFact[] = [];
  for (const r of rows) {
    if (!r.personId) continue;
    const personId = r.personId;
    const subject: FactSubject = {
      presence: null,
      keys: r.identityKeys as string[],
      standalone: false,
      emails: r.emails as string[],
      phones: r.phones as string[],
      fullName: r.displayName,
    };
    const base = { source: "crm" as const, sourceRef: personId, sourceContactId: null, crmContactId: null, occurredAt: null, dateBasis: "none", subject };
    for (const t of (r.connectionTags as PersonConnectionTag[] | null) ?? []) {
      out.push({
        ...base,
        naturalKey: `crm|connection_tag|${personId}|${t.tag}`,
        family: "crm_connection_tag",
        type: "connection_tag",
        payload: {
          tag: t.tag,
          userIds: [...t.userIds].sort(),
          brandId: t.brandId,
          basis: t.basis.map((b) => ({ kind: b.kind, ref: b.ref })).sort((a, b) => (`${a.kind}|${a.ref}` < `${b.kind}|${b.ref}` ? -1 : 1)),
        },
      });
    }
    for (const rel of (r.relations as PersonRelation[] | null) ?? []) {
      out.push({
        ...base,
        naturalKey: `crm|relation|${rel.relationKey}`,
        family: "crm_relation",
        type: "relation",
        payload: {
          relationKey: rel.relationKey,
          capacity: rel.capacity,
          companyId: rel.companyId,
          domain: rel.domain,
          tags: rel.tags.map((t) => ({
            tag: t.tag,
            userIds: [...t.userIds].sort(),
            brandId: t.brandId,
            basis: t.basis.map((b) => ({ kind: b.kind, ref: b.ref })).sort((a, b) => (`${a.kind}|${a.ref}` < `${b.kind}|${b.ref}` ? -1 : 1)),
          })),
          contactPoints: rel.contactPoints.map((c) => ({ id: c.id, source: c.source, companyBasis: c.companyBasis })),
          emails: rel.emails,
          phones: rel.phones,
          keys: rel.keys,
        },
      });
    }
    for (const o of (r.organizations as PersonOrganization[] | null) ?? []) {
      out.push({
        ...base,
        naturalKey: `crm|organization_link|${personId}|${o.companyId}`,
        family: "crm_organization",
        type: "organization_link",
        payload: {
          companyId: o.companyId,
          domain: o.domain,
          tags: o.tags.map((t) => t.tag).sort(),
          evidence: [...o.evidence].sort((a, b) => (`${a.kind}|${a.value}|${a.source}` < `${b.kind}|${b.value}|${b.source}` ? -1 : 1)),
        },
      });
    }
  }
  return out;
}

const presenceSubject = (source: string, stableId: string, fullName: string | null = null): FactSubject => ({
  presence: `${source}:${stableId}`,
  keys: [],
  standalone: false,
  emails: [],
  phones: [],
  fullName,
});

async function rows<T>(query: SQL): Promise<T[]> {
  return (await db.execute(query)) as unknown as T[];
}

async function ghlCandidates(orgId: string, brandId: string): Promise<CandidateFact[]> {
  const out: CandidateFact[] = [];

  // added_to_crm — every mirrored GoHighLevel contact, dated by GoHighLevel's own creation date.
  const contactRows = await rows<{
    id: string;
    external_id: string;
    full_name: string | null;
    source_created_at: string | Date | null;
    origin_medium: string | null;
    lead_source: string | null;
    contact_type: string | null;
  }>(sql`
    SELECT id, external_id, full_name, source_created_at, origin_medium, lead_source, contact_type
    FROM contacts
    WHERE org_id = ${orgId} AND brand_id = ${brandId} AND source = ${GHL_SOURCE} AND external_id IS NOT NULL
  `);
  for (const c of contactRows) {
    out.push({
      naturalKey: `gohighlevel|contact|${c.external_id}`,
      family: "ghl_contact",
      type: "added_to_crm",
      source: "gohighlevel",
      sourceRef: c.external_id,
      sourceContactId: c.external_id,
      crmContactId: c.id,
      occurredAt: iso(c.source_created_at),
      dateBasis: "created_at",
      payload: {
        origin: c.origin_medium ?? c.lead_source,
        originMedium: c.origin_medium,
        leadSource: c.lead_source,
        contactType: c.contact_type,
      },
      subject: presenceSubject("gohighlevel", c.external_id, c.full_name),
    });
  }

  // Funnel facts — the SAME evidence rows /orgs/gohighlevel/funnel-events serves.
  const opps = await rows<{ external_id: string; monetary_value: string | null }>(sql`
    SELECT external_id, monetary_value::text AS monetary_value FROM ghl_opportunities
    WHERE org_id = ${orgId} AND brand_id = ${brandId}
  `);
  const valueOf = new Map(opps.map((o) => [o.external_id, o.monetary_value]));
  const events = await rows<{
    contact_id: string;
    external_contact_id: string;
    full_name: string | null;
    step: string;
    occurred_at: string | Date | null;
    date_basis: string;
    source: FunnelEventSource;
    source_id: string;
    calendar_name: string | null;
    appointment_status: string | null;
    starts_at: string | Date | null;
    pipeline_name: string | null;
    stage_name: string | null;
    observed_at: string | Date | null;
    meaning_confidence: number | null;
    form_id: string | null;
    form_name: string | null;
    attribution_medium: string | null;
  }>(eventsQuery(orgId, brandId, null));
  for (const e of events) {
    const at = iso(e.occurred_at);
    let naturalKey: string;
    switch (e.source) {
      case "appointment":
        naturalKey = `gohighlevel|appointment|${e.source_id}|${e.step === "meeting_booked" ? "booked" : "outcome"}`;
        break;
      case "stage_entry":
        naturalKey = `gohighlevel|stage_entry|${e.source_id}|${e.pipeline_name}|${e.stage_name}|${at}`;
        break;
      case "won_status":
      case "lost_status":
        naturalKey = `gohighlevel|status|${e.source_id}|${e.step}|${at}`;
        break;
      default:
        naturalKey = `gohighlevel|${e.source}|${e.source_id}`;
    }
    const payload: Record<string, unknown> = {
      via: e.source,
      calendarName: e.calendar_name,
      startsAt: iso(e.starts_at),
      appointmentStatus: e.appointment_status,
      pipelineName: e.pipeline_name,
      stageName: e.stage_name,
      observedAt: iso(e.observed_at),
      meaningConfidence: e.meaning_confidence === null ? null : Number(e.meaning_confidence),
      formId: e.form_id,
      formName: e.form_name,
      attributionMedium: e.attribution_medium,
    };
    // The booking does not change when the meeting's outcome does: the outcome is its own fact.
    if (e.step === "meeting_booked") delete payload.appointmentStatus;
    if (e.step === "meeting_not_held") payload.reason = e.appointment_status ?? e.stage_name;
    if (e.step === "sale") {
      // GoHighLevel states a deal's value with no currency; the minor amount
      // assumes a 2-decimal currency and the value is also served verbatim.
      const raw = valueOf.get(e.source_id) ?? null;
      payload.amountMinor = raw === null ? null : Math.round(Number(raw) * 100);
      payload.amountVerbatim = raw;
      payload.currency = null;
    }
    out.push({
      naturalKey,
      family: "ghl_funnel",
      type: e.step as FactType,
      source: "gohighlevel",
      sourceRef: e.source_id,
      sourceContactId: e.external_contact_id,
      crmContactId: e.contact_id,
      occurredAt: at,
      dateBasis: e.date_basis,
      payload,
      subject: presenceSubject("gohighlevel", e.external_contact_id, e.full_name),
    });
  }

  // client / disqualified — a stage entry or a tag Jev judged as saying so (label-verdicts.ts,
  // CRM-WARM-NURTURE-1015): the client's words normalized, so a consumer never reads them.
  for (const e of await rows<LabelEventRow>(labelEventsQuery(orgId, brandId))) {
    const at = iso(e.occurred_at);
    out.push({
      naturalKey:
        e.source === "stage_label"
          ? `gohighlevel|stage_label|${e.source_id}|${e.pipeline_name}|${e.stage_name}|${at}|${e.step}`
          : `gohighlevel|contact_tag|${e.source_id}|${e.tag}|${e.step}`,
      family: "ghl_funnel",
      type: e.step,
      source: "gohighlevel",
      sourceRef: e.source_id,
      sourceContactId: e.external_contact_id,
      crmContactId: e.contact_id,
      occurredAt: at,
      dateBasis: e.date_basis,
      payload: {
        via: e.source,
        pipelineName: e.pipeline_name,
        stageName: e.stage_name,
        tag: e.tag,
        verdictConfidence: Number(e.confidence),
        observedAt: iso(e.observed_at),
      },
      subject: presenceSubject("gohighlevel", e.external_contact_id, e.full_name),
    });
  }

  // deal_status_changed — every stage / status an opportunity was observed in.
  const history = await rows<{
    contact_id: string;
    opportunity_external_id: string;
    external_contact_id: string;
    full_name: string | null;
    kind: "stage" | "status";
    value: string | null;
    pipeline_name: string | null;
    stage_name: string | null;
    changed_at: string | Date | null;
    observed_at: string | Date;
  }>(sql`
    SELECT c.id AS contact_id, h.opportunity_external_id, h.external_contact_id, c.full_name, h.kind, h.value,
           h.pipeline_name, h.stage_name, h.changed_at, h.observed_at
    FROM ghl_opportunity_history h
    JOIN contacts c
      ON c.org_id = ${orgId} AND c.brand_id = ${brandId}
     AND c.source = ${GHL_SOURCE} AND c.external_id = h.external_contact_id
    WHERE h.org_id = ${orgId} AND h.brand_id = ${brandId}
    ORDER BY h.observed_at, h.id
  `);
  for (const h of history) {
    const at = iso(h.changed_at);
    out.push({
      naturalKey: `gohighlevel|history|${h.opportunity_external_id}|${h.kind}|${h.value}|${at}`,
      family: "ghl_history",
      type: "deal_status_changed",
      source: "gohighlevel",
      sourceRef: h.opportunity_external_id,
      sourceContactId: h.external_contact_id,
      crmContactId: h.contact_id,
      occurredAt: at,
      dateBasis: h.kind === "stage" ? "stage_entered_at" : "status_changed_at",
      payload: {
        change: h.kind,
        pipelineName: h.pipeline_name,
        stageName: h.stage_name,
        stageId: h.kind === "stage" ? h.value : null,
        status: h.kind === "status" ? h.value : null,
        observedAt: iso(h.observed_at),
      },
      subject: presenceSubject("gohighlevel", h.external_contact_id, h.full_name),
    });
  }
  return out;
}

/** A message's words; a voice note's are its transcript when it has one (SOPHIE-VOICE-1019). */
function messageText(e: { body: string | null; voice_status: string | null; voice_text: string | null }): string | null {
  if (e.body?.trim() || !e.voice_status) return e.body;
  return voiceNoteText({ status: e.voice_status, text: e.voice_text });
}

async function matrixCandidates(orgId: string, brandId: string): Promise<CandidateFact[]> {
  const events = await rows<{
    contact_id: string;
    event_id: string;
    room_id: string;
    sender: string;
    origin_server_ts: string | Date;
    body: string | null;
    msgtype: string | null;
    channel: string;
    channel_handle: string;
    full_name: string | null;
    own_mxid: string;
    voice_status: string | null;
    voice_text: string | null;
  }>(sql`
    SELECT e.event_id, e.room_id, e.sender, e.origin_server_ts,
           e.payload->'content'->>'body' AS body, e.payload->'content'->>'msgtype' AS msgtype,
           v.channel, c.id AS contact_id, c.channel_handle, c.full_name, mc.matrix_user_id AS own_mxid,
           t.status AS voice_status, t.text AS voice_text
    FROM matrix_raw_events e
    JOIN conversations v ON v.connection_id = e.connection_id AND v.room_id = e.room_id
    JOIN contacts c ON c.id = v.contact_id
    JOIN matrix_connections mc ON mc.id = e.connection_id
    LEFT JOIN voice_note_transcripts t ON t.event_id = e.event_id
    WHERE e.org_id = ${orgId} AND e.brand_id = ${brandId} AND e.event_type = 'm.room.message'
  `);
  return events.map((e) => ({
    naturalKey: `matrix|${e.event_id}`,
    family: "matrix_message" as const,
    type: e.sender === e.own_mxid ? ("message_out" as const) : ("message_in" as const),
    source: "matrix" as const,
    sourceRef: e.event_id,
    sourceContactId: e.channel_handle,
    crmContactId: e.contact_id,
    occurredAt: iso(e.origin_server_ts),
    dateBasis: "sent_at",
    payload: { channel: e.channel, threadId: e.room_id, text: messageText(e), msgtype: e.msgtype },
    subject: presenceSubject("matrix", e.channel_handle, e.full_name),
  }));
}

/**
 * The brand's messaging GROUPS (RELATIONSHIP-TAGS-1014): each member's
 * membership, and each message as its WRITER's (`group_message`, never
 * `message_in`: a word in a group is no reply to us). A message the brand's own
 * account posted addresses the group, not a person: it is unattributed.
 */
async function matrixGroupCandidates(orgId: string, brandId: string): Promise<CandidateFact[]> {
  const members = await rows<{
    contact_id: string;
    ghost_mxid: string;
    full_name: string | null;
    room_id: string;
    group_name: string | null;
    channel: string;
    membership: string;
    joined_at: string | Date | null;
  }>(sql`
    SELECT gm.contact_id, gm.ghost_mxid, c.full_name, g.room_id, g.name AS group_name, g.channel,
           gm.membership, gm.joined_at
    FROM matrix_group_members gm
    JOIN matrix_groups g ON g.id = gm.group_id
    JOIN contacts c ON c.id = gm.contact_id
    WHERE gm.org_id = ${orgId} AND gm.brand_id = ${brandId}
  `);
  const out: CandidateFact[] = members.map((m) => ({
    naturalKey: `matrix|member|${m.room_id}|${m.ghost_mxid}`,
    family: "matrix_membership" as const,
    type: "group_member" as const,
    source: "matrix" as const,
    sourceRef: `${m.room_id}|${m.ghost_mxid}`,
    sourceContactId: m.ghost_mxid,
    crmContactId: m.contact_id,
    occurredAt: iso(m.joined_at),
    dateBasis: "joined_at",
    payload: {
      channel: m.channel,
      threadId: m.room_id,
      groupName: m.group_name,
      // join | invite = in the group now; leave / ban = was.
      membership: m.membership,
    },
    subject: presenceSubject("matrix", m.ghost_mxid, m.full_name),
  }));

  const messages = await rows<{
    event_id: string;
    room_id: string;
    sender: string;
    origin_server_ts: string | Date;
    body: string | null;
    msgtype: string | null;
    group_name: string | null;
    channel: string;
    contact_id: string | null;
    full_name: string | null;
  }>(sql`
    SELECT e.event_id, e.room_id, e.sender, e.origin_server_ts,
           e.payload->'content'->>'body' AS body, e.payload->'content'->>'msgtype' AS msgtype,
           g.name AS group_name, g.channel, gm.contact_id, c.full_name
    FROM matrix_raw_events e
    JOIN matrix_groups g ON g.org_id = e.org_id AND g.brand_id = e.brand_id AND g.room_id = e.room_id
    LEFT JOIN matrix_group_members gm ON gm.group_id = g.id AND gm.ghost_mxid = e.sender
    LEFT JOIN contacts c ON c.id = gm.contact_id
    WHERE e.org_id = ${orgId} AND e.brand_id = ${brandId} AND e.event_type = 'm.room.message'
  `);
  for (const e of messages) {
    out.push({
      naturalKey: `matrix|${e.event_id}`,
      family: "matrix_message",
      type: "group_message",
      source: "matrix",
      sourceRef: e.event_id,
      sourceContactId: e.contact_id ? e.sender : null,
      crmContactId: e.contact_id,
      occurredAt: iso(e.origin_server_ts),
      dateBasis: "sent_at",
      payload: { channel: e.channel, threadId: e.room_id, groupName: e.group_name, text: e.body, msgtype: e.msgtype, direction: "inbound" },
      subject: e.contact_id ? presenceSubject("matrix", e.sender, e.full_name) : presenceSubject("matrix-group", e.room_id),
      ...(e.contact_id ? {} : { unattributed: true }),
    });
  }
  return out;
}

/**
 * The client's account events (billing-service credit events, lib/credit-events/feed.ts): one fact per member address
 * the event was tied to, staff Unibox scope only (every other scope: none). Keyed on billing's event id + the address.
 */
export function creditCandidateFacts(
  events: { eventId: string; type: string; creditOrgId: string; episodeId: string; at: Date; orgLabel: string | null; memberEmails: string[] | null }[],
): CandidateFact[] {
  const out: CandidateFact[] = [];
  for (const e of events) {
    for (const raw of e.memberEmails ?? []) {
      const email = normalizeEmail(raw);
      if (!email) continue;
      out.push({
        naturalKey: `billing|${e.eventId}|${email}`,
        family: "billing_credit",
        type: e.type as CreditEventType,
        source: "billing",
        sourceRef: e.eventId,
        sourceContactId: null,
        crmContactId: null,
        occurredAt: iso(e.at),
        dateBasis: creditDateBasis(e.type),
        payload: { accountOrgId: e.creditOrgId, accountName: e.orgLabel, episodeId: e.episodeId, billingEventId: e.eventId },
        subject: { presence: null, keys: [emailKey(email)], standalone: false, emails: [email], phones: [], fullName: null },
      });
    }
  }
  return out;
}

async function creditCandidates(orgId: string, brandId: string): Promise<CandidateFact[]> {
  if (!isCopilotDestination(orgId, brandId)) return [];
  const events = await rows<{
    event_id: string;
    type: string;
    credit_org_id: string;
    episode_id: string;
    at: string | Date;
    org_label: string | null;
    member_emails: string[] | null;
  }>(sql`
    SELECT event_id, type, credit_org_id, episode_id, at, org_label, member_emails FROM credit_events
    WHERE members_resolved_at IS NOT NULL AND jsonb_array_length(member_emails) > 0
  `);
  return creditCandidateFacts(
    events.map((e) => ({
      eventId: e.event_id,
      type: e.type,
      creditOrgId: e.credit_org_id,
      episodeId: e.episode_id,
      at: new Date(e.at),
      orgLabel: e.org_label,
      memberEmails: e.member_emails,
    })),
  );
}

/** Gmail messages from the scope's message store; `other` (a third party in the thread) is not the person. */
/**
 * Meetings in the org's connected Google Calendars with a person of THIS brand (GOOGLE-CALENDAR-MEETING-FACTS-1021):
 * the same `meeting_booked` / `meeting_attended` / `meeting_not_held` facts GoHighLevel appointments state.
 */
async function calendarCandidates(
  orgId: string,
  brandId: string,
  personRows: Pick<Person, "personId" | "displayName" | "company" | "emails" | "identityKeys" | "automated">[],
): Promise<CandidateFact[]> {
  const events = await readOrgEvents(orgId);
  if (events.length === 0) return [];
  const pool = personRows
    .filter((r) => r.personId && !r.automated)
    .map((r) => ({
      personId: r.personId!,
      displayName: r.displayName,
      company: r.company,
      emails: r.emails as string[],
      identityKeys: r.identityKeys as string[],
    }));
  return meetingCandidateFacts(events, await meetingFactContext(orgId, brandId, pool));
}

async function gmailCandidates(scopeId: string): Promise<{ facts: CandidateFact[]; skippedOther: number }> {
  const stored = await rows<{ address: string; message_key: string; item: Record<string, unknown> }>(sql`
    SELECT address, message_key, item FROM people_message_texts
    WHERE scope_id = ${scopeId} AND source = 'gmail' AND item IS NOT NULL
  `);
  const facts: CandidateFact[] = [];
  let skippedOther = 0;
  for (const s of stored) {
    const item = s.item as {
      at: string | null;
      direction: string | null;
      subject: string | null;
      text: string | null;
      from: string | null;
      to: string[];
      ref: { threadId?: string | null };
      textClean: unknown;
    };
    if (item.direction !== "inbound" && item.direction !== "outbound") {
      skippedOther++;
      continue;
    }
    const address = normalizeEmail(s.address) ?? s.address;
    facts.push({
      naturalKey: `gmail|${address}|${s.message_key}`,
      family: "gmail_message",
      type: item.direction === "inbound" ? "message_in" : "message_out",
      source: "gmail",
      sourceRef: s.message_key,
      sourceContactId: null,
      crmContactId: null,
      occurredAt: iso(item.at),
      dateBasis: "sent_at",
      payload: {
        channel: "email",
        threadId: item.ref?.threadId ?? null,
        subject: item.subject,
        text: item.text,
        textClean: item.textClean ?? null,
        from: item.from,
        to: item.to ?? [],
      },
      subject: { presence: `gmail:${address}`, keys: [emailKey(address)], standalone: false, emails: [address], phones: [], fullName: null },
    });
  }
  return { facts, skippedOther };
}

async function posthogCandidates(orgId: string, brandId: string): Promise<CandidateFact[]> {
  const out: CandidateFact[] = [];
  const persons = await rows<{ id: string; external_id: string; full_name: string | null; source_created_at: string | Date | null }>(sql`
    SELECT id, external_id, full_name, source_created_at FROM contacts
    WHERE org_id = ${orgId} AND brand_id = ${brandId} AND source = ${POSTHOG_SOURCE} AND external_id IS NOT NULL
      -- A visitor known only by what they typed (a phone: WA-GIVEN-TRIGGER-1015; a name or a
      -- website: ONBOARDING-IN-UNIBOX-1015) told the brand who they are, they did not sign up.
      AND coalesce(raw_attributes->>'phoneOnly', 'false') <> 'true'
      AND coalesce(raw_attributes->>'notSignup', 'false') <> 'true'
  `);
  for (const p of persons) {
    out.push({
      naturalKey: `posthog|signup|${p.external_id}`,
      family: "posthog_person",
      type: "signup",
      source: "posthog",
      sourceRef: p.external_id,
      sourceContactId: p.external_id,
      crmContactId: p.id,
      occurredAt: iso(p.source_created_at),
      dateBasis: "person_created_at",
      payload: {},
      subject: presenceSubject("posthog", p.external_id, p.full_name),
    });
  }
  const visits = await rows<{
    contact_id: string;
    external_id: string;
    person_id: string;
    full_name: string | null;
    occurred_at: string | Date;
    ended_at: string | Date | null;
    name: string;
    url: string | null;
    pageviews: number | null;
    detail: { sessionId?: string; referrer?: string | null };
  }>(sql`
    SELECT c.id AS contact_id, a.external_id, c.external_id AS person_id, c.full_name, a.occurred_at, a.ended_at,
           a.name, a.url, a.pageviews, a.detail
    FROM posthog_activities a JOIN contacts c ON c.id = a.contact_id
    WHERE a.org_id = ${orgId} AND a.brand_id = ${brandId} AND a.kind = 'visit'
  `);
  for (const v of visits) {
    out.push({
      naturalKey: `posthog|visit|${v.external_id}`,
      family: "posthog_visit",
      type: "website_visit",
      source: "posthog",
      sourceRef: v.external_id,
      sourceContactId: v.person_id,
      crmContactId: v.contact_id,
      occurredAt: iso(v.occurred_at),
      dateBasis: "visit_started_at",
      payload: {
        sessionId: v.detail?.sessionId ?? null,
        pageviews: v.pageviews,
        firstUrl: v.url,
        entryPath: v.name,
        endedAt: iso(v.ended_at),
        referrer: v.detail?.referrer ?? null,
      },
      subject: presenceSubject("posthog", v.person_id, v.full_name),
    });
  }
  return out;
}

/**
 * One `signup` per user of the brand's auth provider, dated by the provider's
 * own creation date (`user_created_at`) — the same fact type PostHog signups
 * use, so lead-service reads both alike. A user deleted in the provider is a
 * snapshot record gone: its signup is withdrawn. A teammate invited into an
 * organization someone else created (`signedUp: false`, auth/provider.ts
 * `isSignup`) stated no signup: none is emitted, a live one is withdrawn.
 */
async function authCandidates(orgId: string, brandId: string, provider: "clerk"): Promise<CandidateFact[]> {
  const users = await rows<{ id: string; external_id: string; full_name: string | null; source_created_at: string | Date | null }>(sql`
    SELECT id, external_id, full_name, source_created_at FROM contacts
    WHERE org_id = ${orgId} AND brand_id = ${brandId} AND source = ${provider} AND external_id IS NOT NULL
      AND COALESCE(raw_attributes->>'signedUp', 'true') <> 'false'
  `);
  return users.map((u) => ({
    naturalKey: `${provider}|signup|${u.external_id}`,
    family: "clerk_user" as const,
    type: "signup" as const,
    source: provider,
    sourceRef: u.external_id,
    sourceContactId: u.external_id,
    crmContactId: u.id,
    occurredAt: iso(u.source_created_at),
    dateBasis: "user_created_at",
    payload: {},
    subject: presenceSubject(provider, u.external_id, u.full_name),
  }));
}

/** Which date a subscription status is dated by — Stripe states no date for most transitions. */
function subscriptionDate(status: string | null, startedAt: string | null, detail: Record<string, unknown>) {
  if (status === "canceled") return { occurredAt: (detail.canceledAt as string | null) ?? null, dateBasis: "canceled_at" };
  if (status === "incomplete_expired") return { occurredAt: (detail.endedAt as string | null) ?? null, dateBasis: "ended_at" };
  if (status === "active" || status === "trialing" || status === "incomplete") return { occurredAt: startedAt, dateBasis: "start_date" };
  return { occurredAt: null, dateBasis: "status_changed_at" };
}

async function stripeCandidates(orgId: string, brandId: string): Promise<CandidateFact[]> {
  const txs = await rows<{
    kind: "payment" | "refund" | "subscription";
    contact_id: string;
    external_id: string;
    external_customer_id: string | null;
    customer_id: string;
    full_name: string | null;
    occurred_at: string | Date;
    amount_minor: string | number | null;
    currency: string | null;
    status: string | null;
    description: string | null;
    detail: Record<string, unknown>;
  }>(sql`
    SELECT t.kind, c.id AS contact_id, t.external_id, t.external_customer_id, c.external_id AS customer_id, c.full_name,
           t.occurred_at, t.amount_minor, t.currency, t.status, t.description, t.detail
    FROM stripe_transactions t JOIN contacts c ON c.id = t.contact_id
    WHERE t.org_id = ${orgId} AND t.brand_id = ${brandId} AND c.external_id IS NOT NULL
  `);
  return txs.map((t): CandidateFact => {
    const amountMinor = t.amount_minor === null ? null : Number(t.amount_minor);
    const base = {
      source: "stripe" as const,
      sourceRef: t.external_id,
      sourceContactId: t.customer_id,
      crmContactId: t.contact_id,
      subject: presenceSubject("stripe", t.customer_id, t.full_name),
    };
    if (t.kind === "subscription") {
      const dated = subscriptionDate(t.status, iso(t.occurred_at), t.detail);
      return {
        ...base,
        naturalKey: `stripe|subscription|${t.external_id}|${t.status}`,
        family: "stripe_subscription",
        type: "subscription_changed",
        ...dated,
        payload: {
          status: t.status,
          amountMinor,
          currency: t.currency,
          interval: (t.detail.interval as string | null) ?? null,
          cancelAtPeriodEnd: t.detail.cancelAtPeriodEnd === true,
        },
      };
    }
    return {
      ...base,
      naturalKey: `stripe|${t.kind}|${t.external_id}`,
      family: "stripe_money",
      type: t.kind,
      occurredAt: iso(t.occurred_at),
      dateBasis: "created",
      payload:
        t.kind === "payment"
          ? {
              amountMinor,
              currency: t.currency,
              status: t.status,
              description: t.description,
              refunded: t.detail.refunded === true,
              amountRefunded: (t.detail.amountRefunded as number | null) ?? null,
            }
          : { amountMinor, currency: t.currency, status: t.status, charge: (t.detail.charge as string | null) ?? null, reason: (t.detail.reason as string | null) ?? null },
    };
  });
}

/** CSV contacts: one `added_to_crm` per person the client imported, emitted once. */
async function csvCandidates(orgId: string, brandId: string): Promise<CandidateFact[]> {
  const csv = await rows<{
    id: string;
    primary_email: string | null;
    phone_e164: string | null;
    full_name: string | null;
    source_row_id: string | null;
    upload_id: string | null;
    filename: string | null;
    uploaded_at: string | Date | null;
  }>(sql`
    SELECT c.id, c.primary_email, c.phone_e164, c.full_name, c.source_row_id,
           u.id AS upload_id, u.filename, u.uploaded_at
    FROM contacts c LEFT JOIN contact_uploads u ON u.id = c.source_upload_id
    WHERE c.org_id = ${orgId} AND c.brand_id = ${brandId} AND c.source = 'csv'
  `);
  const out: CandidateFact[] = [];
  for (const c of csv) {
    const email = normalizeEmail(c.primary_email);
    const keys = keysOf({ emails: email ? [email] : [], phones: c.phone_e164 ? [c.phone_e164] : [] }, null);
    if (keys.length === 0) continue;
    const ref = email ?? c.source_row_id ?? keys[0];
    out.push({
      naturalKey: `csv|${email ? `email:${email}` : `row:${ref}`}`,
      family: "csv_contact",
      type: "added_to_crm",
      source: "csv",
      sourceRef: ref,
      sourceContactId: null,
      crmContactId: c.id,
      occurredAt: iso(c.uploaded_at),
      dateBasis: "uploaded_at",
      payload: { origin: "csv_import", uploadId: c.upload_id, filename: c.filename },
      subject: {
        presence: null,
        keys,
        standalone: true,
        emails: email ? [email] : [],
        phones: keys.filter((k) => k.startsWith("phone:")).map((k) => k.slice(6)),
        fullName: c.full_name,
      },
    });
  }
  return out;
}

/**
 * `<source>|<vendor contact id>` → the crm contact rows that hold it now. A SET:
 * a counterpart who wrote to two linked accounts of one channel is one contact
 * row per account, and a fact naming either row still names a served row.
 */
async function crmContactRows(orgId: string, brandId: string): Promise<Map<string, Set<string>>> {
  const found = await rows<{ id: string; source: string; vendor_id: string }>(sql`
    SELECT id, source, CASE WHEN source = 'matrix' THEN channel_handle ELSE external_id END AS vendor_id
    FROM contacts
    WHERE org_id = ${orgId} AND brand_id = ${brandId}
      AND source IN ('gohighlevel', 'posthog', 'stripe', 'clerk', 'matrix')
  `);
  const out = new Map<string, Set<string>>();
  for (const r of found) {
    if (!r.vendor_id) continue;
    const key = `${r.source}|${r.vendor_id}`;
    out.set(key, (out.get(key) ?? new Set()).add(r.id));
  }
  return out;
}

/** Which of these Stripe object ids a live connection of the brand still mirrors. */
async function mirroredStripeIds(tx: Tx, orgId: string, brandId: string, ids: string[]): Promise<Set<string>> {
  const out = new Set<string>();
  for (let i = 0; i < ids.length; i += 1000) {
    const found = (await tx.execute(sql`
      SELECT DISTINCT external_id FROM stripe_raw_records
      WHERE org_id = ${orgId} AND brand_id = ${brandId}
        AND external_id IN (${sql.join(ids.slice(i, i + 1000).map((id) => sql`${id}`), sql`, `)})
    `)) as unknown as { external_id: string }[];
    for (const r of found) out.add(r.external_id);
  }
  return out;
}

/**
 * Which snapshot sources are connected AND fully synced at least once (so an
 * absent record may be withdrawn). A connection still on its first pass, e.g.
 * right after a reconnect, has not re-mirrored everything yet: nothing is gone.
 */
async function connectedSources(orgId: string, brandId: string): Promise<Set<FactSource>> {
  const [r] = await rows<{ ghl: boolean; posthog: boolean; stripe: boolean; clerk: boolean; calendar: boolean }>(sql`
    SELECT
      EXISTS (SELECT 1 FROM ghl_connections WHERE org_id = ${orgId} AND brand_id = ${brandId} AND last_synced_at IS NOT NULL) AS ghl,
      EXISTS (SELECT 1 FROM posthog_connections WHERE org_id = ${orgId} AND brand_id = ${brandId} AND last_synced_at IS NOT NULL) AS posthog,
      EXISTS (SELECT 1 FROM stripe_connections WHERE org_id = ${orgId} AND brand_id = ${brandId} AND last_synced_at IS NOT NULL) AS stripe,
      EXISTS (SELECT 1 FROM auth_connections WHERE org_id = ${orgId} AND brand_id = ${brandId} AND provider = 'clerk' AND last_synced_at IS NOT NULL) AS clerk,
      -- The org's calendars are mirrored and the feed reached its end once (google-service owns the connection).
      (EXISTS (SELECT 1 FROM calendar_events WHERE org_id = ${orgId})
        AND EXISTS (SELECT 1 FROM calendar_feed_cursors WHERE caught_up_at IS NOT NULL)) AS calendar
  `);
  const out = new Set<FactSource>();
  if (r.ghl) out.add("gohighlevel");
  if (r.posthog) out.add("posthog");
  if (r.stripe) out.add("stripe");
  if (r.clerk) out.add("clerk");
  if (r.calendar) out.add("google_calendar");
  return out;
}

// ─── merges and splits ──────────────────────────────────────────────────────

export interface OwnershipMove {
  factId: string;
  from: string;
  to: string;
}

export interface OwnershipEvents {
  splits: { fromPersonKey: string; parts: { personKey: string; factIds: string[] }[] }[];
  merges: { fromPersonKey: string; intoPersonKey: string }[];
}

/**
 * What a build did to the owners of already-emitted facts. An old key whose
 * facts now sit under 2+ keys is a SPLIT, every one of its facts in exactly one
 * part (a fact nobody holds anymore stays under the old key, as its own part).
 * An old key whose facts all moved to ONE other key is a MERGE into it (a key
 * that only changed name is a merge of one).
 */
export function ownershipEvents(moves: OwnershipMove[]): OwnershipEvents {
  const byFrom = new Map<string, Map<string, string[]>>();
  for (const m of moves) {
    const parts = byFrom.get(m.from) ?? new Map<string, string[]>();
    parts.set(m.to, [...(parts.get(m.to) ?? []), m.factId]);
    byFrom.set(m.from, parts);
  }
  const events: OwnershipEvents = { splits: [], merges: [] };
  for (const from of [...byFrom.keys()].sort()) {
    const parts = byFrom.get(from)!;
    if (parts.size >= 2) {
      events.splits.push({
        fromPersonKey: from,
        parts: [...parts.entries()]
          .sort(([a], [b]) => (a < b ? -1 : 1))
          .map(([personKey, factIds]) => ({ personKey, factIds: [...factIds].sort() })),
      });
    } else {
      const [to] = parts.keys();
      if (to !== from) events.merges.push({ fromPersonKey: from, intoPersonKey: to });
    }
  }
  return events;
}

// ─── emission ───────────────────────────────────────────────────────────────

export interface FactEmissionSummary {
  candidates: number;
  emitted: number;
  unchanged: number;
  corrected: number;
  withdrawnGone: number;
  /** Live facts of a retired family (`source_retired`), or PostHog signups an auth provider supersedes. */
  retired: number;
  /** Facts re-stated because their vendor contact now sits on a new crm contact row. */
  reminted: number;
  /** Facts re-stated because their person's fleet human (human-service) is now known or changed. */
  humanIdentified: number;
  /** Candidates whose subject is nobody in the people build (e.g. the brand's own address). */
  held: number;
  /** Records about nobody (the brand's own posts in a group); live facts filed for them are withdrawn. */
  unattributed: number;
  duplicateKeys: number;
  gmailOtherSkipped: number;
  merged: number;
  split: number;
  bySource: Record<string, number>;
}

const FEED_LOCK = sql`SELECT pg_advisory_xact_lock(hashtext('crm-service.people_facts'))`;

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

function factRow(
  scope: Pick<PeopleScope, "orgId" | "brandId">,
  person: FactPerson,
  c: CandidateFact,
): typeof peopleFacts.$inferInsert {
  return {
    orgId: scope.orgId,
    brandId: scope.brandId,
    personKey: person.personKey,
    emails: person.emails,
    phones: person.phones,
    fullName: person.fullName ?? c.subject.fullName,
    sourceContactId: c.sourceContactId,
    crmContactId: c.crmContactId,
    type: c.type,
    occurredAt: c.occurredAt ? new Date(c.occurredAt) : null,
    dateBasis: c.dateBasis,
    source: c.source,
    sourceRef: c.sourceRef,
    payload: c.payload,
    naturalKey: c.naturalKey,
    family: c.family,
    contentHash: contentHash(c),
    humanId: person.humanId ?? null,
    ownerPersonKey: person.personKey,
    subjectPresence: c.subject.presence,
    subjectKeys: c.subject.keys,
    subjectStandalone: c.subject.standalone,
  };
}

async function insertAll(tx: Tx, values: (typeof peopleFacts.$inferInsert)[]) {
  for (let i = 0; i < values.length; i += 500) await tx.insert(peopleFacts).values(values.slice(i, i + 500));
}

/**
 * Diff the scope's current facts against the feed and append what changed:
 * splits, merges, withdrawals, then new facts, in that order, in ONE
 * transaction under the feed lock.
 */
export async function emitScopeFacts(scope: PeopleScope): Promise<FactEmissionSummary> {
  const { orgId, brandId } = scope;
  return db.transaction(async (tx) => {
    await tx.execute(FEED_LOCK);

    // Everyone the build holds is someone to the feed (RELATIONSHIP-TAGS-1014: no
    // conversation verdict holds a person's facts back any more).
    const personRows = await tx.select().from(people).where(eq(people.scopeId, scope.id));
    const index = new PersonIndex(personRows);

    const [ghl, matrix, matrixGroups, gmail, posthog, stripe, clerk, csv, connected, calendar, credit] = await Promise.all([
      ghlCandidates(orgId, brandId),
      matrixCandidates(orgId, brandId),
      matrixGroupCandidates(orgId, brandId),
      gmailCandidates(scope.id),
      posthogCandidates(orgId, brandId),
      stripeCandidates(orgId, brandId),
      authCandidates(orgId, brandId, "clerk"),
      csvCandidates(orgId, brandId),
      connectedSources(orgId, brandId),
      calendarCandidates(orgId, brandId, personRows),
      creditCandidates(orgId, brandId),
    ]);
    // An auth provider connected = it alone states who signed up (it knows invited
    // teammates and staff; PostHog only knows who was identified). PostHog keeps
    // its visits; its signups are not emitted and live ones are withdrawn.
    const authStatesSignups = connected.has("clerk");
    // The registry's own statements about each person (built, so always "connected").
    connected.add("crm");
    const builtIds = new Set(personRows.map((r) => r.personId).filter((id): id is string => !!id));
    const retiredIds = new Set(
      (
        await tx
          .select({ id: personIdAliases.retiredId })
          .from(personIdAliases)
          .where(and(eq(personIdAliases.orgId, orgId), eq(personIdAliases.brandId, brandId)))
      ).map((r) => r.id),
    );
    // A CSV row no built person holds is a human of the brand's own CRM all the same: professional_to_brand.
    const builtKeys = new Set(personRows.flatMap((r) => r.identityKeys as string[]));
    const registry = [...registryCandidates(personRows), ...standaloneRegistryCandidates(csv, builtKeys, brandId)];
    const csvKeys = new Set(csv.map((c) => pickPersonKey(c.subject.keys)));
    const all = [...ghl, ...matrix, ...matrixGroups, ...gmail.facts, ...posthog, ...stripe, ...clerk, ...csv, ...calendar, ...credit, ...registry].filter(
      (c) => !(authStatesSignups && c.family === "posthog_person"),
    );
    const candidates = new Map<string, CandidateFact>();
    let duplicateKeys = 0;
    for (const c of all) {
      if (candidates.has(c.naturalKey)) duplicateKeys++;
      else candidates.set(c.naturalKey, c);
    }

    // Every DATA fact ever emitted for the brand (meta facts carry no natural key).
    const existing = (await tx
      .select()
      .from(peopleFacts)
      .where(and(eq(peopleFacts.orgId, orgId), eq(peopleFacts.brandId, brandId), sql`${peopleFacts.naturalKey} IS NOT NULL`))
      .orderBy(asc(peopleFacts.feedSeq))) as PeopleFact[];
    const liveByKey = new Map(existing.filter((f) => f.live).map((f) => [f.naturalKey!, f]));

    // The human of every standalone subject (a CSV row no person holds), from human-service's answers.
    const standaloneKeys = new Set<string>();
    for (const c of candidates.values()) if (c.subject.standalone) for (const k of c.subject.keys) standaloneKeys.add(k);
    for (const f of liveByKey.values()) if (f.subjectStandalone) for (const k of (f.subjectKeys as string[] | null) ?? []) standaloneKeys.add(k);
    index.setHumans(await humansOfKeys(tx, orgId, [...standaloneKeys]));

    const subjectOf = (f: PeopleFact) => ({
      presence: f.subjectPresence,
      keys: (f.subjectKeys as string[] | null) ?? [],
      standalone: f.subjectStandalone,
      emails: f.emails as string[],
      phones: f.phones as string[],
      fullName: f.fullName,
    });

    // 1-2. Merges and splits of people already in the feed.
    const moves: OwnershipMove[] = existing.map((f) => ({
      factId: f.factId,
      from: f.ownerPersonKey!,
      to: index.resolve(subjectOf(f))?.personKey ?? f.ownerPersonKey!,
    }));
    const ownership = ownershipEvents(moves);
    const meta: (typeof peopleFacts.$inferInsert)[] = [];
    for (const s of ownership.splits) {
      meta.push({
        orgId,
        brandId,
        personKey: s.fromPersonKey,
        emails: [],
        phones: [],
        fullName: null,
        sourceContactId: null,
        crmContactId: null,
        type: "person_split",
        occurredAt: null,
        dateBasis: "none",
        source: "crm",
        sourceRef: s.fromPersonKey,
        payload: { fromPersonKey: s.fromPersonKey, parts: s.parts },
      });
    }
    const personByKey = new Map<string, FactPerson>();
    for (const r of personRows) {
      personByKey.set(r.personKey, {
        personKey: r.personKey,
        emails: r.emails as string[],
        phones: r.phones as string[],
        fullName: r.displayName,
        humanId: r.humanId ?? null,
      });
    }
    for (const m of ownership.merges) {
      const into = personByKey.get(m.intoPersonKey);
      meta.push({
        orgId,
        brandId,
        personKey: m.intoPersonKey,
        emails: into?.emails ?? [],
        phones: into?.phones ?? [],
        fullName: into?.fullName ?? null,
        humanId: into?.humanId ?? null,
        sourceContactId: null,
        crmContactId: null,
        type: "person_merged",
        occurredAt: null,
        dateBasis: "none",
        source: "crm",
        sourceRef: `${m.fromPersonKey}->${m.intoPersonKey}`,
        payload: { fromPersonKey: m.fromPersonKey, intoPersonKey: m.intoPersonKey },
      });
    }
    await insertAll(tx, meta);
    const moved = moves.filter((m) => m.from !== m.to);
    for (const m of moved) {
      await tx.update(peopleFacts).set({ ownerPersonKey: m.to }).where(eq(peopleFacts.factId, m.factId));
    }
    const ownerNow = new Map(moves.map((m) => [m.factId, m.to]));

    // 3-4. Withdrawals, then new facts.
    const withdrawals: {
      fact: PeopleFact;
      reason:
        | "vendor_record_changed"
        | "vendor_record_gone"
        | "crm_contact_reminted"
        | "source_retired"
        | "signup_stated_by_auth_provider"
        | "human_identified"
        | "subject_changed";
    }[] = [];
    const fresh: (typeof peopleFacts.$inferInsert)[] = [];
    let unchanged = 0;
    let held = 0;
    const bySource: Record<string, number> = {};
    let unattributed = 0;
    for (const c of candidates.values()) {
      const live = liveByKey.get(c.naturalKey);
      if (c.unattributed) {
        if (live) withdrawals.push({ fact: live, reason: "subject_changed" });
        unattributed++;
        continue;
      }
      if (live && (FAMILIES[c.family].immutable || live.contentHash === contentHash(c))) {
        unchanged++;
        continue;
      }
      const person = index.resolve(c.subject);
      if (!person) {
        held++;
        continue;
      }
      if (live) withdrawals.push({ fact: live, reason: "vendor_record_changed" });
      fresh.push(factRow(scope, person, c));
      bySource[c.source] = (bySource[c.source] ?? 0) + 1;
    }
    let withdrawnGone = 0;
    let retired = 0;
    // A brand connects several Stripe accounts: disconnecting ONE drops its
    // mirror (cascade) while the source stays connected. Its facts stop, they
    // are not withdrawn: a Stripe record counts as gone only while an account
    // still mirrors it.
    const stillMirrored = await mirroredStripeIds(
      tx,
      orgId,
      brandId,
      [...liveByKey.entries()]
        .filter(([key, live]) => !candidates.has(key) && FAMILIES[live.family as FactFamily]?.source === "stripe")
        .map(([, live]) => live.sourceRef)
        .filter((ref): ref is string => !!ref),
    );
    for (const [key, live] of liveByKey) {
      if (candidates.has(key)) continue;
      if (authStatesSignups && live.family === "posthog_person") {
        withdrawals.push({ fact: live, reason: "signup_stated_by_auth_provider" });
        retired++;
        continue;
      }
      if (RETIRED_FAMILIES.has(live.family ?? "")) {
        withdrawals.push({ fact: live, reason: "source_retired" });
        retired++;
        continue;
      }
      const family = FAMILIES[live.family as FactFamily];
      if (!family?.snapshot || !connected.has(family.source)) continue;
      // A registry statement goes only when its person is still built and no longer holds it, or was
      // merged into another (retired id). A person missing from ONE build (a source read failed) keeps it.
      // A standalone CSV row's tag (sourceRef = its person key) goes once a built person holds that key
      // (the person's own tags take over) or the row is gone from the CSV.
      const standaloneGone = (live.sourceRef ?? "").includes(":") && (builtKeys.has(live.sourceRef!) || !csvKeys.has(live.sourceRef!));
      if (family.source === "crm" && !builtIds.has(live.sourceRef ?? "") && !retiredIds.has(live.sourceRef ?? "") && !standaloneGone) continue;
      if (family.source === "stripe" && !stillMirrored.has(live.sourceRef ?? "")) continue;
      withdrawals.push({ fact: live, reason: "vendor_record_gone" });
      withdrawnGone++;
    }

    // A vendor contact that now sits on a NEW crm contact row (a disconnect +
    // reconnect re-mints row ids): every live fact still naming the old row is
    // withdrawn and re-stated with the new one, history facts included, so
    // crmContactId is always a row the contacts reads still serve.
    const rowNow = await crmContactRows(orgId, brandId);
    const touched = new Set(withdrawals.map((w) => w.fact.factId));
    let reminted = 0;
    for (const live of liveByKey.values()) {
      if (touched.has(live.factId) || !live.sourceContactId || !live.crmContactId) continue;
      const held = rowNow.get(`${live.source}|${live.sourceContactId}`);
      if (!held || held.has(live.crmContactId)) continue;
      // The row the fact's own candidate names when it is one of them, else the smallest (deterministic).
      const fromCandidate = candidates.get(live.naturalKey!)?.crmContactId;
      const now = fromCandidate && held.has(fromCandidate) ? fromCandidate : [...held].sort()[0];
      withdrawals.push({ fact: live, reason: "crm_contact_reminted" });
      reminted++;
      const person =
        index.resolve({
          presence: live.subjectPresence,
          keys: (live.subjectKeys as string[] | null) ?? [],
          standalone: live.subjectStandalone,
          emails: live.emails as string[],
          phones: live.phones as string[],
          fullName: live.fullName,
        }) ?? personByKey.get(ownerNow.get(live.factId) ?? live.ownerPersonKey!);
      const owner = person?.personKey ?? ownerNow.get(live.factId) ?? live.ownerPersonKey!;
      fresh.push({
        orgId,
        brandId,
        personKey: owner,
        emails: person?.emails ?? (live.emails as string[]),
        phones: person?.phones ?? (live.phones as string[]),
        fullName: person?.fullName ?? live.fullName,
        humanId: person?.humanId ?? live.humanId,
        sourceContactId: live.sourceContactId,
        crmContactId: now,
        type: live.type,
        occurredAt: live.occurredAt,
        dateBasis: live.dateBasis,
        source: live.source,
        sourceRef: live.sourceRef,
        payload: live.payload,
        naturalKey: live.naturalKey,
        family: live.family,
        contentHash: live.contentHash,
        ownerPersonKey: owner,
        subjectPresence: live.subjectPresence,
        subjectKeys: live.subjectKeys,
        subjectStandalone: live.subjectStandalone,
      });
      bySource[live.source] = (bySource[live.source] ?? 0) + 1;
    }

    // 5. A person's fleet human (human-service) known now, or changed (a merge /
    // split there): every live fact of theirs is re-stated carrying it. Served
    // columns are never updated in place (lead-service copies each fact once);
    // the first pass after the column existed is the backfill.
    const restated = new Set(withdrawals.map((w) => w.fact.factId));
    let humanIdentified = 0;
    for (const live of liveByKey.values()) {
      if (restated.has(live.factId)) continue;
      const owner = ownerNow.get(live.factId) ?? live.ownerPersonKey!;
      const person = personByKey.get(owner) ?? (live.subjectStandalone ? index.resolve(subjectOf(live)) : null);
      if (!person?.humanId || person.humanId === live.humanId) continue;
      withdrawals.push({ fact: live, reason: "human_identified" });
      humanIdentified++;
      fresh.push({
        orgId,
        brandId,
        personKey: owner,
        emails: person.emails,
        phones: person.phones,
        fullName: person.fullName ?? live.fullName,
        humanId: person.humanId,
        sourceContactId: live.sourceContactId,
        crmContactId: live.crmContactId,
        type: live.type,
        occurredAt: live.occurredAt,
        dateBasis: live.dateBasis,
        source: live.source,
        sourceRef: live.sourceRef,
        payload: live.payload,
        naturalKey: live.naturalKey,
        family: live.family,
        contentHash: live.contentHash,
        ownerPersonKey: owner,
        subjectPresence: live.subjectPresence,
        subjectKeys: live.subjectKeys,
        subjectStandalone: live.subjectStandalone,
      });
    }

    const withdrawnRows = withdrawals.map(({ fact, reason }): typeof peopleFacts.$inferInsert => {
      const owner = ownerNow.get(fact.factId) ?? fact.ownerPersonKey!;
      const person = personByKey.get(owner);
      return {
        orgId,
        brandId,
        personKey: owner,
        emails: person?.emails ?? (fact.emails as string[]),
        phones: person?.phones ?? (fact.phones as string[]),
        fullName: person?.fullName ?? fact.fullName,
        humanId: fact.humanId,
        sourceContactId: fact.sourceContactId,
        crmContactId: fact.crmContactId,
        type: "withdrawn",
        occurredAt: null,
        dateBasis: "none",
        source: fact.source,
        sourceRef: fact.sourceRef,
        payload: { reason, withdrawnType: fact.type },
        withdrawnOf: fact.factId,
      };
    });
    const ids = withdrawals.map((w) => w.fact.factId);
    for (let i = 0; i < ids.length; i += 1000) {
      await tx.update(peopleFacts).set({ live: false }).where(inArray(peopleFacts.factId, ids.slice(i, i + 1000)));
    }
    await insertAll(tx, withdrawnRows);
    await insertAll(tx, fresh);

    return {
      candidates: candidates.size,
      emitted: fresh.length,
      unchanged,
      corrected: withdrawals.length - withdrawnGone - reminted - retired - humanIdentified,
      unattributed,
      withdrawnGone,
      retired,
      reminted,
      humanIdentified,
      held,
      duplicateKeys,
      gmailOtherSkipped: gmail.skippedOther,
      merged: ownership.merges.length,
      split: ownership.splits.length,
      bySource,
    };
  });
}

// ─── the read ───────────────────────────────────────────────────────────────

export interface Fact {
  factId: string;
  seq: string;
  orgId: string;
  brandId: string;
  personKey: string;
  emails: string[];
  phones: string[];
  fullName: string | null;
  sourceContactId: string | null;
  crmContactId: string | null;
  type: FactType;
  occurredAt: string | null;
  dateBasis: string;
  source: FactSource;
  sourceRef: string;
  payload: Record<string, unknown>;
  withdrawnOf?: string;
  /** The fleet-wide human (human-service) the person was at emission; null before it was known. */
  humanId: string | null;
  /**
   * PERSON-RELATIONS-1017: the CONTACT POINT the fact is about (`<source>:<id>`, byte-equal to a relation's
   * `contactPoints[].id`), so a reader files it under its relation. Null for a CSV row, a registry fact or a
   * bookkeeping fact (withdrawn / merged / split). Read from a column held since the feed began: old facts carry it too.
   */
  contactPoint: string | null;
}

export function toFact(r: PeopleFact): Fact {
  return {
    factId: r.factId,
    seq: String(r.feedSeq),
    orgId: r.orgId,
    brandId: r.brandId,
    personKey: r.personKey,
    emails: r.emails as string[],
    phones: r.phones as string[],
    fullName: r.fullName,
    sourceContactId: r.sourceContactId,
    crmContactId: r.crmContactId,
    type: r.type as FactType,
    occurredAt: r.occurredAt ? r.occurredAt.toISOString() : null,
    dateBasis: r.dateBasis,
    source: r.source as FactSource,
    sourceRef: r.sourceRef,
    payload: r.payload as Record<string, unknown>,
    ...(r.withdrawnOf ? { withdrawnOf: r.withdrawnOf } : {}),
    humanId: r.humanId ?? null,
    contactPoint: r.subjectPresence || null,
  };
}

/** One page of the feed after `since` (exclusive), in feed order. */
export async function readFacts(args: {
  since: number;
  limit: number;
  orgId?: string;
  brandId?: string;
}): Promise<{ facts: Fact[]; nextCursor: string; hasMore: boolean }> {
  const where = [gt(peopleFacts.feedSeq, args.since)];
  if (args.orgId) where.push(eq(peopleFacts.orgId, args.orgId));
  if (args.brandId) where.push(eq(peopleFacts.brandId, args.brandId));
  const page = (await db
    .select()
    .from(peopleFacts)
    .where(and(...where))
    .orderBy(asc(peopleFacts.feedSeq))
    .limit(args.limit + 1)) as PeopleFact[];
  const hasMore = page.length > args.limit;
  const facts = page.slice(0, args.limit).map(toFact);
  return { facts, nextCursor: facts.length ? facts[facts.length - 1].seq : String(args.since), hasMore };
}
