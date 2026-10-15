/**
 * THE REPLY TRIGGER ON GMAIL (GMAIL-REPLY-ANY-LEAD-1015): a person who writes to
 * the brand's connected Gmail is reported to campaign-service's trigger door as
 * `positive_reply_received`, exactly like a WhatsApp answer (watch.ts). Who is
 * answered is the answering pipe's strategy at lead-service / campaign-service,
 * never filtered here (owner 2026-10-15, « NE CRÉE PLUS JAMAIS DES CAS
 * PARTICULIERS »). What stays here is FACT: a human wrote it, one report per
 * unanswered burst, history before the watch never reported, the brand's own
 * addresses are not a person writing to the brand, and a cold-email reply
 * belongs to the email path.
 *
 * WHAT IS READ: crm-service's own Gmail store (people/search.ts,
 * `people_message_texts` source gmail), one conversation per (scope, address).
 * The store only holds addresses the scope's people hold, and the freshness
 * watch (people/freshness.ts) re-reads an address within a minute of a new mail
 * (correspondents most recent first + the mailbox's latest messages). Detection
 * runs right after that re-read, for every scope with Gmail connected.
 *
 * RULES OF A THREAD: `email-thread.ts`, pure. Here:
 *  - NEVER HISTORY: `people_scopes.gmail_reply_watch_since` is set at the first
 *    look; a mail sent before it is history (`before_watch`).
 *  - ONE REPORT PER BURST: one row per burst (UNIQUE on its first mail's Gmail id
 *    per brand), and campaign-service gets
 *    `idempotencyKey = crm:gmail:reply:<brandId>:<gmail message id>`.
 *  - A COLD-EMAIL REPLY IS THE EMAIL PATH'S: a mail addressed to one of our
 *    sending mailboxes (instantly-service accounts) is a reply to our cold email;
 *    instantly-service detects it in that mailbox and fires the trigger itself,
 *    so it is recorded `cold_email_path` and never reported here. The mailbox the
 *    person wrote TO decides the owner: the brand's own Gmail = here.
 *  - THE BRAND'S OWN ADDRESSES (a sending mailbox, the brand's domain) are
 *    nobody: `own_team`.
 *  - AN AUTOMATED SENDER (sender_verdicts, Jev, >= 0.75) or an automatic reply
 *    (Jev on the burst, like WhatsApp) is no answer: `automated_reply`.
 *  - GMAIL IS PER ORG, PEOPLE PER BRAND: a mail is reported under the brand(s)
 *    whose people know the person OUTSIDE the shared mailbox (a lead, a CRM
 *    contact, a signup...); when none does, under the ONE brand Jev judged the
 *    conversation most about (conversation_verdicts), else the oldest scope.
 *    Never fanned to every brand of the org.
 */
import { and, eq, gte, inArray, isNull, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  people,
  peopleMessageTexts,
  peopleScopes,
  replyTriggerReports,
  senderVerdicts,
  type PeopleScope,
  type ReplyTriggerReport,
} from "../../db/schema.js";
import { createRun, updateRun } from "../runs-client.js";
import { normalizeEmail, type Presence } from "../people/identity.js";
import { isOwnAddress, readOwnAddresses, type OwnAddresses } from "../people/sources.js";
import {
  CampaignRefusal,
  campaignServiceConfigured,
  FINAL_REFUSAL_STATUSES,
  recordTriggerEvent,
  type DoorIdentity,
} from "../trigger-door.js";
import { readEmailThreadForReply, type EmailBurstMessage, type StoredEmail } from "./email-thread.js";
import {
  AUTOMATED_MIN_CONFIDENCE,
  dueReports,
  judgeBurst,
  MAX_REPORT_MESSAGES,
  POSITIVE_REPLY_TRIGGER,
  rebuildBrandPeople,
  REPLY_LOOKBACK_MS,
  REPLY_REASONS,
  REPLY_STATUS,
  resolveReplyOffer,
  settle,
  type Judgment,
} from "./watch.js";

const SERVICE_NAME = "crm-service";
export const GMAIL_SOURCE = "gmail";
const CHANNEL = "email";

export const GMAIL_REPLY_REASONS = {
  /** Addressed to one of our sending mailboxes: a cold-email reply, the email path reports it. */
  COLD_EMAIL_PATH: "cold_email_path",
} as const;

export const gmailIdempotencyKey = (brandId: string, messageId: string) => `crm:${GMAIL_SOURCE}:reply:${brandId}:${messageId}`;

export interface GmailReplyDetection {
  scopeId: string;
  baseline: boolean;
  threadsRead: number;
  detected: number;
  skipped: { reason: string; address: string }[];
  notOwner: number;
}

/** The scope's stored Gmail conversation with one address, as `email-thread.ts` reads it. */
async function storedConversation(scopeId: string, address: string): Promise<StoredEmail[]> {
  const rows = await db
    .select({
      messageKey: peopleMessageTexts.messageKey,
      at: peopleMessageTexts.at,
      direction: peopleMessageTexts.direction,
      subject: peopleMessageTexts.subject,
      body: peopleMessageTexts.body,
      item: peopleMessageTexts.item,
    })
    .from(peopleMessageTexts)
    .where(and(eq(peopleMessageTexts.scopeId, scopeId), eq(peopleMessageTexts.source, GMAIL_SOURCE), eq(peopleMessageTexts.address, address)));
  return rows.map((r) => {
    const item = (r.item ?? {}) as { to?: unknown; ref?: { threadId?: unknown } };
    return {
      messageKey: r.messageKey,
      at: r.at,
      direction: r.direction,
      subject: r.subject,
      text: r.body,
      to: Array.isArray(item.to) ? item.to.filter((t): t is string => typeof t === "string") : [],
      threadId: typeof item.ref?.threadId === "string" ? item.ref.threadId : null,
    };
  });
}

/**
 * The brand(s) of the org a mail from `address` is reported under (see the file
 * header): every brand whose people know the person outside the shared mailbox,
 * else the one brand Jev judged the conversation most about, else the oldest scope.
 */
export async function gmailOwnerBrands(orgId: string, address: string): Promise<Set<string>> {
  const holders = (await db.execute(sql`
    SELECT p.brand_id, p.presences, s.created_at, v.brand_probability
    FROM people p
    JOIN people_scopes s ON s.id = p.scope_id
    LEFT JOIN conversation_verdicts v
      ON v.org_id = p.org_id AND v.brand_id = p.brand_id AND v.conversation_key = ${`gmail:${address}`}
    WHERE p.org_id = ${orgId} AND p.identity_keys @> ${JSON.stringify([`email:${address}`])}::jsonb
  `)) as unknown as { brand_id: string; presences: Presence[]; created_at: Date | string; brand_probability: number | null }[];
  if (holders.length === 0) return new Set();
  const knownOutside = holders.filter((h) => (h.presences ?? []).some((p) => p.source !== "gmail"));
  if (knownOutside.length > 0) return new Set(knownOutside.map((h) => h.brand_id));
  const ranked = [...holders].sort(
    (a, b) =>
      (b.brand_probability ?? -1) - (a.brand_probability ?? -1) ||
      new Date(a.created_at).getTime() - new Date(b.created_at).getTime() ||
      (a.brand_id < b.brand_id ? -1 : 1),
  );
  return new Set([ranked[0].brand_id]);
}

/**
 * Read every Gmail conversation of this scope that gained a mail from the person
 * in the lookback, and record each unanswered burst once (pending) or skipped
 * with its reason. Never sends anything. `runId` is asked only when a run is
 * needed (a Jev call, the own-addresses read).
 */
export async function detectGmailReplies(
  scope: PeopleScope,
  runId: () => Promise<string>,
  now: number = Date.now(),
): Promise<GmailReplyDetection> {
  const out: GmailReplyDetection = { scopeId: scope.id, baseline: false, threadsRead: 0, detected: 0, skipped: [], notOwner: 0 };
  if (!scope.gmailReplyWatchSince) {
    await db
      .update(peopleScopes)
      .set({ gmailReplyWatchSince: new Date(now) })
      .where(and(eq(peopleScopes.id, scope.id), isNull(peopleScopes.gmailReplyWatchSince)));
    out.baseline = true;
    return out;
  }
  const since = scope.gmailReplyWatchSince.getTime();
  const from = new Date(Math.max(since, now - REPLY_LOOKBACK_MS));
  const moved = await db
    .selectDistinct({ address: peopleMessageTexts.address })
    .from(peopleMessageTexts)
    .where(
      and(
        eq(peopleMessageTexts.scopeId, scope.id),
        eq(peopleMessageTexts.source, GMAIL_SOURCE),
        eq(peopleMessageTexts.direction, "inbound"),
        gte(peopleMessageTexts.at, from),
      ),
    );
  if (moved.length === 0) return out;

  let own: OwnAddresses | null = null;
  const ownAddresses = async () => {
    if (own) return own;
    const read = await readOwnAddresses({ orgId: scope.orgId, userId: scope.createdByUserId, runId: await runId(), brandId: scope.brandId });
    // Unreadable = nothing recorded this pass (a cold-email reply must never be reported by mistake).
    if (read.status !== "ok") throw new Error(`own addresses unreadable: ${read.error}`);
    return (own = read);
  };

  for (const { address } of moved) {
    const reading = readEmailThreadForReply(await storedConversation(scope.id, address));
    out.threadsRead += 1;
    if (reading.kind !== "unanswered") continue;

    // What of this burst is already recorded: any row ends it, except an auto-reply or history.
    const existing = await db
      .select()
      .from(replyTriggerReports)
      .where(
        and(
          eq(replyTriggerReports.scopeId, scope.id),
          eq(replyTriggerReports.address, address),
          inArray(replyTriggerReports.anchorEventId, reading.burst.map((m) => m.messageId)),
        ),
      );
    const passThrough: string[] = [REPLY_REASONS.AUTOMATED_REPLY, REPLY_REASONS.BEFORE_WATCH];
    if (existing.some((r) => !passThrough.includes(r.reason ?? ""))) continue;
    const coveredThrough = Math.max(0, ...existing.map((r) => r.lastMessageAt.getTime()));
    const uncovered = reading.burst.filter((m) => Date.parse(m.at) > coveredThrough);
    if (uncovered.length === 0) continue;
    const fresh = uncovered.filter((m) => Date.parse(m.at) >= since);
    const burst = fresh.length > 0 ? fresh : uncovered;

    let status: string = REPLY_STATUS.PENDING;
    let reason: string | null = null;
    let judgment: Judgment | null = null;
    if (fresh.length === 0) {
      status = REPLY_STATUS.SKIPPED;
      reason = REPLY_REASONS.BEFORE_WATCH;
    } else {
      const ours = await ownAddresses();
      const recipients = burst.flatMap((m) => m.to).map((t) => normalizeEmail(t)).filter((t): t is string => !!t);
      if (isOwnAddress(address, ours)) {
        status = REPLY_STATUS.SKIPPED;
        reason = REPLY_REASONS.OWN_TEAM;
      } else if (recipients.some((t) => ours.addresses.has(t))) {
        status = REPLY_STATUS.SKIPPED;
        reason = GMAIL_REPLY_REASONS.COLD_EMAIL_PATH;
      } else {
        if (!(await gmailOwnerBrands(scope.orgId, address)).has(scope.brandId)) {
          // Another brand of the org owns this person: nothing recorded here.
          out.notOwner += 1;
          continue;
        }
        const [verdict] = await db
          .select({ verdict: senderVerdicts.verdict, confidence: senderVerdicts.confidence })
          .from(senderVerdicts)
          .where(and(eq(senderVerdicts.orgId, scope.orgId), eq(senderVerdicts.email, address)));
        if (verdict?.verdict === "automated" && verdict.confidence >= AUTOMATED_MIN_CONFIDENCE) {
          status = REPLY_STATUS.SKIPPED;
          reason = REPLY_REASONS.AUTOMATED_REPLY;
          judgment = { status: "ok", choice: "automated", confidence: verdict.confidence, model: "sender_verdicts", error: null };
        } else {
          judgment = await judgeBurst(
            { orgId: scope.orgId, userId: scope.createdByUserId, brandId: scope.brandId, channel: CHANNEL, where: `gmail scope ${scope.id}` },
            runId,
            burst.map((m) => ({ eventId: m.messageId, at: m.at, text: m.subject ? `${m.subject}\n${m.text}` : m.text })),
          );
          if (judgment.choice === "automated" && (judgment.confidence ?? 0) >= AUTOMATED_MIN_CONFIDENCE) {
            status = REPLY_STATUS.SKIPPED;
            reason = REPLY_REASONS.AUTOMATED_REPLY;
          }
        }
      }
    }
    const inserted = await db
      .insert(replyTriggerReports)
      .values({
        orgId: scope.orgId,
        brandId: scope.brandId,
        source: GMAIL_SOURCE,
        channel: CHANNEL,
        scopeId: scope.id,
        address,
        anchorEventId: burst[0].messageId,
        campaignId: null,
        messages: burst,
        firstMessageAt: new Date(burst[0].at),
        lastMessageAt: new Date(burst[burst.length - 1].at),
        judgment,
        detectedAt: new Date(now),
        status,
        reason,
      })
      .onConflictDoNothing()
      .returning({ id: replyTriggerReports.id });
    if (inserted.length === 0) continue;
    if (status === REPLY_STATUS.PENDING) out.detected += 1;
    else out.skipped.push({ reason: reason!, address });
    console.log(
      `[crm-service][reply-trigger] ${status === REPLY_STATUS.PENDING ? "detected" : `skipped (${reason})`} a Gmail burst of ` +
        `${burst.length} mail(s) from ${address} (brand ${scope.brandId}), first ${burst[0].at}`,
    );
  }
  return out;
}

// ─── delivery ───────────────────────────────────────────────────────────────

/** The burst as the store holds it NOW (it may have grown since detection), from its first mail. */
async function currentGmailBurst(r: ReplyTriggerReport): Promise<EmailBurstMessage[]> {
  const reading = readEmailThreadForReply(await storedConversation(r.scopeId!, r.address!));
  const burst = reading.kind === "unanswered" ? reading.burst : [];
  const from = burst.findIndex((m) => m.messageId === r.anchorEventId);
  return from >= 0 ? burst.slice(from) : (r.messages as EmailBurstMessage[]);
}

/** PURE: the door's body for a Gmail burst (campaign-service `RecordTriggerEventBody`). Absent values OMITTED. */
export function gmailReplyBody(input: {
  brandId: string;
  offerId: string;
  anchorMessageId: string;
  person: { email: string; name: string | null; phone: string | null; personId: string | null };
  messages: EmailBurstMessage[];
}): Record<string, unknown> {
  const person: Record<string, unknown> = { email: input.person.email };
  if (input.person.name) person.name = input.person.name.slice(0, 300);
  if (input.person.phone) person.phone = input.person.phone.slice(0, 50);
  const messages = input.messages.slice(-MAX_REPORT_MESSAGES);
  const first = messages[0];
  const last = messages[messages.length - 1];
  return {
    triggerId: POSITIVE_REPLY_TRIGGER,
    brandId: input.brandId,
    offerId: input.offerId,
    idempotencyKey: gmailIdempotencyKey(input.brandId, input.anchorMessageId),
    occurredAt: first.at,
    person,
    item: {
      kind: "reply",
      source: GMAIL_SOURCE,
      channel: CHANNEL,
      campaignId: null,
      openedBy: "not_campaign",
      personId: input.person.personId,
      address: input.person.email,
      // The Gmail thread of the latest mail: where an answer belongs.
      threadId: last.threadId,
      firstMessageAt: first.at,
      lastMessageAt: last.at,
      messages: messages.map((m) => ({ messageId: m.messageId, at: m.at, subject: m.subject, text: m.text, threadId: m.threadId })),
    },
  };
}

/** Deliver ONE recorded Gmail burst under a run the caller opened. */
export async function deliverGmailReply(r: ReplyTriggerReport, identity: DoorIdentity, now: number): Promise<{ status: string; reason: string | null }> {
  const address = r.address!;
  const [person] = await db
    .select({ personId: people.personId, displayName: people.displayName, phones: people.phones })
    .from(people)
    .where(and(eq(people.orgId, r.orgId), eq(people.brandId, r.brandId), sql`${people.identityKeys} @> ${JSON.stringify([`email:${address}`])}::jsonb`))
    .limit(1);
  if (!person) {
    await settle(r, now, {
      status: REPLY_STATUS.FAILED,
      reason: REPLY_REASONS.PERSON_NOT_BUILT,
      lastError: "the brand's people do not hold this address yet",
      runId: identity.runId,
    });
    return { status: REPLY_STATUS.FAILED, reason: REPLY_REASONS.PERSON_NOT_BUILT };
  }
  const phone = (person.phones as string[])[0] ?? null;
  const who = { personId: person.personId, fullName: person.displayName, email: address, phone };

  let offerId = r.offerId;
  let offerBasis = r.offerBasis;
  try {
    if (!offerId) ({ offerId, offerBasis } = await resolveReplyOffer(identity, r));
  } catch (err) {
    await settle(r, now, { ...who, status: REPLY_STATUS.FAILED, reason: REPLY_REASONS.CAMPAIGN_UNREACHABLE, lastError: (err as Error).message.slice(0, 1000), runId: identity.runId });
    return { status: REPLY_STATUS.FAILED, reason: REPLY_REASONS.CAMPAIGN_UNREACHABLE };
  }
  if (!offerId) {
    const lastError = "Jev tagged this conversation with no offer, and the brand has no single active offer";
    console.warn(`[crm-service][reply-trigger] Gmail report ${r.id} (brand ${r.brandId}) not reported: ${lastError}`);
    await settle(r, now, { ...who, status: REPLY_STATUS.FAILED, reason: REPLY_REASONS.OFFER_UNKNOWN, lastError, runId: identity.runId });
    return { status: REPLY_STATUS.FAILED, reason: REPLY_REASONS.OFFER_UNKNOWN };
  }

  const messages = await currentGmailBurst(r);
  const body = gmailReplyBody({
    brandId: r.brandId,
    offerId,
    anchorMessageId: r.anchorEventId,
    person: { email: address, name: person.displayName, phone, personId: person.personId },
    messages,
  });
  try {
    const recorded = await recordTriggerEvent(identity, body);
    const reportedAt = new Date();
    await settle(r, now, {
      ...who,
      offerId,
      offerBasis,
      messages,
      lastMessageAt: new Date(messages[messages.length - 1].at),
      status: REPLY_STATUS.REPORTED,
      reason: null,
      lastError: null,
      runId: identity.runId,
      reportedAt,
      campaignEventId: recorded.eventId,
      campaignRecordedAt: recorded.recordedAt,
      campaignOutcome: recorded.event,
    });
    console.log(
      `[crm-service][reply-trigger] reported ${messages.length} Gmail mail(s) from ${address} (brand ${r.brandId}, offer ${offerId} from ${offerBasis}) ` +
        `as event ${recorded.eventId}${recorded.replayed ? " (replayed)" : ""}: first mail ${messages[0].at}, detected ${r.detectedAt.toISOString()}, reported ${reportedAt.toISOString()}`,
    );
    return { status: REPLY_STATUS.REPORTED, reason: null };
  } catch (err) {
    const final = err instanceof CampaignRefusal && FINAL_REFUSAL_STATUSES.has(err.status);
    const reason = final ? REPLY_REASONS.CAMPAIGN_REFUSED : REPLY_REASONS.CAMPAIGN_UNREACHABLE;
    console.warn(`[crm-service][reply-trigger] Gmail report ${r.id} (brand ${r.brandId}) not reported: ${(err as Error).message}`);
    await settle(r, now, { ...who, offerId, offerBasis, status: REPLY_STATUS.FAILED, reason, lastError: (err as Error).message.slice(0, 1000), runId: identity.runId });
    return { status: REPLY_STATUS.FAILED, reason };
  }
}

let delivering = false;

/** Report every due Gmail burst: one ORG run per scope. A person not built yet rebuilds the scope, then retries. */
export async function deliverDueGmailReplies(
  now: number = Date.now(),
  opts: { rebuild?: (orgId: string, brandId: string) => Promise<void> } = {},
): Promise<{ reportId: string; status: string; reason: string | null }[]> {
  if (!campaignServiceConfigured() || delivering) return [];
  delivering = true;
  try {
    const delivered: { reportId: string; status: string; reason: string | null }[] = [];
    const groups = new Map<string, ReplyTriggerReport[]>();
    for (const r of await dueReports(now, GMAIL_SOURCE)) {
      if (!r.scopeId || !r.address) continue;
      groups.set(r.scopeId, [...(groups.get(r.scopeId) ?? []), r]);
    }
    for (const [scopeId, reports] of groups) {
      const [scope] = await db.select().from(peopleScopes).where(eq(peopleScopes.id, scopeId));
      if (!scope) continue; // the scope was removed: nobody to answer for
      const ids = { orgId: scope.orgId, userId: scope.createdByUserId, brandIds: [scope.brandId] };
      const run = await createRun({ ...ids, serviceName: SERVICE_NAME, taskName: "reply-trigger.report-gmail" });
      const identity = { orgId: scope.orgId, brandId: scope.brandId, userId: scope.createdByUserId, runId: run.id };
      let failed = false;
      const notBuilt: ReplyTriggerReport[] = [];
      for (const r of reports) {
        const outcome = await deliverGmailReply(r, identity, now);
        if (outcome.reason === REPLY_REASONS.PERSON_NOT_BUILT) notBuilt.push(r);
        else if (outcome.status !== REPLY_STATUS.REPORTED) failed = true;
        delivered.push({ reportId: r.id, ...outcome });
      }
      if (notBuilt.length > 0) {
        await (opts.rebuild ?? rebuildBrandPeople)(scope.orgId, scope.brandId);
        for (const stale of notBuilt) {
          const [r] = await db.select().from(replyTriggerReports).where(eq(replyTriggerReports.id, stale.id));
          const outcome = await deliverGmailReply(r, identity, Date.now());
          if (outcome.status !== REPLY_STATUS.REPORTED) failed = true;
          delivered.push({ reportId: r.id, ...outcome });
        }
      }
      await updateRun(run.id, failed ? "failed" : "completed", { ...ids, runId: run.id });
    }
    return delivered;
  } finally {
    delivering = false;
  }
}

/** Detection for one scope under a lazily opened org run (only a Jev call or the own-addresses read opens it). */
export async function detectGmailRepliesWithRun(scope: PeopleScope, now: number = Date.now()): Promise<GmailReplyDetection> {
  let runIdPromise: Promise<string> | null = null;
  const runId = () =>
    (runIdPromise ??= createRun({
      orgId: scope.orgId,
      userId: scope.createdByUserId,
      brandIds: [scope.brandId],
      serviceName: SERVICE_NAME,
      taskName: "reply-trigger.detect-gmail",
    }).then((r) => r.id));
  let failed = false;
  try {
    return await detectGmailReplies(scope, runId, now);
  } catch (err) {
    failed = true;
    throw err;
  } finally {
    if (runIdPromise) {
      const id = await (runIdPromise as Promise<string>).catch(() => null);
      if (id) {
        await updateRun(id, failed ? "failed" : "completed", { orgId: scope.orgId, userId: scope.createdByUserId }).catch((e) =>
          console.error(`[crm-service][reply-trigger] failed to close Gmail detection run ${id}:`, e),
        );
      }
    }
  }
}
