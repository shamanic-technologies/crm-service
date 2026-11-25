/**
 * DISTRY-WEB-CHAT-EMAIL-1117: a visitor of our public site talks with our assistant in the page's chat window
 * (chat-service, one guest conversation per anonymous visitor id). When the visitor gives their EMAIL, chat-service
 * hands the conversation over here (`POST /internal/copilot/web-conversations`):
 *  - every message of the page conversation is stored on the visitor's address under the staff Unibox scope
 *    (`copilot_messages`, channel `web`, session = the conversation id): it is now part of their person's thread, beside
 *    their Gmail, cold email, WhatsApp... (people source `copilot`, timeline, latest message, fact feed `message_in` /
 *    `message_out`, family `web_chat_message`);
 *  - ONE occurrence of `message_received` (a member of "Lead event") is reported to campaign-service's trigger door, on
 *    ONE offer of our brand (lib/offer-pick.ts), carrying the page conversation, so the Lead event campaign of our brand
 *    writes them the next message (by email: the address is all we hold) knowing what was said. Their email reply lands
 *    in the same person's thread like any mail (Gmail / sending mailbox), so the conversation continues there.
 * No send here, no per-channel case in the writer: the page conversation is just more of the person's thread.
 *
 * Delivery waits for the person to be BUILT (the route kicks the staff scope's people build; lead-service only knows a
 * person once their facts are on the feed). Retried with backoff 1 -> 60 min for 24 h; 400 / 422 final. A conversation
 * handed over twice (same address) reports once (`UNIQUE (scope, conversation, address)` + the door's idempotency key);
 * new messages pushed later are stored and shown, never a second Lead event (their next email is its own occurrence).
 */

import { createHash } from "node:crypto";
import { and, eq, gt, inArray, isNull, ne, or } from "drizzle-orm";
import { db } from "../../db/index.js";
import { peopleScopes, webChatHandoffs, type CopilotMessage, type WebChatHandoff } from "../../db/schema.js";
import { accountPersonOf, type AccountPerson } from "../account-offer.js";
import { resolveOccurrenceOffer, type OfferPick } from "../offer-pick.js";
import { afterNextScopeBuild, runScopeBuild } from "../people/build.js";
import { cachedBrandAddresses, isBrandAddress } from "../people/brand-addresses.js";
import { createRun, updateRun } from "../runs-client.js";
import { CampaignRefusal, FINAL_REFUSAL_STATUSES, campaignServiceConfigured, dialablePhone, recordTriggerEvent, type DoorIdentity } from "../trigger-door.js";
import { COPILOT_SENDER_NAME, WEB_CHAT_CHANNEL, copilotDestination, readWebConversation } from "./messages.js";

const SERVICE_NAME = "crm-service";
/**
 * The Lead event member a web hand-off is reported as (the same one an unjudged reply uses). campaign-service records
 * this member as `skipped / no_leg` (no campaign heads it) and runs the answer on the `lead_event` composite it records
 * beside it (`composite:lead_event:<campaignEventId>`): `reported` here = the door accepted it; read the composite for
 * whether a campaign ran (WEB-HANDOFF-LEAD-EVENT-1125).
 */
export const WEB_HANDOFF_TRIGGER = "message_received";
export const WEB_HANDOFF_INTERVAL_MS = Number(process.env.WEB_CHAT_HANDOFF_INTERVAL_MS) || 60_000;
const MAX_BACKOFF_MS = 60 * 60_000;
const RETRY_WINDOW_MS = 24 * 60 * 60_000;
/** The latest lines of the page conversation carried on the occurrence (campaign-service caps `item` at 20,000 chars). */
const MAX_LINES = 40;
const LINE_MAX_CHARS = 2000;
const ITEM_MAX_CHARS = 19_000;

export const WEB_HANDOFF_STATUS = { PENDING: "pending", REPORTED: "reported", FAILED: "failed", SKIPPED: "skipped" } as const;
export const WEB_HANDOFF_REASONS = {
  /** The staff scope's people build has not made the visitor a person yet: rebuilt, retried. */
  PERSON_NOT_BUILT: "person_not_built",
  /**
   * The address is the brand's own (its domain, a sending mailbox, its connected Gmail): the people build never makes
   * it a person (people/sources.ts withoutOwnAddresses), so the hand-off would wait for nothing. Final, never retried.
   */
  OWN_ADDRESS: "own_address",
  OFFER_UNKNOWN: "offer_unknown",
  OFFER_PICK_FAILED: "offer_pick_failed",
  CAMPAIGN_REFUSED: "campaign_refused",
  CAMPAIGN_UNREACHABLE: "campaign_unreachable",
} as const;

export function nextAttemptDue(attempts: number, lastAttemptAt: Date | null): number {
  if (!lastAttemptAt || attempts <= 0) return 0;
  return lastAttemptAt.getTime() + Math.min(60_000 * 2 ** (attempts - 1), MAX_BACKOFF_MS);
}

/** PURE: one occurrence per (conversation, address): a retry replays campaign-service's first event. */
export function webHandoffIdempotencyKey(conversationId: string, email: string): string {
  const who = createHash("sha256").update(email.toLowerCase()).digest("hex").slice(0, 16);
  return `crm:web_chat:${conversationId}:${who}`;
}

export interface WebLine {
  at: string;
  direction: "inbound" | "outbound";
  kind: "message";
  from: string;
  text: string;
  eventId: string;
}

/** PURE: the stored messages as the lines of a thread (visitor = inbound, assistant = outbound). */
export function webLines(rows: Pick<CopilotMessage, "messageId" | "role" | "text" | "sentAt" | "email">[]): WebLine[] {
  return rows.map((m) => {
    const inbound = m.role === "user";
    return {
      at: m.sentAt.toISOString(),
      direction: inbound ? "inbound" : "outbound",
      kind: "message",
      from: inbound ? m.email : COPILOT_SENDER_NAME,
      text: m.text.slice(0, LINE_MAX_CHARS),
      eventId: m.messageId,
    };
  });
}

/** PURE: the item under campaign-service's cap: oldest lines dropped first, then each line cut at 500. */
export function fitWebItem(item: Record<string, unknown> & { thread: WebLine[]; messages: WebLine[] }): Record<string, unknown> {
  const size = (v: unknown) => JSON.stringify(v).length;
  const out = { ...item, thread: [...item.thread] };
  while (out.thread.length > 1 && size(out) > ITEM_MAX_CHARS) out.thread.shift();
  if (size(out) <= ITEM_MAX_CHARS) return out;
  const cut = (l: WebLine) => ({ ...l, text: l.text.slice(0, 500) });
  return { ...out, thread: out.thread.map(cut), messages: out.messages.map(cut) };
}

/** PURE: campaign-service's trigger door body for one hand-off. */
export function webHandoffOccurrenceBody(input: {
  brandId: string;
  offerId: string;
  handoff: Pick<WebChatHandoff, "conversationId" | "visitorId" | "email" | "phone" | "fullName">;
  personId: string | null;
  name: string | null;
  lines: WebLine[];
}): Record<string, unknown> {
  if (input.lines.length === 0) throw new Error(`web conversation ${input.handoff.conversationId} holds no message`);
  const person: Record<string, unknown> = { email: input.handoff.email };
  const name = input.handoff.fullName ?? input.name;
  if (name) person.name = name.slice(0, 300);
  const phone = dialablePhone([input.handoff.phone]);
  if (phone) person.phone = phone;
  const thread = input.lines.slice(-MAX_LINES);
  // What there is to answer: the visitor's words since the assistant last spoke (their whole side when it never did).
  const lastOut = thread.map((l) => l.direction).lastIndexOf("outbound");
  const theirs = thread.slice(lastOut + 1).filter((l) => l.direction === "inbound");
  const messages = theirs.length > 0 ? theirs : thread.filter((l) => l.direction === "inbound").slice(-5);
  const first = input.lines[0];
  const last = input.lines[input.lines.length - 1];
  return {
    triggerId: WEB_HANDOFF_TRIGGER,
    brandId: input.brandId,
    offerId: input.offerId,
    idempotencyKey: webHandoffIdempotencyKey(input.handoff.conversationId, input.handoff.email),
    occurredAt: last.at,
    person,
    item: fitWebItem({
      kind: "web_chat",
      source: "copilot",
      channel: WEB_CHAT_CHANNEL,
      text: "Chatted with our assistant on our website and gave their email to continue the conversation",
      personId: input.personId,
      conversationId: input.handoff.conversationId,
      visitorId: input.handoff.visitorId,
      firstMessageAt: first.at,
      lastMessageAt: last.at,
      messages,
      thread,
    }),
  };
}

/** The staff Unibox scope and who its runs are filed under, or null when the box configures none. */
export async function webHandoffScope(): Promise<{ orgId: string; brandId: string; userId: string; scopeId: string } | null> {
  const d = copilotDestination();
  if (!d) return null;
  const [scope] = await db
    .select({ id: peopleScopes.id, userId: peopleScopes.createdByUserId })
    .from(peopleScopes)
    .where(and(eq(peopleScopes.orgId, d.orgId), eq(peopleScopes.brandId, d.brandId)));
  if (!scope) return null;
  return { ...d, userId: scope.userId, scopeId: scope.id };
}

/** Record the hand-off (once per scope x conversation x address). Returns the row and whether it already existed. */
export async function recordWebHandoff(input: {
  orgId: string;
  brandId: string;
  conversationId: string;
  visitorId: string;
  email: string;
  phone: string | null;
  fullName: string | null;
}): Promise<{ handoff: WebChatHandoff; duplicate: boolean }> {
  const [inserted] = await db
    .insert(webChatHandoffs)
    .values({ ...input, status: WEB_HANDOFF_STATUS.PENDING })
    .onConflictDoNothing()
    .returning();
  if (inserted) return { handoff: inserted, duplicate: false };
  const [existing] = await db
    .select()
    .from(webChatHandoffs)
    .where(
      and(
        eq(webChatHandoffs.orgId, input.orgId),
        eq(webChatHandoffs.brandId, input.brandId),
        eq(webChatHandoffs.conversationId, input.conversationId),
        eq(webChatHandoffs.email, input.email),
      ),
    );
  return { handoff: existing, duplicate: true };
}

/**
 * `afterBuild`: the pass runs because a people build just ended; a hand-off that waited for the person to be built is
 * due at once (its backoff was waiting for that build), any other one keeps its backoff.
 */
async function dueHandoffs(orgId: string, brandId: string, now: number, afterBuild = false): Promise<WebChatHandoff[]> {
  const found = await db
    .select()
    .from(webChatHandoffs)
    .where(
      and(
        eq(webChatHandoffs.orgId, orgId),
        eq(webChatHandoffs.brandId, brandId),
        inArray(webChatHandoffs.status, [WEB_HANDOFF_STATUS.PENDING, WEB_HANDOFF_STATUS.FAILED]),
        or(isNull(webChatHandoffs.reason), ne(webChatHandoffs.reason, WEB_HANDOFF_REASONS.CAMPAIGN_REFUSED)),
        gt(webChatHandoffs.detectedAt, new Date(now - RETRY_WINDOW_MS)),
      ),
    )
    .orderBy(webChatHandoffs.detectedAt, webChatHandoffs.id);
  return found.filter(
    (r) => (afterBuild && r.reason === WEB_HANDOFF_REASONS.PERSON_NOT_BUILT) || nextAttemptDue(r.attempts, r.lastAttemptAt) <= now,
  );
}

export interface DeliveredHandoff {
  handoffId: string;
  status: string;
  reason: string | null;
}

/** Report every due hand-off of the staff scope under one org run. */
export async function deliverWebHandoffs(
  scope: { orgId: string; brandId: string; userId: string },
  runId: string,
  now: number = Date.now(),
  afterBuild = false,
): Promise<DeliveredHandoff[]> {
  if (!campaignServiceConfigured()) return [];
  const due = await dueHandoffs(scope.orgId, scope.brandId, now, afterBuild);
  const identity: DoorIdentity = { orgId: scope.orgId, userId: scope.userId, runId, brandId: scope.brandId };
  const settle = (r: WebChatHandoff, set: Partial<WebChatHandoff>) =>
    db
      .update(webChatHandoffs)
      .set({ ...set, attempts: r.attempts + 1, lastAttemptAt: new Date(now), runId })
      .where(eq(webChatHandoffs.id, r.id));
  const out: DeliveredHandoff[] = [];
  for (const r of due) {
    const fail = async (reason: string, error: string) => {
      console.warn(`[crm-service][web-chat] hand-off ${r.id} (${r.email}) not reported (${reason}): ${error}`);
      await settle(r, { status: WEB_HANDOFF_STATUS.FAILED, reason, lastError: error.slice(0, 1000) });
      out.push({ handoffId: r.id, status: WEB_HANDOFF_STATUS.FAILED, reason });
    };
    const who: AccountPerson = await accountPersonOf(scope.orgId, scope.brandId, r.email, null);
    if (!who.personId) {
      // The brand's own address is never a person: say so and stop, never wait for a build that will not make it one.
      let own: boolean;
      try {
        own = isBrandAddress(r.email, await cachedBrandAddresses(identity, now));
      } catch (err) {
        await fail(WEB_HANDOFF_REASONS.PERSON_NOT_BUILT, `not a person yet, and the brand's own addresses are unreadable: ${(err as Error).message}`);
        continue;
      }
      if (own) {
        const error = `${r.email} is an address of the brand itself (its domain, a sending mailbox or its connected mailbox): the people build never makes it a person, so no Lead event is reported`;
        console.warn(`[crm-service][web-chat] hand-off ${r.id} skipped (${WEB_HANDOFF_REASONS.OWN_ADDRESS}): ${error}`);
        await settle(r, { status: WEB_HANDOFF_STATUS.SKIPPED, reason: WEB_HANDOFF_REASONS.OWN_ADDRESS, lastError: error });
        out.push({ handoffId: r.id, status: WEB_HANDOFF_STATUS.SKIPPED, reason: WEB_HANDOFF_REASONS.OWN_ADDRESS });
        continue;
      }
      await fail(WEB_HANDOFF_REASONS.PERSON_NOT_BUILT, "the visitor is not a person of the staff scope yet: waiting for the people build");
      continue;
    }
    const lines = webLines(await readWebConversation(scope.orgId, scope.brandId, r.conversationId));
    let offer: OfferPick;
    try {
      offer = await resolveOccurrenceOffer(identity, {
        ledger: "web_chat",
        reportId: r.id,
        formId: null,
        persisted: { offerId: r.offerId, offerBasis: r.offerBasis, offerVerdict: r.offerVerdict },
        person: { email: r.email, phone: dialablePhone([r.phone]) },
        held:
          who.offerIds.length > 0
            ? { offerIds: who.offerIds, verdict: { via: "person_offer_tags", personId: who.personId, scores: null } }
            : null,
        evidence: {
          what: "A visitor of the brand's website chatted with its AI assistant in the site's chat window and gave their email to continue the conversation.",
          facts: { name: r.fullName ?? who.name, email: r.email, conversation: lines.slice(-MAX_LINES).map((l) => ({ at: l.at, from: l.direction === "inbound" ? "visitor" : "assistant", text: l.text.slice(0, 1000) })) },
          eventOnly: !lines.some((l) => l.direction === "inbound"),
        },
      });
    } catch (err) {
      await fail(WEB_HANDOFF_REASONS.OFFER_PICK_FAILED, `placing the conversation on an offer failed: ${(err as Error).message}`);
      continue;
    }
    if (offer.offerId === null) {
      await fail(WEB_HANDOFF_REASONS.OFFER_UNKNOWN, offer.detail);
      continue;
    }
    const placed = { offerId: offer.offerId, offerBasis: offer.basis, offerVerdict: offer.verdict };
    // Persisted at once (judged once): a campaign-service failure below retries on the same pick.
    await db.update(webChatHandoffs).set(placed).where(eq(webChatHandoffs.id, r.id));
    try {
      const rec = await recordTriggerEvent(
        identity,
        webHandoffOccurrenceBody({ brandId: scope.brandId, offerId: offer.offerId, handoff: r, personId: who.personId, name: who.name, lines }),
      );
      await settle(r, { status: WEB_HANDOFF_STATUS.REPORTED, reason: null, lastError: null, ...placed, campaignEventId: rec.eventId, reportedAt: new Date() });
      console.log(`[crm-service][web-chat] reported hand-off ${r.id} (conversation ${r.conversationId}) as ${WEB_HANDOFF_TRIGGER} on offer ${offer.offerId} (${offer.basis})`);
      out.push({ handoffId: r.id, status: WEB_HANDOFF_STATUS.REPORTED, reason: null });
    } catch (err) {
      const final = err instanceof CampaignRefusal && FINAL_REFUSAL_STATUSES.has(err.status);
      await fail(final ? WEB_HANDOFF_REASONS.CAMPAIGN_REFUSED : WEB_HANDOFF_REASONS.CAMPAIGN_UNREACHABLE, (err as Error).message);
    }
  }
  return out;
}

/**
 * One pass: deliver the due hand-offs. A visitor not built yet rebuilds the staff people and a pass runs the moment
 * that build ENDS (`afterBuild`, the waiting hand-offs due at once). An `afterBuild` pass never kicks another build
 * (a person the build did not make is retried on its backoff, never in a build loop).
 */
export async function runWebHandoffPass(
  now: number = Date.now(),
  opts: { afterBuild?: boolean } = {},
): Promise<{ delivered: DeliveredHandoff[] } | { skipped: "not_configured" | "nothing_due" }> {
  const afterBuild = opts.afterBuild === true;
  const scope = await webHandoffScope();
  if (!scope) return { skipped: "not_configured" };
  if ((await dueHandoffs(scope.orgId, scope.brandId, now, afterBuild)).length === 0) return { skipped: "nothing_due" };
  const run = await createRun({ orgId: scope.orgId, userId: scope.userId, brandIds: [scope.brandId], serviceName: SERVICE_NAME, taskName: "web-chat.handoffs" });
  const runIdentity = { orgId: scope.orgId, userId: scope.userId, runId: run.id, brandIds: [scope.brandId] };
  try {
    const delivered = await deliverWebHandoffs(scope, run.id, now, afterBuild);
    // `WEB_CHAT_HANDOFF_WATCH=off` stops the kick with the loop (the scope's cron build and an owner pass still deliver).
    if (!afterBuild && process.env.WEB_CHAT_HANDOFF_WATCH !== "off" && delivered.some((d) => d.reason === WEB_HANDOFF_REASONS.PERSON_NOT_BUILT)) {
      kickStaffBuild(scope.scopeId, passAfterBuild);
    }
    await updateRun(run.id, delivered.some((d) => d.status === WEB_HANDOFF_STATUS.FAILED) ? "failed" : "completed", runIdentity);
    return { delivered };
  } catch (err) {
    await updateRun(run.id, "failed", runIdentity).catch(() => {});
    throw err;
  }
}

/**
 * Rebuild the staff scope's people, never awaited; `then` runs once a build that STARTED after this call has ended.
 * DISTRY-WEB-CHAT-EMAIL-1117-PERSON: the staff scope builds almost all the time (42k people, minutes per build); `then`
 * used to fire as soon as `runScopeBuild` returned, which is AT ONCE when a build is already running (it only queues a
 * follow-up), so the pass found no person and waited on backoff while the follow-up build made them one: 7 min for
 * a visitor of the site in prod (2026-11-17). Now it waits for the build that can hold the new record.
 */
export function kickStaffBuild(scopeId: string, then?: () => void): void {
  void (async () => {
    const [s] = await db.select().from(peopleScopes).where(eq(peopleScopes.id, scopeId));
    if (!s) return;
    if (then) afterNextScopeBuild(s.id, then);
    await runScopeBuild(s, { followUp: true });
  })().catch((err) => console.error("[crm-service][web-chat] staff people build failed:", err));
}

/** The pass a finished staff build triggers (the route and a pass that found a visitor not built yet). */
export function passAfterBuild(): void {
  webHandoffsNow({ afterBuild: true }).catch((e) => console.error("[crm-service][web-chat] pass after build failed:", e));
}

let running = false;
/** An after-build pass asked while another pass ran: run it once that pass ends (never lost). */
let afterBuildAsked = false;

/** Run one pass now unless one is running. */
export async function webHandoffsNow(opts: { afterBuild?: boolean } = {}): Promise<Awaited<ReturnType<typeof runWebHandoffPass>> | { skipped: "pass_running" }> {
  if (running) {
    if (opts.afterBuild) afterBuildAsked = true;
    return { skipped: "pass_running" };
  }
  running = true;
  try {
    return await runWebHandoffPass(Date.now(), opts);
  } finally {
    running = false;
    if (afterBuildAsked) {
      afterBuildAsked = false;
      passAfterBuild();
    }
  }
}

/** In-process, every WEB_HANDOFF_INTERVAL_MS, first pass 60 s after boot, never two at once. */
export function startWebHandoffWatch(): void {
  if (process.env.WEB_CHAT_HANDOFF_WATCH === "off") return;
  const tick = () => {
    webHandoffsNow()
      .then((r) => {
        if ("delivered" in r && r.delivered.length > 0) console.log(`[crm-service][web-chat] pass: ${JSON.stringify(r.delivered)}`);
      })
      .catch((e) => console.error("[crm-service][web-chat] pass failed:", e));
  };
  setTimeout(() => {
    tick();
    setInterval(tick, WEB_HANDOFF_INTERVAL_MS).unref();
  }, 60_000).unref();
}
