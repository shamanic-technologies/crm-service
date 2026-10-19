/**
 * VOICE NOTES ARE READ (SOPHIE-VOICE-1019, owner 2026-10-19: « Pour simplifier
 * pour le moment fais-lui toujours écrire par texte »).
 *
 * The WhatsApp bridge mirrors a voice note as `m.audio` with an empty body and
 * the file on the homeserver (`url: mxc://…`), so every reader of words
 * (`humanText`) saw nothing: a voice note to the assistant line was never
 * answered. Now:
 *  - a voice note in the burst an AUTOMATION is about to read (the Copilot's
 *    line, the reply trigger: automation allowed on the account, mirrored after
 *    the watch started) is transcribed once by chat-service
 *    (`POST /orgs/transcriptions`, org-billed under the account's org, like the
 *    burst's Jev call) and stored in `voice_note_transcripts`;
 *  - every reader overlays the stored words on the event (`withVoiceTranscripts`):
 *    `🎤 Voice note: <words>`, or `🎤 Voice note (could not be understood)` when it
 *    failed or nothing was said. The Copilot is told what both mean (chat-service
 *    `channel-copilot.ts`, byte-equal constants) and always answers in TEXT;
 *  - a voice note nobody transcribed (history, an account without automation)
 *    stays what it was: no words.
 *
 * Generic: no number, brand or channel in code; any `m.audio` on any account.
 */
import { inArray } from "drizzle-orm";
import { db } from "../../db/index.js";
import { voiceNoteTranscripts, type MatrixConnection, type VoiceNoteTranscript } from "../../db/schema.js";
import type { MatrixEvent } from "./client.js";
import { homeserverUrl, platformAccessToken } from "./client.js";
import { humanText } from "./events.js";
import { readThreadForReply, type RoomSend } from "../reply-trigger/thread.js";

/** Byte-equal to chat-service `VOICE_NOTE_PREFIX` / `VOICE_NOTE_UNREADABLE` (`src/lib/channel-copilot.ts`). */
export const VOICE_NOTE_PREFIX = "🎤 Voice note:";
export const VOICE_NOTE_UNREADABLE = "🎤 Voice note (could not be understood)";

/** chat-service's inline limit (`MAX_INLINE_TRANSCRIPTION_BYTES`): 7 MB, ~1 h of WhatsApp Opus. */
export const VOICE_NOTE_MAX_BYTES = 7 * 1024 * 1024;
const MEDIA_TIMEOUT_MS = 30_000;
const TRANSCRIBE_TIMEOUT_MS = 120_000;
/** Pause before the one retry of a failed attempt (tests set it to 0). */
const retryDelayMs = () => Number(process.env.VOICE_NOTE_RETRY_DELAY_MS ?? 3_000);

// ─── pure ───────────────────────────────────────────────────────────────────

/** An audio message with its file on the homeserver (a voice note, or an audio file sent). */
export function isVoiceNote(content: Record<string, unknown> | undefined): boolean {
  return content?.msgtype === "m.audio" && typeof content.url === "string" && content.url.startsWith("mxc://");
}

/** The words a reader sees for a transcribed voice note. */
export function voiceNoteText(t: Pick<VoiceNoteTranscript, "status" | "text">): string {
  const words = t.status === "completed" ? (t.text ?? "").replace(/\s+/g, " ").trim() : "";
  return words ? `${VOICE_NOTE_PREFIX} ${words}` : VOICE_NOTE_UNREADABLE;
}

/**
 * PURE: the events with each transcribed voice note's words as its body (the
 * message keeps its id, sender and place). An edit's `m.new_content` is never
 * audio, so only originals are touched. Events without a transcript are as they were.
 */
export function withVoiceTranscripts<E extends MatrixEvent>(
  events: E[],
  transcripts: Map<string, Pick<VoiceNoteTranscript, "status" | "text">>,
): E[] {
  if (transcripts.size === 0) return events;
  return events.map((e) => {
    const t = transcripts.get(e.event_id);
    if (!t || !isVoiceNote(e.content)) return e;
    return { ...e, content: { ...e.content, body: voiceNoteText(t) } };
  });
}

/** Stands for a voice note not transcribed yet, only while finding the burst. */
const UNHEARD = "\u{1F3A4}\u2026";

/**
 * PURE: the voice notes (not transcribed yet) of the burst the reply watch is
 * about to read: the person's messages since our last word, the same rule as
 * `readThreadForReply` (each untranscribed voice note counted as a message).
 * `events` already carry the stored transcripts.
 */
export function untranscribedVoiceNotesInBurst<E extends MatrixEvent>(events: E[], ownMxid: string, sends: RoomSend[]): E[] {
  const unheard = new Map<string, E>();
  const marked = events.map((e) => {
    if (e.sender === ownMxid || !isVoiceNote(e.content) || humanText(e.content)) return e;
    unheard.set(e.event_id, e);
    return { ...e, content: { ...e.content, body: UNHEARD } };
  });
  if (unheard.size === 0) return [];
  const reading = readThreadForReply(marked, ownMxid, sends);
  if (reading.kind !== "unanswered") return [];
  return reading.burst.map((m) => unheard.get(m.eventId)).filter((e): e is E => !!e);
}

/** `mxc://server/mediaId` → its parts, or null. */
export function parseMxc(mxc: string): { server: string; mediaId: string } | null {
  const m = /^mxc:\/\/([^/]+)\/([^/?#]+)$/.exec(mxc);
  return m ? { server: m[1], mediaId: m[2] } : null;
}

// ─── store ──────────────────────────────────────────────────────────────────

/** The stored transcripts of these events (any of them may be no voice note). */
export async function readVoiceTranscripts(eventIds: string[]): Promise<Map<string, VoiceNoteTranscript>> {
  if (eventIds.length === 0) return new Map();
  const rows = await db.select().from(voiceNoteTranscripts).where(inArray(voiceNoteTranscripts.eventId, eventIds));
  return new Map(rows.map((r) => [r.eventId, r]));
}

/** Events with their stored transcripts overlaid (one read). */
export async function overlayVoiceTranscripts<E extends MatrixEvent>(events: E[]): Promise<E[]> {
  const ids = events.filter((e) => isVoiceNote(e.content)).map((e) => e.event_id);
  if (ids.length === 0) return events;
  return withVoiceTranscripts(events, await readVoiceTranscripts(ids));
}

// ─── transcribe ─────────────────────────────────────────────────────────────

export interface VoiceIdentity {
  orgId: string;
  userId: string;
  runId: string;
  brandId: string;
}

type Attempt =
  | { ok: true; text: string; languages: string[] | null; model: string; chatRunId: string | null }
  | { ok: false; retry: boolean; code: string; error: string };

/** The voice note's file, from the homeserver, as the account that received it. */
async function downloadMedia(conn: Pick<MatrixConnection, "accessToken">, mxc: string): Promise<Buffer> {
  const parts = parseMxc(mxc);
  if (!parts) throw new Error(`not an mxc URL: ${mxc}`);
  const res = await fetch(
    `${homeserverUrl()}/_matrix/client/v1/media/download/${encodeURIComponent(parts.server)}/${encodeURIComponent(parts.mediaId)}`,
    { headers: { Authorization: `Bearer ${conn.accessToken ?? platformAccessToken()}` }, signal: AbortSignal.timeout(MEDIA_TIMEOUT_MS) },
  );
  if (!res.ok) throw new Error(`homeserver media download answered ${res.status}: ${(await res.text().catch(() => "")).slice(0, 300)}`);
  return Buffer.from(await res.arrayBuffer());
}

async function attemptOnce(
  conn: Pick<MatrixConnection, "accessToken">,
  content: Record<string, unknown>,
  who: VoiceIdentity,
): Promise<Attempt> {
  let file: Buffer;
  try {
    file = await downloadMedia(conn, content.url as string);
  } catch (err) {
    return { ok: false, retry: true, code: "media_unreachable", error: (err as Error).message };
  }
  if (file.length > VOICE_NOTE_MAX_BYTES) {
    return { ok: false, retry: false, code: "too_large", error: `${file.length} bytes, the limit is ${VOICE_NOTE_MAX_BYTES}` };
  }
  const info = (content.info ?? {}) as { mimetype?: unknown; duration?: unknown };
  const url = process.env.CHAT_SERVICE_URL;
  const key = process.env.CHAT_SERVICE_API_KEY;
  if (!url || !key) throw new Error("[crm-service] CHAT_SERVICE_URL / CHAT_SERVICE_API_KEY are required");
  let res: Response;
  try {
    res = await fetch(`${url.replace(/\/+$/, "")}/orgs/transcriptions`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-api-key": key,
        "x-org-id": who.orgId,
        "x-user-id": who.userId,
        "x-run-id": who.runId,
        "x-brand-id": who.brandId,
      },
      body: JSON.stringify({
        audio: { base64: file.toString("base64"), mimeType: typeof info.mimetype === "string" ? info.mimetype : "audio/ogg" },
        ...(typeof info.duration === "number" && info.duration > 0 ? { durationSeconds: info.duration / 1000 } : {}),
      }),
      signal: AbortSignal.timeout(TRANSCRIBE_TIMEOUT_MS),
    });
  } catch (err) {
    return { ok: false, retry: true, code: "chat_service_unreachable", error: (err as Error).message };
  }
  const text = await res.text();
  if (!res.ok) {
    // A refusal (not audio, too large, no credit) will not change on a retry; a 5xx may.
    return { ok: false, retry: res.status >= 500, code: res.status >= 500 ? "chat_service_unreachable" : "chat_service_refused", error: `chat-service answered ${res.status}: ${text.slice(0, 500)}` };
  }
  const body = JSON.parse(text) as { text?: unknown; languages?: unknown; model?: unknown; runId?: unknown };
  if (typeof body.text !== "string") throw new Error(`chat-service transcription answered no text: ${text.slice(0, 300)}`);
  return {
    ok: true,
    text: body.text,
    languages: Array.isArray(body.languages) ? (body.languages as string[]) : null,
    model: typeof body.model === "string" ? body.model : "unknown",
    chatRunId: typeof body.runId === "string" ? body.runId : null,
  };
}

/**
 * Transcribe one voice note and store the result (once per event: a stored row
 * is never redone). A failure is retried once right away, then stored as
 * `failed`, so the person is still answered (« could not be understood »).
 */
export async function transcribeVoiceNote(
  conn: Pick<MatrixConnection, "id" | "orgId" | "brandId" | "accessToken">,
  roomId: string,
  event: MatrixEvent,
  who: VoiceIdentity,
): Promise<VoiceNoteTranscript | null> {
  const content = event.content ?? {};
  let result = await attemptOnce(conn, content, who);
  if (!result.ok && result.retry) {
    await new Promise((r) => setTimeout(r, retryDelayMs()));
    result = await attemptOnce(conn, content, who);
  }
  const info = (content.info ?? {}) as { size?: unknown; duration?: unknown };
  const base = {
    eventId: event.event_id,
    orgId: conn.orgId,
    brandId: conn.brandId,
    connectionId: conn.id,
    roomId,
    sizeBytes: typeof info.size === "number" ? info.size : null,
    durationMs: typeof info.duration === "number" ? Math.round(info.duration) : null,
    runId: who.runId,
  };
  const values = result.ok
    ? { ...base, status: "completed", text: result.text, languages: result.languages, model: result.model, chatRunId: result.chatRunId }
    : { ...base, status: "failed", errorCode: result.code, error: result.error.slice(0, 2000) };
  if (result.ok) {
    console.log(
      `[crm-service][voice-notes] ${event.event_id} on connection ${conn.id} transcribed (${result.text.length} chars, ` +
        `${result.languages?.join(",") ?? "languages not stated"}, chat run ${result.chatRunId})`,
    );
  } else {
    console.error(`[crm-service][voice-notes] ${event.event_id} on connection ${conn.id} could not be transcribed (${result.code}): ${result.error}`);
  }
  const [row] = await db.insert(voiceNoteTranscripts).values(values).onConflictDoNothing({ target: voiceNoteTranscripts.eventId }).returning();
  return row ?? null;
}
