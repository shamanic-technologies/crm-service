import { describe, it, expect } from "vitest";
import { alertKeyFor, composeRefusalAlert, integrationsUrl } from "../../src/lib/whatsapp/staff-alert.js";
import { bridgeSaysNoSuchNumber, isImpossibleNumber } from "../../src/lib/whatsapp/number-validity.js";
import { BridgeError } from "../../src/lib/matrix/bridge.js";

describe("WHATSAPP-RESOLVE-1015: numbers that cannot exist", () => {
  it("tells a malformed number from a real one", () => {
    expect(isImpossibleNumber("+2541110229905")).toBe(true); // prod 2026-10-14: 10 digits after Kenya's +254
    for (const p of ["+254111022990", "+17329159411", "+33770657585", "+971557880197"]) expect(isImpossibleNumber(p)).toBe(false);
  });

  it("reads a bridge 500 as 'no such number' only when the number cannot exist", () => {
    const e500 = new BridgeError(500, "M_UNKNOWN", "Internal error resolving identifier");
    expect(bridgeSaysNoSuchNumber(e500, "+2541110229905")).toBe("invalid_number");
    expect(bridgeSaysNoSuchNumber(e500, "+33770657585")).toBeNull();
    expect(bridgeSaysNoSuchNumber(new BridgeError(404, "M_NOT_FOUND", "x"), "+33770657585")).toBe("not_on_whatsapp");
    expect(bridgeSaysNoSuchNumber(new BridgeError(504, "BRIDGE_TIMEOUT", "x"), "+2541110229905")).toBeNull();
    expect(bridgeSaysNoSuchNumber(new Error("x"), "+2541110229905")).toBeNull();
  });
});

describe("WHATSAPP-RESOLVE-1015: the staff alert", () => {
  it("is keyed once per code, brand and UTC day", () => {
    const b = "75d7e3e8-6926-4f85-a557-976895400666";
    expect(alertKeyFor("whatsapp_not_linked", b, new Date("2026-10-15T23:59:00Z"))).toBe(`whatsapp_send:whatsapp_not_linked:${b}:2026-10-15`);
    expect(alertKeyFor("whatsapp_not_linked", b, new Date("2026-10-16T00:01:00Z"))).toBe(`whatsapp_send:whatsapp_not_linked:${b}:2026-10-16`);
  });

  it("names the brand, what was skipped, what the customer must do, and where", () => {
    const url = integrationsUrl("org_abc", "b1");
    expect(url).toBe("https://dashboard.distribute.you/v2/orgs/org_abc/brands/b1/integrations");
    const text = composeRefusalAlert({ code: "whatsapp_not_linked", brandName: "Doc Dinners", orgName: "Doc Dinners", url });
    expect(text).toContain("WhatsApp message not sent: Doc Dinners\n");
    expect(text).toContain("no WhatsApp account linked");
    expect(text).toContain("the customer must link their WhatsApp on the Integrations page");
    expect(text).toContain(url);
    expect(text).not.toMatch(/[—–]/);
    const relink = composeRefusalAlert({ code: "whatsapp_not_connected", brandName: "X", orgName: null, url: null });
    expect(relink).toContain("logged out");
    expect(relink).toContain("relink their WhatsApp");
  });
});
