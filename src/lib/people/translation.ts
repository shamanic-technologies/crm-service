/**
 * UNIBOX-TRANSLATE-1126 (owner 2026-11-26): the Unibox shows every message of an opened thread in English, the
 * original one click away. « Payé bien sûr sur le compte de l'org en question. »
 *
 * - ON DEMAND only: `GET /orgs/people/timeline?translate=en` translates the messages of the items it serves (the page,
 *   on a paged read). Never the people list, never a background sweep.
 * - A message our local detector reads as English (every paragraph it can read is English) is NEVER sent to the model.
 *   Anything else is (a short "ok" the detector cannot read costs ~$0.0001 and is answered `already_english`).
 * - ONCE per (org, original words): `message_translations`; a later read serves the stored row, no model call.
 * - The model call goes through chat-service `/complete`, on a `people.translate` child run of the READER's request
 *   (org + user of the request): the org whose Unibox it is pays; chat-service declares the cost.
 * - The original is never replaced: the item keeps `subject` / `text`, the English rides beside it in `translation`.
 */
import { createHash } from "node:crypto";
import { and, eq, inArray } from "drizzle-orm";
import { detectAll } from "tinyld";
import { db } from "../../db/index.js";
import { messageTranslations } from "../../db/schema.js";
import { chatComplete, type ChatTrackingHeaders } from "../chat-client.js";
import { translationChatConfig } from "../chat-config.js";
import { lazyChildRun, SUPPORT_RUNS } from "../runs-client.js";
import type { TimelineItem } from "./timeline.js";

export const TRANSLATION_LANGUAGES = ["en"] as const;
export type TranslationLanguage = (typeof TRANSLATION_LANGUAGES)[number];

export interface ItemTranslation {
  language: TranslationLanguage;
  /** translated = `subject` / `text` are the English version; already_english = the original is English (served
   * unchanged); failed = the model could not be asked or answered nonsense (`error`), show the original. */
  status: "translated" | "already_english" | "failed";
  /** ISO 639-1 code of the original's language (null when failed, or when the detector alone decided it was English: "en"). */
  sourceLanguage: string | null;
  /** detector = our local language detector read it as English (no model call); model = the model's answer (stored). */
  basis: "detector" | "model" | null;
  /** What to show in English (the original when already English; null when failed). */
  subject: string | null;
  text: string | null;
  error?: string;
}

export interface TranslationSummary {
  language: TranslationLanguage;
  /** Messages of the served items that carry words. */
  messages: number;
  translated: number;
  alreadyEnglish: number;
  failed: number;
  /** Served from earlier answers (no model call this read). */
  fromStore: number;
  /** Sent to the model on this read. */
  modelCalls: number;
  /** The model that answered this read's calls (null when none was asked). */
  model: string | null;
}

const MAX_PARALLEL = 8;
const CALL_TIMEOUT_MS = 90_000;

/** The words of a message: only `kind: message` items with a subject or a text. */
function wordsOf(item: TimelineItem): { subject: string | null; text: string | null } | null {
  if (item.kind !== "message") return null;
  const subject = item.subject?.trim() ? item.subject : null;
  const text = item.text?.trim() ? item.text : null;
  return subject || text ? { subject, text } : null;
}

export function contentHash(subject: string | null, text: string | null): string {
  return createHash("sha256").update(`${subject ?? ""}\u0000${text ?? ""}`).digest("hex");
}

/**
 * English for sure: at least one paragraph the detector can read, and every paragraph it can read is English
 * (quote markers stripped, so an English reply quoting a German mail goes to the model). Pure, exported for tests.
 */
export function readsAsEnglish(subject: string | null, text: string | null): boolean {
  const blocks = [subject ?? "", ...(text ?? "").split(/\n\s*\n/)]
    .map((b) => b.replace(/^\s*>+\s?/gm, "").trim())
    .filter((b) => b.length > 0);
  let readable = 0;
  for (const block of blocks) {
    const top = detectAll(block)[0];
    if (!top) continue; // too short to say ("ok", a name, a signature)
    readable++;
    if (top.lang !== "en") return false;
  }
  return readable > 0;
}

export const TRANSLATION_SYSTEM_PROMPT = `You translate the messages of one business conversation into the target language for a reader who does not speak the original.

Input: JSON {"targetLanguage": "en", "messages": [{"id", "subject", "text"}]}. "subject" may be null.

Answer with JSON only, exactly this shape:
{"messages": [{"id": "<same id>", "sourceLanguage": "<ISO 639-1 code of the language the message is mostly written in>", "alreadyInTarget": <true when the message is already entirely in the target language>, "subject": "<translated subject, or null when the input subject is null>", "text": "<translated text>"}]}

Rules:
- One output entry per input message, same ids, same order.
- Translate EVERYTHING written in another language, including quoted earlier messages (lines starting with ">"), signatures, greetings and email headers ("Von:", "Gesendet:", "Objet :").
- Keep the exact layout: every line break and blank line of the original stays where it is; keep "> " quote markers, list bullets, links, email addresses, phone numbers, prices and figures unchanged.
- Keep names of people, companies, products and places as written.
- A text mixing languages: translate only the parts not in the target language.
- When alreadyInTarget is true, return subject and text unchanged.
- Translate faithfully: never summarize, shorten, add, explain or answer the message.`;

interface ModelAnswer {
  sourceLanguage: string;
  alreadyInTarget: boolean;
  subject: string | null;
  text: string | null;
}

/** Strict read of the model's JSON for ONE message (id "1"). Throws on any other shape. Pure, exported for tests. */
export function parseModelAnswer(raw: Record<string, unknown> | undefined, content: string, asked: { subject: string | null; text: string | null }): ModelAnswer {
  let json: unknown = raw;
  if (!json) {
    const body = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "");
    json = JSON.parse(body);
  }
  const messages = (json as { messages?: unknown }).messages;
  if (!Array.isArray(messages) || messages.length !== 1) throw new Error("answer must hold exactly one message");
  const m = messages[0] as Record<string, unknown>;
  if (typeof m.sourceLanguage !== "string" || !m.sourceLanguage.trim()) throw new Error("answer has no sourceLanguage");
  if (typeof m.alreadyInTarget !== "boolean") throw new Error("answer has no alreadyInTarget");
  const subject = asked.subject === null ? null : typeof m.subject === "string" ? m.subject : null;
  const text = asked.text === null ? null : typeof m.text === "string" ? m.text : null;
  if (asked.subject !== null && subject === null) throw new Error("answer dropped the subject");
  if (asked.text !== null && text === null) throw new Error("answer dropped the text");
  return { sourceLanguage: m.sourceLanguage.trim().toLowerCase().slice(0, 8), alreadyInTarget: m.alreadyInTarget, subject, text };
}

/** Two reads of the same thread at once ask the model once (per org + words). */
const inFlight = new Map<string, Promise<ModelAnswer & { model: string }>>();

async function pool<T>(tasks: (() => Promise<T>)[], size: number): Promise<T[]> {
  const out: T[] = new Array(tasks.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(size, tasks.length) }, async () => {
      while (next < tasks.length) {
        const i = next++;
        out[i] = await tasks[i]();
      }
    }),
  );
  return out;
}

/**
 * Attach `translation` to every message item that carries words (mutates the items: the original fields stay).
 * Identity = the request's (org pays); `parentRunId` = the request's run.
 */
export async function translateItems(
  items: TimelineItem[],
  language: TranslationLanguage,
  ids: { orgId: string; userId: string; brandId: string; parentRunId: string },
): Promise<TranslationSummary> {
  const summary: TranslationSummary = { language, messages: 0, translated: 0, alreadyEnglish: 0, failed: 0, fromStore: 0, modelCalls: 0, model: null };
  const pending: { item: TimelineItem; words: { subject: string | null; text: string | null }; hash: string }[] = [];
  for (const item of items) {
    const words = wordsOf(item);
    if (!words) continue;
    summary.messages++;
    if (readsAsEnglish(words.subject, words.text)) {
      item.translation = { language, status: "already_english", sourceLanguage: "en", basis: "detector", subject: item.subject, text: item.text };
      summary.alreadyEnglish++;
      continue;
    }
    pending.push({ item, words, hash: contentHash(words.subject, words.text) });
  }
  if (!pending.length) return summary;

  const hashes = [...new Set(pending.map((p) => p.hash))];
  const stored = await db
    .select()
    .from(messageTranslations)
    .where(and(eq(messageTranslations.orgId, ids.orgId), eq(messageTranslations.targetLanguage, language), inArray(messageTranslations.contentHash, hashes)));
  const byHash = new Map(stored.map((r) => [r.contentHash, r]));

  const toAsk = [...new Map(pending.filter((p) => !byHash.has(p.hash)).map((p) => [p.hash, p.words])).entries()];
  const answers = new Map<string, (ModelAnswer & { model: string }) | Error>();
  if (toAsk.length) {
    const run = lazyChildRun(async () => ids.parentRunId, { orgId: ids.orgId, userId: ids.userId, brandId: ids.brandId }, SUPPORT_RUNS.translation);
    let anyFailed = false;
    let config: ReturnType<typeof translationChatConfig> | null = null;
    let configError: Error | null = null;
    try {
      config = translationChatConfig();
    } catch (err) {
      configError = err as Error;
    }
    await pool(
      toAsk.map(([hash, words]) => async () => {
        if (!config) {
          answers.set(hash, configError!);
          anyFailed = true;
          return;
        }
        const key = `${ids.orgId}|${language}|${hash}`;
        let job = inFlight.get(key);
        if (!job) {
          summary.modelCalls++;
          const cfg = config;
          job = (async () => {
            const runId = await run.runId();
            const tracking: ChatTrackingHeaders = { orgId: ids.orgId, userId: ids.userId, runId, brandIds: [ids.brandId] };
            const res = await chatComplete(
              {
                message: JSON.stringify({ targetLanguage: language, messages: [{ id: "1", subject: words.subject, text: words.text }] }),
                systemPrompt: TRANSLATION_SYSTEM_PROMPT,
                provider: cfg.provider,
                model: cfg.model,
                responseFormat: "json",
                disableThinking: true,
                maxTokens: 16_000,
                timeoutMs: CALL_TIMEOUT_MS,
              },
              tracking,
            );
            const answer = parseModelAnswer(res.json, res.content, words);
            await db
              .insert(messageTranslations)
              .values({
                orgId: ids.orgId,
                contentHash: hash,
                targetLanguage: language,
                sourceLanguage: answer.sourceLanguage,
                alreadyInTarget: answer.alreadyInTarget,
                subject: answer.subject,
                text: answer.text,
                model: res.model,
                runId,
              })
              .onConflictDoNothing();
            return { ...answer, model: res.model };
          })().finally(() => inFlight.delete(key));
          inFlight.set(key, job);
        }
        try {
          const a = await job;
          answers.set(hash, a);
          summary.model = a.model;
        } catch (err) {
          anyFailed = true;
          console.error(`[crm-service] translation failed (org ${ids.orgId}):`, err);
          answers.set(hash, err as Error);
        }
      }),
      MAX_PARALLEL,
    );
    await run.close(anyFailed);
  }

  for (const p of pending) {
    const row = byHash.get(p.hash);
    if (row) {
      summary.fromStore++;
      setFromAnswer(p.item, language, row, "model");
    } else {
      const a = answers.get(p.hash);
      if (!a || a instanceof Error) {
        p.item.translation = { language, status: "failed", sourceLanguage: null, basis: null, subject: null, text: null, error: a ? a.message : "not translated" };
        summary.failed++;
        continue;
      }
      setFromAnswer(p.item, language, a, "model");
    }
    if (p.item.translation!.status === "translated") summary.translated++;
    else summary.alreadyEnglish++;
  }
  return summary;
}

function setFromAnswer(item: TimelineItem, language: TranslationLanguage, a: { sourceLanguage: string; alreadyInTarget: boolean; subject: string | null; text: string | null }, basis: "model") {
  const already = a.alreadyInTarget || a.sourceLanguage === language;
  item.translation = already
    ? { language, status: "already_english", sourceLanguage: a.sourceLanguage, basis, subject: item.subject, text: item.text }
    : { language, status: "translated", sourceLanguage: a.sourceLanguage, basis, subject: a.subject, text: a.text };
}
