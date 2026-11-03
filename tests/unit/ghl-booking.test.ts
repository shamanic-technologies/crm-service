import { describe, it, expect } from "vitest";
import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { endTimeOf, matchOpenSlot, resolveCalendar, utcOffsetOf } from "../../src/lib/gohighlevel/booking.js";

const CALS = [
  { id: "calA", widgetSlug: "discovery-30", name: "A" },
  { id: "calB", widgetSlug: "onboarding", name: "B" },
];

describe("resolveCalendar (AUTO-BOOK-1103)", () => {
  it("finds the page's calendar by id or widget slug, among the location's own", () => {
    expect(resolveCalendar(CALS, { bookingPageUrl: "https://api.leadconnectorhq.com/widget/booking/calB" })?.id).toBe("calB");
    expect(resolveCalendar(CALS, { bookingPageUrl: "https://book.brand.com/widget/bookings/discovery-30?x=1" })?.id).toBe("calA");
    expect(resolveCalendar(CALS, { bookingPageUrl: "https://book.brand.com/widget/bookings/other" })).toBeNull();
    expect(resolveCalendar(CALS, { bookingPageUrl: "not a url" })).toBeNull();
  });
  it("a given calendar id wins, and must be one of the location's", () => {
    expect(resolveCalendar(CALS, { calendarId: "calA", bookingPageUrl: "https://x/widget/booking/calB" })?.id).toBe("calA");
    expect(resolveCalendar(CALS, { calendarId: "elsewhere" })).toBeNull();
  });
});

describe("slots", () => {
  it("matches the asked instant whatever offset it is written in", () => {
    const slots = ["2026-11-05T13:00:00-05:00", "2026-11-05T13:30:00-05:00"];
    expect(matchOpenSlot("2026-11-05T18:00:00Z", slots)).toBe("2026-11-05T13:00:00-05:00");
    expect(matchOpenSlot("2026-11-05T19:30:00+02:00", slots)).toBeNull();
    expect(matchOpenSlot("garbage", slots)).toBeNull();
  });
  it("offset and end time", () => {
    expect(utcOffsetOf("2026-11-05T13:00:00-05:00")).toBe("-05:00");
    expect(utcOffsetOf("2026-11-05T13:00:00Z")).toBe("+00:00");
    expect(endTimeOf("2026-11-05T13:00:00-05:00", { id: "c", slotDuration: 1, slotDurationUnit: "hours" })).toBe("2026-11-05T19:00:00.000Z");
    expect(endTimeOf("2026-11-05T13:00:00-05:00", { id: "c" })).toBeUndefined();
  });
});

describe("GoHighLevel writes stay in one place", () => {
  function files(dir: string): string[] {
    return readdirSync(dir).flatMap((f) => {
      const p = join(dir, f);
      return statSync(p).isDirectory() ? files(p) : p.endsWith(".ts") ? [p] : [];
    });
  }
  it("only booking.ts imports the write client; the read client never POSTs", () => {
    const importers = files("src").filter((f) => readFileSync(f, "utf8").includes("booking-client.js"));
    expect(importers.map((f) => f.replace(/\\/g, "/"))).toEqual(["src/lib/gohighlevel/booking.ts"]);
    expect(readFileSync("src/lib/gohighlevel/client.ts", "utf8")).not.toMatch(/method:\s*"(POST|PUT|PATCH|DELETE)"/);
  });
});
