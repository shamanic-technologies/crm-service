import { describe, it, expect } from "vitest";
import { fitWebItem, webHandoffIdempotencyKey, webHandoffOccurrenceBody, webLines } from "../../src/lib/copilot/web-handoffs.js";
import { webChatCandidateFacts } from "../../src/lib/people/facts.js";

const row = (messageId: string, role: "user" | "assistant", text: string, at: string) => ({
  messageId,
  role,
  text,
  sentAt: new Date(at),
  email: "v@x.io",
  sessionId: "conv-1",
  visitorId: "vis-1",
  displayName: "Vee",
});

describe("web chat hand-off (DISTRY-WEB-CHAT-EMAIL-1117)", () => {
  const rows = [
    row("a", "user", "hi", "2026-11-17T10:00:00Z"),
    row("b", "assistant", "hello, your email?", "2026-11-17T10:00:01Z"),
    row("c", "user", "v@x.io", "2026-11-17T10:00:02Z"),
    row("d", "user", "and call me Vee", "2026-11-17T10:00:03Z"),
  ];

  it("one key per (conversation, address), case-folded", () => {
    expect(webHandoffIdempotencyKey("conv-1", "V@X.io")).toBe(webHandoffIdempotencyKey("conv-1", "v@x.io"));
    expect(webHandoffIdempotencyKey("conv-2", "v@x.io")).not.toBe(webHandoffIdempotencyKey("conv-1", "v@x.io"));
  });

  it("the body: message_received, the whole page conversation as thread, the visitor's unanswered words as messages", () => {
    const body = webHandoffOccurrenceBody({
      brandId: "b",
      offerId: "o",
      handoff: { conversationId: "conv-1", visitorId: "vis-1", email: "v@x.io", phone: "+33612345678", fullName: null },
      personId: "p-1",
      name: "Vee",
      lines: webLines(rows),
    }) as { triggerId: string; occurredAt: string; person: Record<string, unknown>; item: { thread: unknown[]; messages: { text: string }[]; kind: string } };
    expect(body.triggerId).toBe("message_received");
    expect(body.occurredAt).toBe("2026-11-17T10:00:03.000Z");
    expect(body.person).toEqual({ email: "v@x.io", name: "Vee", phone: "+33612345678" });
    expect(body.item.kind).toBe("web_chat");
    expect(body.item.thread).toHaveLength(4);
    expect(body.item.messages.map((m) => m.text)).toEqual(["v@x.io", "and call me Vee"]);
  });

  it("an impossible phone is never offered", () => {
    const body = webHandoffOccurrenceBody({
      brandId: "b",
      offerId: "o",
      handoff: { conversationId: "c", visitorId: "v", email: "v@x.io", phone: "12", fullName: "V" },
      personId: null,
      name: null,
      lines: webLines(rows.slice(0, 1)),
    }) as { person: Record<string, unknown> };
    expect(body.person).toEqual({ email: "v@x.io", name: "V" });
  });

  it("fits under campaign-service's cap: oldest lines first", () => {
    const long = Array.from({ length: 40 }, (_, i) => row(`m${i}`, i % 2 ? "assistant" : "user", "x".repeat(1900), `2026-11-17T10:${String(i).padStart(2, "0")}:00Z`));
    const lines = webLines(long);
    const item = fitWebItem({ kind: "web_chat", thread: lines, messages: lines.slice(-1) }) as { thread: { eventId: string }[] };
    expect(JSON.stringify(item).length).toBeLessThanOrEqual(19_000);
    expect(item.thread[item.thread.length - 1].eventId).toBe("m39");
  });

  it("facts: visitor = message_in, assistant = message_out, on the visitor's Copilot presence", () => {
    const facts = webChatCandidateFacts(rows.slice(0, 2));
    expect(facts.map((f) => [f.naturalKey, f.type, f.family, f.source, f.subject.presence])).toEqual([
      ["copilot|web|a", "message_in", "web_chat_message", "copilot", "copilot:v@x.io"],
      ["copilot|web|b", "message_out", "web_chat_message", "copilot", "copilot:v@x.io"],
    ]);
    expect(facts[0].payload).toMatchObject({ channel: "web", conversationId: "conv-1", text: "hi" });
  });
});
