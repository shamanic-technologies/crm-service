import { describe, it, expect, afterEach } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { channelAvailability } from "../../src/lib/matrix/bridge.js";

const ENV_KEYS = [
  "MATRIX_HOMESERVER_URL",
  "MATRIX_APPSERVICE_TOKEN",
  "MATRIX_WHATSAPP_PROVISIONING_URL",
  "MATRIX_WHATSAPP_PROVISIONING_SECRET",
];
const saved = Object.fromEntries(ENV_KEYS.map((k) => [k, process.env[k]]));

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
});

describe("channel availability", () => {
  it("a channel is linkable only when the homeserver AND its bridge are configured", () => {
    process.env.MATRIX_HOMESERVER_URL = "http://hs";
    process.env.MATRIX_APPSERVICE_TOKEN = "t";
    process.env.MATRIX_WHATSAPP_PROVISIONING_URL = "http://wa";
    process.env.MATRIX_WHATSAPP_PROVISIONING_SECRET = "s";
    expect(channelAvailability("whatsapp")).toEqual({ available: true, unavailableReason: null });

    delete process.env.MATRIX_APPSERVICE_TOKEN;
    expect(channelAvailability("whatsapp").available).toBe(false);
  });

  it("Telegram without its bridge reads 'not available yet'", () => {
    expect(channelAvailability("telegram")).toEqual({
      available: false,
      unavailableReason: "Linking Telegram is not available yet.",
    });
  });
});

describe("read-only by design", () => {
  // The linked accounts are customers' PERSONAL WhatsApp/Telegram. Nothing in the
  // Matrix code may send a message, react, or mark anything read.
  it("no Matrix module calls a send / redact / receipt endpoint", () => {
    const dir = join(__dirname, "../../src/lib/matrix");
    const offenders = readdirSync(dir)
      .filter((f) => f.endsWith(".ts"))
      .filter((f) => /\/send\/|\/redact\/|\/receipt\/|\/read_markers|create_dm|create_group/.test(readFileSync(join(dir, f), "utf8")));
    expect(offenders).toEqual([]);
  });
});
