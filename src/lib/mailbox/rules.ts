/**
 * PURE rules of the sending-mailbox source (EVERY-PERSON-ON-THE-THREAD-1109, owner 2026-11-09: « plug our sending
 * mailboxes into the CRM as one more source, like Gmail … not only for the sender of the emails we receive, but also
 * ALL senders and Cc people of what we receive »).
 *
 * One rule for every message, every mailbox, every brand: every address on a message (From, To, Cc, Bcc on what we
 * sent) is a person of each brand the message is filed on, except our own mailbox and our staff. The lead of the
 * sequence the message is filed on keeps its conversation in the cold-email source (instantly), so it is marked
 * `sequenceLead` here: no second presence, no second fact for the same email.
 */

import { normalizeEmail } from "../people/identity.js";
import { isStaffEmail } from "../owner-telegram.js";

export const MAILBOX_SOURCE = "sending_mailbox" as const;
export const MAILBOX_DIRECTIONS = ["in", "out"] as const;
export const ADDRESS_ROLES = ["from", "to", "cc", "bcc"] as const;
export type AddressRole = (typeof ADDRESS_ROLES)[number];

export interface FeedAddress {
  address: string;
  name: string | null;
}

/** One message as instantly-service's `GET /internal/mailbox-messages` serves it (latest version). */
export interface FeedMailboxMessage {
  id: string;
  version: string;
  mailbox: string;
  direction: (typeof MAILBOX_DIRECTIONS)[number];
  kind: string;
  messageId: string | null;
  inReplyTo: string | null;
  references: string[];
  threadKey: string | null;
  occurredAt: string;
  subject: string | null;
  from: FeedAddress | null;
  to: FeedAddress[];
  cc: FeedAddress[];
  bcc: FeedAddress[];
  participants: { email: string; role: AddressRole }[];
  text: string | null;
  textUnavailableReason: string | null;
  sentBy: string | null;
  orgId: string | null;
  brandIds: string[];
  campaignId: string | null;
  instantlyCampaignId: string | null;
  leadEmail: string | null;
}

const isStr = (v: unknown): v is string => typeof v === "string";
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function strOrNull(v: unknown, field: string, id: string): string | null {
  if (v === null || v === undefined) return null;
  if (!isStr(v)) throw new Error(`[crm-service][mailbox] message ${id}: ${field} is not a string`);
  return v;
}

function addresses(v: unknown, field: string, id: string): FeedAddress[] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) throw new Error(`[crm-service][mailbox] message ${id}: ${field} is not a list`);
  return v.map((a) => {
    const r = a as Record<string, unknown>;
    if (!r || !isStr(r.address)) throw new Error(`[crm-service][mailbox] message ${id}: ${field} entry without an address`);
    return { address: r.address, name: strOrNull(r.name, `${field}.name`, id) };
  });
}

/** PURE: one feed row, checked; a row missing what the registry needs fails the page loud (never stored half). */
export function parseFeedMailboxMessage(raw: unknown): FeedMailboxMessage {
  const r = raw as Record<string, unknown>;
  const id = r?.id;
  if (!isStr(id) || !id) throw new Error(`[crm-service][mailbox] feed row without an id: ${JSON.stringify(raw).slice(0, 200)}`);
  if (!isStr(r.version) && typeof r.version !== "number") throw new Error(`[crm-service][mailbox] message ${id}: no version`);
  if (!isStr(r.mailbox) || !r.mailbox.includes("@")) throw new Error(`[crm-service][mailbox] message ${id}: no mailbox`);
  if (!MAILBOX_DIRECTIONS.includes(r.direction as "in")) throw new Error(`[crm-service][mailbox] message ${id}: direction ${JSON.stringify(r.direction)}`);
  if (!isStr(r.kind) || !r.kind) throw new Error(`[crm-service][mailbox] message ${id}: no kind`);
  if (!isStr(r.occurredAt) || Number.isNaN(Date.parse(r.occurredAt))) throw new Error(`[crm-service][mailbox] message ${id}: occurredAt is not a date`);
  const refs = r.references ?? [];
  if (!Array.isArray(refs) || !refs.every(isStr)) throw new Error(`[crm-service][mailbox] message ${id}: references is not a list of ids`);
  const brandIds = r.brandIds ?? [];
  if (!Array.isArray(brandIds) || !brandIds.every(isStr)) throw new Error(`[crm-service][mailbox] message ${id}: brandIds is not a list of ids`);
  const participants = r.participants ?? [];
  if (!Array.isArray(participants)) throw new Error(`[crm-service][mailbox] message ${id}: participants is not a list`);
  const orgId = strOrNull(r.orgId, "orgId", id);
  const from = r.from === null || r.from === undefined ? null : addresses([r.from], "from", id)[0];
  return {
    id,
    version: String(r.version),
    mailbox: r.mailbox,
    direction: r.direction as FeedMailboxMessage["direction"],
    kind: r.kind,
    messageId: strOrNull(r.messageId, "messageId", id),
    inReplyTo: strOrNull(r.inReplyTo, "inReplyTo", id),
    references: refs as string[],
    threadKey: strOrNull(r.threadKey, "threadKey", id),
    occurredAt: r.occurredAt,
    subject: strOrNull(r.subject, "subject", id),
    from,
    to: addresses(r.to, "to", id),
    cc: addresses(r.cc, "cc", id),
    bcc: addresses(r.bcc, "bcc", id),
    participants: participants.map((p) => {
      const x = p as Record<string, unknown>;
      if (!x || !isStr(x.email) || !ADDRESS_ROLES.includes(x.role as AddressRole)) {
        throw new Error(`[crm-service][mailbox] message ${id}: participant ${JSON.stringify(p).slice(0, 120)} malformed`);
      }
      return { email: x.email, role: x.role as AddressRole };
    }),
    text: strOrNull(r.text, "text", id),
    textUnavailableReason: strOrNull(r.textUnavailableReason, "textUnavailableReason", id),
    sentBy: strOrNull(r.sentBy, "sentBy", id),
    // An org id that is not ours to file under (a Clerk id, "legacy") files the message on nobody.
    orgId: orgId && UUID.test(orgId) ? orgId : null,
    brandIds: (brandIds as string[]).filter((b) => UUID.test(b)),
    campaignId: strOrNull(r.campaignId, "campaignId", id),
    instantlyCampaignId: strOrNull(r.instantlyCampaignId, "instantlyCampaignId", id),
    leadEmail: strOrNull(r.leadEmail, "leadEmail", id),
  };
}

export interface MessagePerson {
  address: string;
  name: string | null;
  role: AddressRole;
  sequenceLead: boolean;
}

const ROLE_RANK: Record<AddressRole, number> = { from: 0, to: 1, cc: 2, bcc: 3 };

/**
 * PURE: every person on a message, one per address (its strongest role: from > to > cc > bcc), our mailbox and our
 * staff left out. Headers (from / to / cc / bcc) and the producer's `participants` list are both read: an address on
 * either is on the message.
 */
export function messagePeople(m: Pick<FeedMailboxMessage, "mailbox" | "from" | "to" | "cc" | "bcc" | "participants" | "leadEmail">): MessagePerson[] {
  const mailbox = normalizeEmail(m.mailbox);
  const lead = m.leadEmail ? normalizeEmail(m.leadEmail) : null;
  const out = new Map<string, MessagePerson>();
  const add = (raw: string, name: string | null, role: AddressRole) => {
    const address = normalizeEmail(raw);
    if (!address || address === mailbox || isStaffEmail(address)) return;
    const prev = out.get(address);
    if (prev && ROLE_RANK[prev.role] <= ROLE_RANK[role]) {
      if (!prev.name && name) prev.name = name;
      return;
    }
    out.set(address, { address, name: name ?? prev?.name ?? null, role, sequenceLead: address === lead });
  };
  if (m.from) add(m.from.address, m.from.name, "from");
  for (const a of m.to) add(a.address, a.name, "to");
  for (const a of m.cc) add(a.address, a.name, "cc");
  for (const a of m.bcc) add(a.address, a.name, "bcc");
  for (const p of m.participants) add(p.email, null, p.role);
  return [...out.values()].sort((a, b) => (a.address < b.address ? -1 : 1));
}

/** PURE: the message names someone besides our mailbox and the sequence's lead: its thread is the registry's to keep. */
export function namesSomeoneElse(people: MessagePerson[]): boolean {
  return people.some((p) => !p.sequenceLead);
}

/**
 * PURE: the fact type a message is for ONE address on it. We sent it: `message_out` (we wrote to them). They sent
 * it: `message_in`. It came in from someone else and they are only on To / Cc: `message_copied` (on their thread as
 * context; never "they wrote to us": lead-service reads `message_in` as the person's own act).
 */
export function factTypeFor(direction: FeedMailboxMessage["direction"], role: AddressRole): "message_in" | "message_out" | "message_copied" {
  if (direction === "out") return "message_out";
  return role === "from" ? "message_in" : "message_copied";
}

/** PURE: the timeline direction of a message for one person on it (inbound = they wrote it; other = another person did). */
export function timelineDirection(direction: FeedMailboxMessage["direction"], role: AddressRole): "inbound" | "outbound" | "other" {
  if (direction === "out") return "outbound";
  return role === "from" ? "inbound" : "other";
}
