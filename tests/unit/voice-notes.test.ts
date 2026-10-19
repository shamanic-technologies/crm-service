import { describe, expect, it } from "vitest";
import type { MatrixEvent } from "../../src/lib/matrix/client.js";
import {
  VOICE_NOTE_PREFIX,
  VOICE_NOTE_UNREADABLE,
  isVoiceNote,
  parseMxc,
  untranscribedVoiceNotesInBurst,
  voiceNoteText,
  withVoiceTranscripts,
} from "../../src/lib/matrix/voice-notes.js";
import { readThreadForReply } from "../../src/lib/reply-trigger/thread.js";

const OWN = "@own:hs";
const GHOST = "@whatsapp_lid-1:hs";

const msg = (id: string, sender: string, ts: number, body: string): MatrixEvent => ({
  event_id: id, type: "m.room.message", sender, origin_server_ts: ts, content: { msgtype: "m.text", body },
});
// The bridge's prod shape of a WhatsApp voice note (2026-10-18).
const voice = (id: string, ts: number, sender = GHOST): MatrixEvent => ({
  event_id: id, type: "m.room.message", sender, origin_server_ts: ts,
  content: { url: `mxc://matrix.distribute.you/${id}`, body: "", info: { size: 5540, duration: 2000, mimetype: "audio/ogg; codecs=opus" }, msgtype: "m.audio", filename: "Voice message.ogg" },
});

describe("voice notes (SOPHIE-VOICE-1019)", () => {
  it("the labels are byte-equal to chat-service's", () => {
    expect(VOICE_NOTE_PREFIX).toBe("🎤 Voice note:");
    expect(VOICE_NOTE_UNREADABLE).toBe("🎤 Voice note (could not be understood)");
  });

  it("an audio message with its file on the homeserver is a voice note; a text is not", () => {
    expect(isVoiceNote(voice("v", 1).content)).toBe(true);
    expect(isVoiceNote(msg("t", GHOST, 1, "hi").content)).toBe(false);
  });

  it("the words: the transcript, or could-not-be-understood when it failed or nothing was said", () => {
    expect(voiceNoteText({ status: "completed", text: "How many\ncampaigns?" })).toBe("🎤 Voice note: How many campaigns?");
    expect(voiceNoteText({ status: "completed", text: "" })).toBe(VOICE_NOTE_UNREADABLE);
    expect(voiceNoteText({ status: "failed", text: null })).toBe(VOICE_NOTE_UNREADABLE);
  });

  it("a transcribed voice note reads as the person's words in the thread; an untranscribed one stays silent", () => {
    const events = [msg("a", OWN, 1, "Hi from Sophie"), voice("v1", 2), voice("v2", 3)];
    const overlaid = withVoiceTranscripts(events, new Map([["v1", { status: "completed", text: "How many campaigns run?" }]]));
    const reading = readThreadForReply(overlaid, OWN, []);
    expect(reading).toMatchObject({ kind: "unanswered", burst: [{ eventId: "v1", text: "🎤 Voice note: How many campaigns run?" }] });
    expect(events[1].content?.body).toBe(""); // bronze is never rewritten
  });

  it("finds the voice notes of the unanswered burst only: before our last word is answered, ours are never transcribed", () => {
    const events = [voice("old", 1), msg("ours", OWN, 2, "Answered"), voice("mine", 3, OWN), msg("t", GHOST, 4, "And"), voice("new", 5)];
    expect(untranscribedVoiceNotesInBurst(events, OWN, []).map((e) => e.event_id)).toEqual(["new"]);
    // Already transcribed: nothing to do.
    const done = withVoiceTranscripts(events, new Map([["new", { status: "failed", text: null }]]));
    expect(untranscribedVoiceNotesInBurst(done, OWN, [])).toEqual([]);
    // A send in flight: no burst read yet.
    expect(untranscribedVoiceNotesInBurst(events, OWN, [{ eventId: null, campaignId: null, status: "sending", sentAt: null }])).toEqual([]);
  });

  it("parses an mxc URL", () => {
    expect(parseMxc("mxc://matrix.distribute.you/abc123")).toEqual({ server: "matrix.distribute.you", mediaId: "abc123" });
    expect(parseMxc("https://x/y")).toBeNull();
  });
});
