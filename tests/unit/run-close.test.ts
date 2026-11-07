import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

/**
 * POSTHOG-RUNCLOSE-1107: closing a run is bookkeeping. It retries, logs loud with the run id + context when runs-service
 * keeps refusing, schedules one late retry, and never throws. `connectionErrorText` is the plain-words last_error.
 */
process.env.RUN_CLOSE_RETRY_DELAYS_MS = "1,1";
process.env.RUN_CLOSE_LATE_RETRY_MS = "5";

const { RunsServiceError } = await import("../../src/lib/runs-client.js");
const { closeRun, closePlatformRun, connectionErrorText, isRunTrackingFailure } = await import("../../src/lib/run-close.js");

const timeout = (path: string) =>
  new RunsServiceError({ kind: "timeout", path, method: "PATCH", message: `runs-service PATCH ${path} timed out after 10000ms` });

let patches: string[] = [];
let failuresLeft = 0;

beforeEach(() => {
  patches = [];
  vi.stubGlobal("fetch", async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    patches.push(`${init?.method} ${url.pathname}`);
    if (failuresLeft > 0) {
      failuresLeft--;
      const e = new Error("aborted");
      e.name = "AbortError";
      throw e;
    }
    return new Response(JSON.stringify({ id: "r" }), { status: 200, headers: { "content-type": "application/json" } });
  });
});
afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe("closeRun", () => {
  it("closes on a retry after a timeout, without throwing", async () => {
    failuresLeft = 1;
    await expect(closeRun("run-1", "completed", { orgId: "o" }, "posthog connection c1")).resolves.toBe(true);
    expect(patches).toEqual(["PATCH /v1/runs/run-1", "PATCH /v1/runs/run-1"]);
  });

  it("never throws when runs-service keeps timing out: logs loud with run id + context, then closes on the late retry", async () => {
    failuresLeft = 3;
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(closeRun("run-2", "completed", { orgId: "o" }, "posthog connection c2")).resolves.toBe(false);
    expect(patches).toHaveLength(3);
    expect(String(errors.mock.calls[0][0])).toContain("posthog connection c2 run run-2");
    await new Promise((r) => setTimeout(r, 30));
    expect(patches).toHaveLength(4); // the late retry closed it
  });

  it("closes a platform run the same way", async () => {
    failuresLeft = 3;
    vi.spyOn(console, "error").mockImplementation(() => {});
    vi.spyOn(console, "log").mockImplementation(() => {});
    await expect(closePlatformRun("p-1", "failed", "crm-service", "posthog pass")).resolves.toBe(false);
    expect(patches[0]).toBe("PATCH /v1/platform-runs/p-1");
  });
});

describe("connectionErrorText", () => {
  it("quotes the vendor's own refusal, in plain words", () => {
    const refused = Object.assign(new Error("PostHog query returned 401: bad key"), {
      status: 401,
      vendorMessage: "Personal API key found in request Authorization header is invalid.",
    });
    expect(connectionErrorText("PostHog", refused)).toBe(
      "PostHog refused the key: Personal API key found in request Authorization header is invalid.",
    );
    const missing = Object.assign(new Error("x"), { status: 404, vendorMessage: "Project not found" });
    expect(connectionErrorText("PostHog", missing)).toBe("PostHog could not find this account or project: Project not found");
  });

  it("a missing key says so, without naming our services", () => {
    const text = connectionErrorText("PostHog", new Error("no PostHog credential stored for brand b1 — store it in key-service first"));
    expect(text).toBe("No PostHog key is saved for this brand. Connect PostHog again.");
  });

  it("our own plumbing never leaks", () => {
    const text = connectionErrorText("Stripe", new Error("key-service GET /internal/x returned 500: boom"));
    expect(text).not.toMatch(/key-service|runs-service|500|crm-service/);
    expect(text).toBe("We could not read your Stripe data on the last try. The next read tries again on its own.");
  });

  it("run tracking failures are recognised as ours", () => {
    expect(isRunTrackingFailure(timeout("/v1/runs/x"))).toBe(true);
    expect(isRunTrackingFailure(new Error("PostHog query returned 401"))).toBe(false);
  });
});
