/**
 * WHO ACTS ON A PERSON'S GMAIL REPLY: the email path (instantly-service) or us (EMAIL-REPLY-ORPHAN-1027).
 *
 * ⚠️ WHY. The Gmail reply trigger used to leave every mail addressed to one of our sending mailboxes to "the
 * email path", decided on the RECIPIENT alone. instantly-service acts on a mail only when it holds a sequence
 * with the person it can file the mail on. 2026-10-27: pabitrahalder1979@gmail.com answered kevin@distribute.you
 * in a thread the owner opened by hand (no sequence): skipped here as theirs, never filed there, nobody answered
 * (17 such skips since 2026-10-15, 2 of them dropped by both). Now the email path STATES which mails it acts on
 * (`POST /orgs/reply-ownership`, its own rule), so the two halves can neither both decline nor both act.
 *
 * A mail is handed off only when the email path ACTS on it (`HANDED_OFF_REASONS`: it holds the person's
 * sequence). `our_own_mail` (the sender is a staff address or a domain we send from) is the email path saying
 * "nobody to answer there", not an act: this side's own rules decide it (own team, automated, Jev), so a staff
 * test reply to a staff mailbox still fires. An unreadable or malformed answer throws: never a guess either way.
 */
import { siblingQuery, type SiblingIdentity } from "../people/siblings.js";

export type EmailPathOwner = "email_path" | "none";

/** instantly-service's reasons that mean it files and acts on the mail. */
export const HANDED_OFF_REASONS = new Set(["lead_sequence", "sending_mailbox_sequence", "org_mailbox_sequence"]);

/** The most mails the route takes in one call. */
const MAX_PER_CALL = 200;

export interface EmailPathMail {
  messageId: string;
  from: string;
  to: string[];
  at: string;
}

/** What the email path answered for a burst, stored on the report row (`email_path_answer`). */
export interface EmailPathAnswer {
  askedAt: string;
  /** `email_path` = it acts on at least one mail of the burst: the burst is its. */
  owner: EmailPathOwner;
  messages: { messageId: string; owner: EmailPathOwner; reason: string }[];
}

interface OwnershipResponse {
  messages: { from: string; owner: EmailPathOwner; reason: string }[];
}

/** PURE: the burst's owner from the per-mail answers. Any mail the email path acts on makes the burst its (no double). */
export function burstOwner(answers: { owner: EmailPathOwner; reason: string }[]): EmailPathOwner {
  return answers.some((a) => a.owner === "email_path" && HANDED_OFF_REASONS.has(a.reason)) ? "email_path" : "none";
}

/** Ask instantly-service who acts on each mail of the burst. Throws on any unreadable / malformed answer. */
export async function askEmailPath(identity: SiblingIdentity, mails: EmailPathMail[], now: number = Date.now()): Promise<EmailPathAnswer> {
  if (mails.length === 0) throw new Error("askEmailPath: no mail to ask about");
  const answers: EmailPathAnswer["messages"] = [];
  for (let i = 0; i < mails.length; i += MAX_PER_CALL) {
    const page = mails.slice(i, i + MAX_PER_CALL);
    const res = await siblingQuery<OwnershipResponse>("instantly", "/orgs/reply-ownership", identity, {
      messages: page.map((m) => ({ from: m.from, to: m.to, at: m.at })),
    });
    if (!res || !Array.isArray(res.messages) || res.messages.length !== page.length) {
      throw new Error(`instantly-service POST /orgs/reply-ownership answered ${res?.messages?.length ?? "no"} answers for ${page.length} mails`);
    }
    res.messages.forEach((a, j) => {
      if ((a.owner !== "email_path" && a.owner !== "none") || typeof a.reason !== "string") {
        throw new Error(`instantly-service POST /orgs/reply-ownership answered a malformed answer: ${JSON.stringify(a).slice(0, 200)}`);
      }
      answers.push({ messageId: page[j].messageId, owner: a.owner, reason: a.reason });
    });
  }
  return { askedAt: new Date(now).toISOString(), owner: burstOwner(answers), messages: answers };
}
