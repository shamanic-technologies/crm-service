import { afterEach, describe, expect, it } from "vitest";
import {
  burstForCopilot,
  copilotAnswersOn,
  copilotHandoffBody,
  knownEmailsOf,
  threadBeforeBurst,
  HANDOFF_THREAD_MAX,
  KNOWN_EMAILS_MAX,
} from "../../src/lib/reply-trigger/copilot.js";
import type { MatrixEvent } from "../../src/lib/matrix/client.js";

const ORG = "bbbbbbbb-7777-4777-8777-000000000001";
const BRAND = "bbbbbbbb-7777-4777-8777-000000000002";
const OWN = "@crm_sophie:hs";
const GHOST = "@whatsapp_lid-1:hs";

const msg = (id: string, sender: string, ts: number, body: string, extra: Record<string, unknown> = {}): MatrixEvent =>
  ({ event_id: id, type: "m.room.message", sender, origin_server_ts: ts, content: { msgtype: "m.text", body, ...extra } }) as MatrixEvent;

describe("the Copilot's line (SOPHIE-COPILOT-WA-1018)", () => {
  afterEach(() => {
    delete process.env.COPILOT_UNIBOX_ORG_ID;
    delete process.env.COPILOT_UNIBOX_BRAND_ID;
  });

  it("is only the automation-on account of the (org, brand) the Copilot serves", () => {
    process.env.COPILOT_UNIBOX_ORG_ID = ORG;
    process.env.COPILOT_UNIBOX_BRAND_ID = BRAND;
    expect(copilotAnswersOn({ orgId: ORG, brandId: BRAND }, true)).toBe(true);
    expect(copilotAnswersOn({ orgId: ORG, brandId: BRAND }, false)).toBe(false);
    expect(copilotAnswersOn({ orgId: "bbbbbbbb-7777-4777-8777-000000000009", brandId: BRAND }, true)).toBe(false);
    expect(copilotAnswersOn({ orgId: ORG, brandId: "bbbbbbbb-7777-4777-8777-000000000009" }, true)).toBe(false);
    delete process.env.COPILOT_UNIBOX_BRAND_ID;
    expect(copilotAnswersOn({ orgId: ORG, brandId: BRAND }, true)).toBe(false);
  });

  it("the thread is what came before the burst, oldest first, human words only, the latest 30", () => {
    const events = [
      msg("$3", GHOST, 3000, "burst"),
      msg("$1", OWN, 1000, "Hi from Sophie"),
      msg("$2", GHOST, 2000, "hey"),
      msg("$e", GHOST, 2500, "* hey!", { "m.relates_to": { rel_type: "m.replace", event_id: "$2" } }),
      msg("$4", GHOST, 4000, "after"),
    ];
    expect(threadBeforeBurst(events, OWN, "$3", new Date(3000).toISOString())).toEqual([
      { at: new Date(1000).toISOString(), direction: "outbound", kind: "message", text: "Hi from Sophie" },
      { at: new Date(2000).toISOString(), direction: "inbound", kind: "message", text: "hey" },
    ]);
    const many = Array.from({ length: 40 }, (_, i) => msg(`$m${i}`, GHOST, 1000 + i, `m${i}`));
    const thread = threadBeforeBurst(many, OWN, "$x", new Date(10_000).toISOString());
    expect(thread).toHaveLength(HANDOFF_THREAD_MAX);
    expect(thread[0].text).toBe("m10");
  });

  it("the body joins the burst, carries the persona and the last message's time", () => {
    const body = copilotHandoffBody({
      messageId: "$a",
      orgId: ORG,
      brandId: BRAND,
      accountUserId: "bbbbbbbb-7777-4777-8777-0000000000aa",
      fromAccount: "+77776879632",
      persona: null,
      sender: { phone: "+33680478702", name: null },
      messages: [
        { eventId: "$a", at: "2026-10-18T10:00:00.000Z", text: "one" },
        { eventId: "$b", at: "2026-10-18T10:01:00.000Z", text: "two" },
      ],
      thread: [],
    });
    expect(body).toMatchObject({
      channel: "whatsapp",
      messageId: "$a",
      text: "one\ntwo",
      at: "2026-10-18T10:01:00.000Z",
      assistant: { name: null, role: null, instructions: null },
      thread: [],
    });
  });

  it("carries sender.linkedBy only when the number is linked in Integrations", () => {
    const base = {
      messageId: "$a",
      orgId: ORG,
      brandId: BRAND,
      accountUserId: "bbbbbbbb-7777-4777-8777-0000000000aa",
      fromAccount: "+77776879632",
      persona: null,
      messages: [{ eventId: "$a", at: "2026-10-18T10:00:00.000Z", text: "one" }],
      thread: [],
    };
    const linkedBy = { orgId: ORG, userId: "bbbbbbbb-7777-4777-8777-0000000000bb" };
    expect(copilotHandoffBody({ ...base, sender: { phone: "+33680478702", name: null, linkedBy } }).sender).toEqual({
      phone: "+33680478702",
      name: null,
      linkedBy,
    });
    const unlinked = copilotHandoffBody({ ...base, sender: { phone: "+33600000001", name: "Ann", linkedBy: null } }).sender;
    expect(unlinked).toEqual({ phone: "+33600000001", name: "Ann" });
    expect("linkedBy" in (unlinked as object)).toBe(false);
  });

  // The bridge's REAL incoming-call event (prod matrix_raw_events, 2026-10-25 06:15, mautrix-whatsapp `convertCallStart`).
  const incomingCall = (id: string, ts: number, extra: Record<string, unknown> = {}): MatrixEvent =>
    ({
      event_id: id,
      type: "m.room.message",
      sender: GHOST,
      origin_server_ts: ts,
      content: {
        body: "Incoming call. Use the WhatsApp app to answer.",
        msgtype: "m.text",
        "m.mentions": {},
        "com.beeper.action_message": { type: "call", ...extra },
        "com.beeper.disappearing_timer": {},
      },
    }) as MatrixEvent;

  it("a call the bridge mirrored is a kind call line in its time order, said in plain words (COPILOT-WA-REPEAT-1027)", () => {
    const events = [
      msg("$1", OWN, 1000, "Kevin from distribute.you here."),
      incomingCall("$c", 2000),
      incomingCall("$v", 2500, { call_type: "video" }),
      msg("$3", GHOST, 3000, "Sorry I can't take calls at this moment"),
    ];
    expect(threadBeforeBurst(events, OWN, "$3", new Date(3000).toISOString())).toEqual([
      { at: new Date(1000).toISOString(), direction: "outbound", kind: "message", text: "Kevin from distribute.you here." },
      {
        at: new Date(2000).toISOString(),
        direction: "inbound",
        kind: "call",
        text: "They called us on WhatsApp (voice call). Whether it was answered or missed is not known.",
      },
      {
        at: new Date(2500).toISOString(),
        direction: "inbound",
        kind: "call",
        text: "They called us on WhatsApp (video call). Whether it was answered or missed is not known.",
      },
    ]);
  });

  it("a call inside the burst reaches the Copilot as the call, never the bridge's instruction text", () => {
    const events = [incomingCall("$c", 2000), msg("$m", GHOST, 2100, "call me back")];
    const burst = burstForCopilot(
      [
        { eventId: "$c", at: new Date(2000).toISOString(), text: "Incoming call. Use the WhatsApp app to answer." },
        { eventId: "$m", at: new Date(2100).toISOString(), text: "call me back" },
      ],
      events,
      OWN,
    );
    expect(burst.map((m) => m.text)).toEqual([
      "They called us on WhatsApp (voice call). Whether it was answered or missed is not known.",
      "call me back",
    ]);
  });

  it("known emails: our sends then the person record, lower-cased, deduplicated, valid only, at most 10", () => {
    expect(knownEmailsOf(["FanoikiJoshua@gmail.com", null, "fanoikijoshua@gmail.com"], ["not an email", "j@work.io"])).toEqual([
      "fanoikijoshua@gmail.com",
      "j@work.io",
    ]);
    const many = Array.from({ length: 15 }, (_, i) => `p${i}@x.io`);
    expect(knownEmailsOf(many)).toHaveLength(KNOWN_EMAILS_MAX);
  });

  it("the body carries sender.knownEmails when we know the person, never an empty list", () => {
    const base = {
      messageId: "$a",
      orgId: ORG,
      brandId: BRAND,
      accountUserId: "bbbbbbbb-7777-4777-8777-0000000000aa",
      fromAccount: "+33770657585",
      persona: null,
      messages: [{ eventId: "$a", at: "2026-10-27T14:26:02.000Z", text: "Sorry I can't take calls at this moment" }],
      thread: [],
    };
    expect(
      copilotHandoffBody({ ...base, sender: { phone: "+2349135497828", name: "fanice (WA)", knownEmails: ["fanoikijoshua@gmail.com"] } }).sender,
    ).toEqual({ phone: "+2349135497828", name: "fanice (WA)", knownEmails: ["fanoikijoshua@gmail.com"] });
    const unknown = copilotHandoffBody({ ...base, sender: { phone: "+2349135497828", name: null, knownEmails: [] } }).sender;
    expect("knownEmails" in (unknown as object)).toBe(false);
  });
});
