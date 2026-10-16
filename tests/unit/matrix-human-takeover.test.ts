import { describe, it, expect } from "vitest";
import { lastHandTyped } from "../../src/lib/matrix/human-takeover.js";
import type { MatrixEvent } from "../../src/lib/matrix/client.js";

const OWN = "@crm_own:hs";
const GHOST = "@whatsapp_lid-1:hs";
const msg = (id: string, sender: string, ts: number, content: Record<string, unknown>): MatrixEvent =>
  ({ event_id: id, type: "m.room.message", sender, origin_server_ts: ts, content }) as MatrixEvent;
const text = (body: string) => ({ msgtype: "m.text", body });

describe("lastHandTyped (HUMAN-IN-THREAD-1016)", () => {
  it("no thread, or only the person's words: nobody typed by hand", () => {
    expect(lastHandTyped([], OWN, [])).toBeNull();
    expect(lastHandTyped([msg("$1", GHOST, 1, text("hi"))], OWN, [])).toBeNull();
  });

  it("our automated sends are not hand-typed: by event id, or by text when the event id is not recorded yet", () => {
    const events = [msg("$a", OWN, 1, text("Welcome!")), msg("$b", OWN, 2, text("Following up"))];
    expect(lastHandTyped(events, OWN, [{ eventId: "$a", text: "Welcome!" }, { eventId: null, text: "Following up " }])).toBeNull();
  });

  it("a message the account typed is hand-typed; the latest one is answered", () => {
    const events = [msg("$h1", OWN, 5, text("Hey Noah")), msg("$a", OWN, 1, text("Welcome!")), msg("$h2", OWN, 9, text("see you tomorrow"))];
    expect(lastHandTyped(events, OWN, [{ eventId: "$a", text: "Welcome!" }])?.event_id).toBe("$h2");
  });

  it("an edit, a bridge notice, an uncaptioned file carry no hand-typed word", () => {
    const events = [
      msg("$e", OWN, 1, { msgtype: "m.text", body: "* fixed", "m.relates_to": { rel_type: "m.replace", event_id: "$a" } }),
      msg("$n", OWN, 2, { msgtype: "m.notice", body: "Failed to bridge media" }),
      msg("$f", OWN, 3, { msgtype: "m.image", body: "photo.jpg", filename: "photo.jpg" }),
    ];
    expect(lastHandTyped(events, OWN, [])).toBeNull();
  });
});
