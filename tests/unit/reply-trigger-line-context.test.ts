import { describe, expect, it } from "vitest";
import {
  answeringLine,
  burstInWords,
  threadAcrossLines,
  type BrandLine,
  lineContextOf,
  knownEmailsOf,
  threadBeforeBurst,
  THREAD_MAX,
  THREAD_TEXT_MAX,
  KNOWN_EMAILS_MAX,
} from "../../src/lib/reply-trigger/line-context.js";
import type { MatrixEvent } from "../../src/lib/matrix/client.js";

const ORG = "bbbbbbbb-7777-4777-8777-000000000001";
const OWN = "@crm_sophie:hs";
const GHOST = "@whatsapp_lid-1:hs";

const msg = (id: string, sender: string, ts: number, body: string, extra: Record<string, unknown> = {}): MatrixEvent =>
  ({ event_id: id, type: "m.room.message", sender, origin_server_ts: ts, content: { msgtype: "m.text", body, ...extra } }) as MatrixEvent;

describe("what a Lead event occurrence knows about the line and the person (ONE-AI-CONVERSES-1029)", () => {
  const sophie = { account: "+77776879632", accountType: "pro_ai" as const, persona: { name: "Sophie", role: "Assistant", instructions: "Be warm." } };
  const founder = { account: "+33680478702", accountType: "pro_human" as const, persona: null };

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
    expect(thread).toHaveLength(THREAD_MAX);
    expect(thread[0].text).toBe("m10");
  });

  it("names the line written to and the line answering, with its persona (the founder line hands it to Sophie's)", () => {
    const ctx = lineContextOf({ received: founder, answering: sophie, sender: { phone: "+33600000001", name: null }, thread: [] });
    expect(ctx.line).toEqual({
      receivedOn: { account: "+33680478702", accountType: "pro_human", name: null, role: null, instructions: null },
      answeringLine: { account: "+77776879632", accountType: "pro_ai", name: "Sophie", role: "Assistant", instructions: "Be warm." },
    });
    expect(ctx.thread).toEqual([]);
  });

  it("carries sender.linkedBy only when the number is linked in Integrations, absent values omitted", () => {
    const linkedBy = { orgId: ORG, userId: "bbbbbbbb-7777-4777-8777-0000000000bb" };
    expect(lineContextOf({ received: sophie, answering: sophie, sender: { phone: "+33680478702", name: null, linkedBy }, thread: [] }).sender).toEqual({
      phone: "+33680478702",
      linkedBy,
    });
    const unlinked = lineContextOf({ received: sophie, answering: sophie, sender: { phone: "+33600000001", name: "Ann", linkedBy: null }, thread: [] }).sender;
    expect(unlinked).toEqual({ phone: "+33600000001", name: "Ann" });
    expect(lineContextOf({ received: sophie, answering: sophie, sender: { phone: null, name: null }, thread: [] }).sender).toEqual({});
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

  it("a call inside the burst reaches the writer as the call, never the bridge's instruction text", () => {
    const events = [incomingCall("$c", 2000), msg("$m", GHOST, 2100, "call me back")];
    const burst = burstInWords(
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

  it("carries sender.knownEmails when we know the person, never an empty list", () => {
    expect(
      lineContextOf({ received: sophie, answering: sophie, sender: { phone: "+2349135497828", name: "fanice (WA)", knownEmails: ["fanoikijoshua@gmail.com"] }, thread: [] }).sender,
    ).toEqual({ phone: "+2349135497828", name: "fanice (WA)", knownEmails: ["fanoikijoshua@gmail.com"] });
    const unknown = lineContextOf({ received: sophie, answering: sophie, sender: { phone: "+2349135497828", name: null, knownEmails: [] }, thread: [] }).sender;
    expect("knownEmails" in unknown).toBe(false);
  });
});

describe("Sophie answers from her line (SOPHIE-ANSWERS-FROM-HER-LINE-1029)", () => {
  const line = (connectionId: string, accountType: "pro_ai" | "pro_human" | "personal_human" | null, extra: Partial<BrandLine> = {}): BrandLine => ({
    connectionId,
    account: `+3360000000${connectionId}`,
    accountType,
    automationAllowed: true,
    outreachDefault: false,
    linkedAt: new Date(Number(connectionId) * 1000),
    persona: null,
    ...extra,
  });

  it("a pro_ai line answers on itself; any other line hands it to a pro_ai line; none = the line written to", () => {
    const founder = line("1", "pro_human");
    const sophie = line("2", "pro_ai");
    const sophie2 = line("3", "pro_ai");
    expect(answeringLine(sophie, [founder, sophie, sophie2], ["3"])).toBe(sophie);
    expect(answeringLine(founder, [founder, sophie, sophie2], [])).toBe(sophie);
    expect(answeringLine(founder, [founder, sophie, sophie2], ["1", "3"])).toBe(sophie2);
    expect(answeringLine(founder, [founder, sophie, line("3", "pro_ai", { outreachDefault: true })], []).connectionId).toBe("3");
    const untyped = line("1", null);
    expect(answeringLine(untyped, [untyped, line("2", "pro_human")], [])).toBe(untyped);
    // A pro_ai line with no number cannot answer: never named.
    expect(answeringLine(founder, [founder, line("2", "pro_ai", { account: "" })], [])).toBe(founder);
  });

  it("the thread merges the person's rooms in time order, a line on another number carries it", () => {
    const rooms = [
      { account: "+33680478702", ownMxid: "@crm_founder:hs", events: [msg("$h", "@crm_founder:hs", 1000, "hello from Kevin"), msg("$a", GHOST, 2000, "tell me more")] },
      { account: "+77776879632", ownMxid: OWN, events: [msg("$s", OWN, 3000, "Sophie here"), msg("$b", GHOST, 4000, "burst")] },
    ];
    expect(threadAcrossLines(rooms, "+77776879632", "$b", new Date(4000).toISOString())).toEqual([
      { at: new Date(1000).toISOString(), direction: "outbound", kind: "message", text: "hello from Kevin", account: "+33680478702" },
      { at: new Date(2000).toISOString(), direction: "inbound", kind: "message", text: "tell me more", account: "+33680478702" },
      { at: new Date(3000).toISOString(), direction: "outbound", kind: "message", text: "Sophie here" },
    ]);
    const long = [{ account: "+77776879632", ownMxid: OWN, events: [msg("$l", GHOST, 1000, "x".repeat(THREAD_TEXT_MAX + 50)), msg("$b", GHOST, 4000, "burst")] }];
    expect(threadAcrossLines(long, "+77776879632", "$b", new Date(4000).toISOString())[0].text).toHaveLength(THREAD_TEXT_MAX);
    const one = [rooms[1]];
    expect(threadAcrossLines(one, "+77776879632", "$b", new Date(4000).toISOString())).toEqual(threadBeforeBurst(one[0].events, OWN, "$b", new Date(4000).toISOString()));
  });
});
