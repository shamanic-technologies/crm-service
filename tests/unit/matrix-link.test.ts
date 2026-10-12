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

describe("read-only by design, one send path", () => {
  // The linked accounts are customers' PERSONAL WhatsApp/Telegram. Nothing may
  // redact, react, mark read or open a group. The ONE write is a text message
  // (owner 2026-10-12): `sendText` + the bridge's `create_dm`, called from the
  // WhatsApp send module only.
  const dir = join(__dirname, "../../src/lib/matrix");
  const read = (f: string) => readFileSync(join(dir, f), "utf8");
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));

  it("no Matrix module redacts, sends receipts or read markers, or opens a group", () => {
    expect(files.filter((f) => /\/redact\/|\/receipt\/|\/read_markers|create_group/.test(read(f)))).toEqual([]);
  });

  it("only client.ts sends and only bridge.ts opens a DM", () => {
    expect(files.filter((f) => /\/send\//.test(read(f)))).toEqual(["client.ts"]);
    expect(files.filter((f) => /create_dm/.test(read(f)))).toEqual(["bridge.ts"]);
  });

  it("only the WhatsApp send module calls them", () => {
    const src = join(__dirname, "../../src");
    const callers: string[] = [];
    const walk = (d: string) => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const p = join(d, e.name);
        if (e.isDirectory()) walk(p);
        else if (p.endsWith(".ts") && /\b(sendText|createDm)\(/.test(readFileSync(p, "utf8")) && !p.endsWith("matrix/client.ts") && !p.endsWith("matrix/bridge.ts")) {
          callers.push(p.slice(src.length + 1));
        }
      }
    };
    walk(src);
    expect(callers).toEqual(["lib/whatsapp/send.ts"]);
  });
});