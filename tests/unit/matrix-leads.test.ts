import { describe, it, expect, vi, beforeEach } from "vitest";

const chatComplete = vi.fn();
vi.mock("../../src/lib/chat-client.js", () => ({ chatComplete }));

const { readThread } = await import("../../src/lib/matrix/leads.js");

const TRACKING = { orgId: "org", userId: "user", runId: "run", brandIds: ["brand"] };
const CTX = {
  channel: "whatsapp",
  contactName: "Alice",
  contactHandle: "@whatsapp_336:hs",
  lines: [{ direction: "inbound" as const, at: "2026-08-02T10:00:00.000Z", body: "hello" }],
};

function reply(json: Record<string, unknown>) {
  return { content: JSON.stringify(json), json, tokensInput: 1, tokensOutput: 1, model: "m-1" };
}

describe("readThread", () => {
  beforeEach(() => {
    chatComplete.mockReset();
    process.env.CRM_LEAD_READING_CHAT_CONFIG = "anthropic/haiku";
  });

  it("returns the reading and uses the configured provider/model", async () => {
    chatComplete.mockResolvedValue(
      reply({
        status: "qualifying",
        nextStep: "Send the June availability",
        estimatedValueUsd: 2500,
        summary: "Asked about a June wedding.",
      }),
    );

    const result = await readThread(CTX, TRACKING);
    expect(result).toEqual({
      status: "qualifying",
      nextStep: "Send the June availability",
      estimatedValueUsd: 2500,
      summary: "Asked about a June wedding.",
      model: "m-1",
    });

    const [params, tracking] = chatComplete.mock.calls[0];
    expect(params.provider).toBe("anthropic");
    expect(params.model).toBe("haiku");
    expect(tracking).toEqual(TRACKING);
  });

  it("follows the chat config when it points at another provider", async () => {
    process.env.CRM_LEAD_READING_CHAT_CONFIG = "google/flash-lite";
    chatComplete.mockResolvedValue(
      reply({ status: "new", nextStep: "Reply", estimatedValueUsd: 0, summary: "New enquiry." }),
    );
    await readThread(CTX, TRACKING);
    const [params] = chatComplete.mock.calls[0];
    expect(params.provider).toBe("google");
    expect(params.model).toBe("flash-lite");
  });

  it("fails loud on an out-of-enum status", async () => {
    chatComplete.mockResolvedValue(
      reply({ status: "vibing", nextStep: "x", estimatedValueUsd: 0, summary: "y" }),
    );
    await expect(readThread(CTX, TRACKING)).rejects.toThrow(/unknown status/);
  });

  it("fails loud on a missing field instead of defaulting it", async () => {
    chatComplete.mockResolvedValue(reply({ status: "new", estimatedValueUsd: 0, summary: "y" }));
    await expect(readThread(CTX, TRACKING)).rejects.toThrow(/nextStep missing/);

    chatComplete.mockResolvedValue(
      reply({ status: "new", nextStep: "x", estimatedValueUsd: "lots", summary: "y" }),
    );
    await expect(readThread(CTX, TRACKING)).rejects.toThrow(/estimatedValueUsd is not a number/);
  });

  it("fails loud when the config is unset", async () => {
    delete process.env.CRM_LEAD_READING_CHAT_CONFIG;
    await expect(readThread(CTX, TRACKING)).rejects.toThrow(
      /CRM_LEAD_READING_CHAT_CONFIG is required/,
    );
    expect(chatComplete).not.toHaveBeenCalled();
  });
});
