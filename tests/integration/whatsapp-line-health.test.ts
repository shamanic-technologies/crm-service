import { describe, it, expect, beforeEach, afterAll, vi } from "vitest";
import { inArray } from "drizzle-orm";
import { db } from "../../src/db/index.js";
import { matrixLinks, whatsappLineDays, whatsappLineSpans, whatsappSends } from "../../src/db/schema.js";

/**
 * WhatsApp line health end to end against a real database (WA-LINE-HEALTH-1023).
 * The bridge's `/whoami` is stubbed: one line logged out, one connected.
 */
const RUN = !!process.env.CRM_TEST_DB;

const ORG = "d0d0d0d0-1111-4111-8111-000000000001";
const BRAND = "d0d0d0d0-1111-4111-8111-000000000002";
const OTHER_ORG = "d0d0d0d0-1111-4111-8111-000000000003";
const OTHER_BRAND = "d0d0d0d0-1111-4111-8111-000000000004";
const LOGOUT = "You were logged out from another device. Relogin to continue using the bridge.";

process.env.BRAND_SERVICE_URL = "http://brand.test";
process.env.BRAND_SERVICE_API_KEY = "brand-key";
process.env.CLIENT_SERVICE_URL = "http://client.test";
process.env.CLIENT_SERVICE_API_KEY = "client-key";

const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
vi.stubGlobal("fetch", async (input: RequestInfo | URL) => {
  const url = new URL(String(input instanceof Request ? input.url : input));
  if (url.pathname.startsWith("/v1/runs")) return json({ id: "run-" + Math.random().toString(16).slice(2) });
  if (url.host === "brand.test" && url.pathname.endsWith(BRAND_PATH_ID())) return json({ brand: { name: "distribute.you" } });
  if (url.host === "brand.test") return json({ error: "not found" }, 404);
  if (url.host === "client.test" && url.pathname.endsWith(ORG)) return json({ name: "Distribute" });
  if (url.host === "client.test") return json({ error: "not found" }, 404);
  return json({ error: `unexpected ${url}` }, 500);
});
function BRAND_PATH_ID() {
  return BRAND;
}

const whoami = vi.fn();
vi.mock("../../src/lib/matrix/bridge.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../../src/lib/matrix/bridge.js")>();
  return {
    ...actual,
    channelAvailability: () => ({ available: true, unavailableReason: null }),
    bridgeLogins: (_channel: string, userId: string) => whoami(userId),
  };
});

const { readLineHealth, rebuildLineHealth, runLineWatchPass } = await import("../../src/lib/whatsapp/line-health.js");

/** The read is fleet-wide: other suites' lines share the database, keep ours. */
const ours = <T extends { orgId: string }>(lines: T[]) => lines.filter((l) => l.orgId === ORG || l.orgId === OTHER_ORG);

async function wipe() {
  for (const t of [whatsappLineSpans, whatsappLineDays, matrixLinks, whatsappSends]) {
    await db.delete(t).where(inArray(t.orgId, [ORG, OTHER_ORG]));
  }
}

describe.skipIf(!RUN)("WhatsApp line health (real DB)", () => {
  beforeEach(async () => {
    await wipe();
    whoami.mockReset();
    await db.insert(matrixLinks).values([
      { orgId: ORG, brandId: BRAND, channel: "whatsapp", createdByUserId: "u1", matrixUserId: "@crm_a:hs", status: "linked", method: "qr", remoteLoginId: "77776879632", linkedAt: new Date("2026-10-18T10:00:00Z") },
      { orgId: OTHER_ORG, brandId: OTHER_BRAND, channel: "whatsapp", createdByUserId: "u2", matrixUserId: "@crm_b:hs", status: "linked", method: "qr", remoteLoginId: "33770657585", linkedAt: new Date("2026-10-10T10:00:00Z") },
      // Not a line: never linked.
      { orgId: ORG, brandId: BRAND, channel: "whatsapp", createdByUserId: "u1", matrixUserId: "@crm_c:hs", status: "failed", method: "qr" },
    ]);
  });
  afterAll(wipe);

  it("every linked line, every org: a logged-out line reads not connected, a connected one connected", async () => {
    const loggedOutAt = Math.floor(Date.now() / 1000) - 3600;
    whoami.mockImplementation(async (userId: string) =>
      userId === "@crm_a:hs"
        ? [{ id: "77776879632", name: "", state: { state_event: "BAD_CREDENTIALS", message: LOGOUT, timestamp: loggedOutAt } }]
        : [{ id: "33770657585", name: "", state: { state_event: "CONNECTED" } }],
    );
    const pass = await runLineWatchPass();
    expect(pass).toMatchObject({ checked: 2, states: { logged_out: 1, connected: 1 } });

    const view = await readLineHealth(7);
    const byPhone = Object.fromEntries(ours(view.lines).map((l) => [l.phone, l]));
    expect(Object.keys(byPhone).sort()).toEqual(["+33770657585", "+77776879632"]);
    expect(byPhone["+77776879632"].current).toMatchObject({ state: "logged_out", down: true, reason: LOGOUT, bridgeState: "BAD_CREDENTIALS" });
    expect(byPhone["+77776879632"].current.since).toBe(new Date(loggedOutAt * 1000).toISOString());
    expect(byPhone["+33770657585"].current).toMatchObject({ state: "connected", down: false });
    expect(byPhone["+77776879632"].days.at(-1)).toMatchObject({ status: "down" });
    // Names in plain words; an unresolvable one is null with its reason.
    expect(byPhone["+77776879632"]).toMatchObject({ brandName: "distribute.you", orgName: "Distribute", namesUnresolvedReason: null });
    expect(byPhone["+33770657585"]).toMatchObject({ brandName: null, orgName: null });
    expect(byPhone["+33770657585"].namesUnresolvedReason).toContain("brand-service answered 404");
    // Red first.
    expect(ours(view.lines)[0].phone).toBe("+77776879632");

    // Relinked: the next pass reads it connected, the logout span ends at the relink.
    whoami.mockImplementation(async (userId: string) => [
      { id: userId === "@crm_a:hs" ? "77776879632" : "33770657585", name: "", state: { state_event: "CONNECTED" } },
    ]);
    await runLineWatchPass();
    const after = await readLineHealth(7);
    expect(after.lines.find((l) => l.phone === "+77776879632")!.current).toMatchObject({ state: "connected", down: false });
  });

  it("a bridge that does not answer reads bridge_unreachable (red), never connected", async () => {
    const { BridgeError } = await import("../../src/lib/matrix/bridge.js");
    whoami.mockRejectedValue(new BridgeError(502, "BRIDGE_UNREACHABLE", "connect ECONNREFUSED"));
    await runLineWatchPass();
    const view = await readLineHealth(1);
    expect(ours(view.lines).length).toBe(2);
    expect(ours(view.lines).every((l) => l.current.state === "bridge_unreachable" && l.current.down)).toBe(true);
  });

  it("boot backfills history from past sends and refusals, and recomputes the days", async () => {
    await db.insert(whatsappSends).values([
      { orgId: ORG, brandId: BRAND, idempotencyKey: "k1", text: "hi", status: "sent", fromAccount: "+77776879632", sentAt: new Date("2026-10-19T14:39:47Z") },
      {
        orgId: ORG,
        brandId: BRAND,
        idempotencyKey: "k2",
        text: "hi",
        status: "refused",
        errorCode: "whatsapp_not_connected",
        error: `WhatsApp logged out +77776879632 at 2026-10-19 14:39 UTC (the bridge says: "${LOGOUT}"). Relink it from the Integrations page.`,
        createdAt: new Date("2026-10-20T18:24:46Z"),
      },
      { orgId: ORG, brandId: BRAND, idempotencyKey: "k3", text: "hi", status: "sent", fromAccount: "+77776879632", sentAt: new Date("2026-10-22T18:56:52Z") },
    ]);
    // The current link was relinked at 2026-10-22 18:41.
    await db.update(matrixLinks).set({ linkedAt: new Date("2026-10-22T18:41:46Z") }).where(inArray(matrixLinks.matrixUserId, ["@crm_a:hs"]));

    const r = await rebuildLineHealth(new Date("2026-10-23T00:00:00Z"));
    expect(r.spans).toBeGreaterThan(0);
    const again = await rebuildLineHealth(new Date("2026-10-23T00:00:00Z"));
    expect(again.spans).toBe(r.spans); // idempotent

    const days = await db.select().from(whatsappLineDays).where(inArray(whatsappLineDays.phone, ["+77776879632"]));
    const byDay = Object.fromEntries(days.map((d) => [d.day, d]));
    expect(byDay["2026-10-20"]).toMatchObject({ status: "down", downMinutes: 1440 });
    expect(byDay["2026-10-21"]).toMatchObject({ status: "down", downMinutes: 1440 });
    expect(byDay["2026-10-22"]).toMatchObject({ status: "down", lastState: "connected" });
  });
});
