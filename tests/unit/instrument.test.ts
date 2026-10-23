import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

describe("instrument (Sentry init)", () => {
  const originalDsn = process.env.SENTRY_DSN;

  beforeEach(() => {
    vi.resetModules();
  });

  afterEach(() => {
    if (originalDsn !== undefined) process.env.SENTRY_DSN = originalDsn;
    else delete process.env.SENTRY_DSN;
    vi.restoreAllMocks();
  });

  function mockSentry() {
    const init = vi.fn();
    const setTag = vi.fn();
    vi.doMock("@sentry/node", () => ({ init, setTag }));
    return { init, setTag };
  }

  it("does not initialize Sentry without SENTRY_DSN", async () => {
    delete process.env.SENTRY_DSN;
    const { init, setTag } = mockSentry();

    await import("../../src/instrument.js");

    expect(init).not.toHaveBeenCalled();
    expect(setTag).not.toHaveBeenCalled();
  });

  it("initializes Sentry with the same config and leaves ESM loader hooks on the v9+ default", async () => {
    process.env.SENTRY_DSN = "https://fake@sentry.io/123";
    const { init, setTag } = mockSentry();

    await import("../../src/instrument.js");

    const config = init.mock.calls[0][0];
    expect(config).toMatchObject({
      dsn: "https://fake@sentry.io/123",
      tracesSampleRate: 0.1,
      sendDefaultPii: true,
    });
    // @sentry/node >= 9 accepts only a boolean here and wraps only
    // instrumented modules, so drizzle-orm is never wrapped.
    expect(config.registerEsmLoaderHooks).toBeUndefined();
    expect(setTag).toHaveBeenCalledWith("service", "crm-service");
  });
});
