import { afterEach, describe, expect, it } from "vitest";
import { copilotAnswersOn, copilotHandoffBody, threadBeforeBurst, HANDOFF_THREAD_MAX } from "../../src/lib/reply-trigger/copilot.js";
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
      { at: new Date(1000).toISOString(), direction: "outbound", text: "Hi from Sophie" },
      { at: new Date(2000).toISOString(), direction: "inbound", text: "hey" },
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
});
