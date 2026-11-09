/**
 * Reading what our sending mailboxes hold with one person (EVERY-PERSON-ON-THE-THREAD-1109): every message of every
 * thread the person is on, for one brand, from crm-service's own bronze (`mailbox_messages`). Shared by Jev's
 * judgment (relevance.ts), the sender sample (automated.ts) and the person's timeline: one read, one picture.
 */

import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { normalizeEmail } from "../people/identity.js";
import { timelineDirection, type AddressRole } from "./rules.js";

export interface MailboxThreadMessage {
  id: string;
  mailbox: string;
  direction: "in" | "out";
  kind: string;
  messageId: string | null;
  threadKey: string | null;
  occurredAt: string;
  subject: string | null;
  from: string | null;
  fromName: string | null;
  to: string[];
  cc: string[];
  bcc: string[];
  participants: { email: string; role: AddressRole }[];
  text: string | null;
  textUnavailableReason: string | null;
  sentBy: string | null;
  campaignId: string | null;
  instantlyCampaignId: string | null;
  leadEmail: string | null;
  /** The person's own role on this message; null = the message is in their thread but does not name them. */
  role: AddressRole | null;
}

interface Row {
  id: string;
  mailbox: string;
  direction: "in" | "out";
  kind: string;
  message_id: string | null;
  thread_key: string | null;
  occurred_at: string | Date;
  subject: string | null;
  from_address: string | null;
  from_name: string | null;
  recipients: { to?: { address: string }[]; cc?: { address: string }[]; bcc?: { address: string }[] };
  participants: { email: string; role: AddressRole }[];
  text: string | null;
  text_unavailable_reason: string | null;
  sent_by: string | null;
  campaign_id: string | null;
  instantly_campaign_id: string | null;
  lead_email: string | null;
  role: AddressRole | null;
}

const addrs = (list: { address: string }[] | undefined) => (list ?? []).map((a) => a.address.trim().toLowerCase());

/**
 * Every message of the threads `addresses` are on (as a person of this brand), oldest first; a message with no thread
 * key counts only when it names them. `role` = the strongest role of any of the addresses on it.
 */
export async function readMailboxThreads(orgId: string, brandId: string, addresses: string[]): Promise<MailboxThreadMessage[]> {
  const emails = [...new Set(addresses.map((a) => normalizeEmail(a)).filter((a): a is string => !!a))];
  if (emails.length === 0) return [];
  const list = sql.join(emails.map((e) => sql`${e}`), sql`, `);
  const rows = (await db.execute(sql`
    WITH mine AS (
      SELECT message_id, thread_key, role FROM mailbox_message_people
      WHERE org_id = ${orgId} AND brand_id = ${brandId} AND address IN (${list}) AND NOT sequence_lead
    ),
    threads AS (SELECT DISTINCT thread_key FROM mine WHERE thread_key IS NOT NULL)
    SELECT m.id, m.mailbox, m.direction, m.kind, m.message_id, m.thread_key, m.occurred_at, m.subject,
           m.from_address, m.from_name, m.recipients, m.participants, m.text, m.text_unavailable_reason, m.sent_by,
           m.campaign_id, m.instantly_campaign_id, m.lead_email,
           (SELECT r.role FROM mine r WHERE r.message_id = m.id
             ORDER BY array_position(ARRAY['from','to','cc','bcc'], r.role) LIMIT 1) AS role
    FROM mailbox_messages m
    -- The scope is the person's own rows (brand-transferable); a thread is one RFC conversation wherever it is filed.
    WHERE m.id IN (SELECT message_id FROM mine) OR m.thread_key IN (SELECT thread_key FROM threads)
    ORDER BY m.occurred_at, m.id
  `)) as unknown as Row[];
  return rows.map((r) => ({
    id: r.id,
    mailbox: r.mailbox,
    direction: r.direction,
    kind: r.kind,
    messageId: r.message_id,
    threadKey: r.thread_key,
    occurredAt: new Date(r.occurred_at).toISOString(),
    subject: r.subject,
    from: r.from_address,
    fromName: r.from_name,
    to: addrs(r.recipients?.to),
    cc: addrs(r.recipients?.cc),
    bcc: addrs(r.recipients?.bcc),
    participants: r.participants ?? [],
    text: r.text,
    textUnavailableReason: r.text_unavailable_reason,
    sentBy: r.sent_by,
    campaignId: r.campaign_id,
    instantlyCampaignId: r.instantly_campaign_id,
    leadEmail: r.lead_email,
    role: r.role,
  }));
}

/** PURE: how a message reads from the person's side (inbound = they wrote it; other = someone else did). */
export function directionFor(m: Pick<MailboxThreadMessage, "direction" | "role" | "from">, person: Set<string>): "inbound" | "outbound" | "other" {
  if (m.direction === "out") return "outbound";
  if (m.from && person.has(m.from)) return "inbound";
  return timelineDirection(m.direction, m.role === "from" ? "from" : "to");
}
