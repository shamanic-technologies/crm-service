/**
 * PURE: read one person's Gmail conversation with the brand's connected mailbox
 * (every Gmail thread with that address, merged, as the Unibox shows it) and
 * say whether the person is waiting for the brand's answer. No database, no
 * model. The email twin of `thread.ts`, same rules:
 *  - the person's mail since the brand's last outbound mail is ONE burst: three
 *    mails in a row are one answer to give, not three;
 *  - ANY outbound mail ends the burst: typed by hand in Gmail, sent by the AI
 *    responder through google-service, from any of the mailbox's addresses;
 *  - a mail between third parties the person is only copied on (`other`) is no
 *    word from them and no answer from us;
 *  - a mail with no text and no subject (an attachment alone) is not counted,
 *    like an uncaptioned photo on WhatsApp.
 */

/** One stored Gmail message of the conversation (people_message_texts, source gmail). */
export interface StoredEmail {
  messageKey: string;
  at: Date | null;
  direction: string | null;
  subject: string | null;
  text: string | null;
  to: string[];
  threadId: string | null;
}

export interface EmailBurstMessage {
  messageId: string;
  at: string;
  subject: string | null;
  text: string;
  to: string[];
  threadId: string | null;
}

export type EmailThreadReading = { kind: "answered" } | { kind: "unanswered"; burst: EmailBurstMessage[] };

/** Max characters of one mail carried forward (10 of them must fit the door's 20k `item`). */
export const EMAIL_TEXT_CAP = 1500;

export function readEmailThreadForReply(messages: StoredEmail[]): EmailThreadReading {
  const ordered = messages
    .filter((m) => m.at !== null && !Number.isNaN(m.at.getTime()))
    .sort((a, b) => a.at!.getTime() - b.at!.getTime() || (a.messageKey < b.messageKey ? -1 : a.messageKey > b.messageKey ? 1 : 0));
  let burst: EmailBurstMessage[] = [];
  for (const m of ordered) {
    if (m.direction === "outbound") {
      burst = [];
      continue;
    }
    if (m.direction !== "inbound") continue;
    const text = (m.text ?? "").trim();
    const subject = m.subject?.trim() || null;
    if (!text && !subject) continue;
    burst.push({
      messageId: m.messageKey,
      at: m.at!.toISOString(),
      subject,
      text: (text || subject || "").slice(0, EMAIL_TEXT_CAP),
      to: m.to,
      threadId: m.threadId,
    });
  }
  return burst.length === 0 ? { kind: "answered" } : { kind: "unanswered", burst };
}
