import { describe, it, expect, afterEach, vi } from "vitest";
import { planSend, planRelink, relinkSend } from "../../src/lib/whatsapp/relink-sends.js";
import { messageSentBatchBody } from "../../src/lib/whatsapp/message-sent.js";
import type { LedgerOccurrence } from "../../src/lib/runs-client.js";

/**
 * WHATSAPP-RELINK-1118: a past campaign WhatsApp send that consumed nothing gets the live declaration's consumption
 * (its lead's written message) added on the same run, only when the ledger can link it. runs-service stubbed at `fetch`.
 */
const RUN = "3e3e3e3e-2222-4222-8222-0000000000a1";
const LEAD = "3e3e3e3e-2222-4222-8222-0000000000d1";
const occ = (over: Partial<LedgerOccurrence>): LedgerOccurrence => ({
  id: "o", runId: RUN, direction: "produced", outcomeKey: "message_sent", subjectService: "lead-service", subjectId: LEAD, declaredAt: "2026-10-27T17:46:19.000Z", reversal: null, ...over,
});
const sent = occ({});
const written = (declaredAt: string, over: Partial<LedgerOccurrence> = {}) => occ({ runId: "w", outcomeKey: "message_written", declaredAt, ...over });
const send = { runId: RUN, leadId: LEAD };

describe("planSend", () => {
  it("links a send whose lead holds a written message declared before the end of the send's UTC day", () => {
    expect(planSend(send, [sent], [written("2026-10-27T23:59:59.999Z"), written("2026-10-29T08:00:00.000Z")])).toMatchObject({ verdict: "link", sentAt: "2026-10-27T17:46:19.000Z" });
  });

  it("leaves out a send the ledger cannot link, and says why", () => {
    expect(planSend(send, [sent], []).verdict).toBe("no_written_message");
    // Reversed, another lead's, or another outcome: not a written message of this lead.
    expect(planSend(send, [sent], [written("2026-10-20T00:00:00.000Z", { reversal: { reversedAt: "x" } }), written("2026-10-20T00:00:00.000Z", { subjectId: "other" })]).verdict).toBe("no_written_message");
    const late = planSend(send, [sent], [written("2026-10-28T05:11:02.000Z")]);
    expect(late.verdict).toBe("written_after_send_day");
    expect(late.detail).toContain("2026-10-28T05:11:02.000Z");
  });

  it("never touches a send that already consumes, nor a run whose Unit does not stand alone", () => {
    expect(planSend(send, [sent, occ({ direction: "consumed", outcomeKey: "message_written" })], [written("2026-10-20T00:00:00.000Z")]).verdict).toBe("already_consumes");
    expect(planSend(send, [], [written("2026-10-20T00:00:00.000Z")]).verdict).toBe("unit_not_standing");
    expect(planSend(send, [occ({ reversal: { reversedAt: "x" } })], [written("2026-10-20T00:00:00.000Z")]).verdict).toBe("unit_not_standing");
    expect(planSend(send, [sent, occ({ id: "o2", subjectId: "other" })], [written("2026-10-20T00:00:00.000Z")]).verdict).toBe("unit_not_standing");
  });
});

describe("planRelink + relinkSend against runs-service", () => {
  afterEach(() => vi.unstubAllGlobals());
  const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

  it("reads the ledger per run and once per lead, then re-declares the LIVE body at the Unit's own instant", async () => {
    const reads: string[] = [];
    const posted: unknown[] = [];
    let answer: unknown = { recordedCount: 1, alreadyRecordedCount: 1, runs: [] };
    vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = new URL(String(input));
      if (url.pathname === "/internal/outcome-occurrences") {
        reads.push(url.search);
        if (url.searchParams.get("runIds")) return json({ occurrences: [occ({ runId: url.searchParams.get("runIds")! })], nextCursor: null });
        return json({ occurrences: [written("2026-10-27T10:00:00.000Z")], nextCursor: null });
      }
      if (url.pathname === "/v1/platform-runs/outcomes/batch") {
        posted.push(JSON.parse(String(init?.body)));
        return json(answer);
      }
      return json({ error: "unexpected" }, 599);
    });
    const plans = await planRelink([send, { runId: "run-2", leadId: LEAD }]);
    expect(plans.map((p) => p.verdict)).toEqual(["link", "link"]);
    expect(reads.filter((r) => r.includes("subjectIds"))).toHaveLength(1);
    expect(new URLSearchParams(reads.find((r) => r.includes("subjectIds"))!).get("outcomeKey")).toBe("message_written");

    await relinkSend(plans[0]);
    // Exactly what the live pass declares for that send (imported rule), nothing else.
    expect(posted).toEqual([{ runs: messageSentBatchBody([{ runId: RUN, leadId: LEAD, sentAt: new Date("2026-10-27T17:46:19.000Z") }]) }]);
    expect((posted[0] as { runs: Array<{ consumed: unknown[] }> }).runs[0].consumed).toEqual([{ outcomeKey: "message_written", subjectService: "lead-service", subjectId: LEAD }]);

    // Anything but "consumed recorded + produced replayed" stops.
    answer = { recordedCount: 2, alreadyRecordedCount: 0, runs: [] };
    await expect(relinkSend(plans[1])).rejects.toThrow(/expected 1 recorded/);
    await expect(relinkSend({ ...plans[0], verdict: "no_written_message" })).rejects.toThrow(/not planned/);
  });

  it("an unreadable ledger plans nothing", async () => {
    vi.stubGlobal("fetch", async () => json({ error: "down" }, 503));
    await expect(planRelink([send])).rejects.toThrow(/503/);
  });
});
