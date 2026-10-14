import { describe, it, expect } from "vitest";
import { decodeCursor, pageOf, type TimelineItem } from "../../src/lib/people/timeline.js";

const item = (at: string | null, id: string, source: TimelineItem["source"] = "gmail"): TimelineItem => ({
  at,
  source,
  channel: "email",
  kind: "message",
  direction: "inbound",
  subject: null,
  text: id,
  from: null,
  to: [],
  ref: { id },
  textClean: null,
  outreachFact: null,
  event: null,
});

describe("timeline pages (DASH-LATENCY-1014)", () => {
  const thread = [
    item("2026-10-01T00:00:00Z", "a"),
    item(null, "undated"),
    item("2026-10-03T00:00:00Z", "c"),
    item("2026-10-02T00:00:00Z", "b2"),
    item("2026-10-02T00:00:00Z", "b1"), // same instant: ordered by identity
    item("2026-10-04T00:00:00Z", "d", "posthog"),
  ];
  const texts = (xs: TimelineItem[]) => xs.map((x) => x.text);

  it("the latest page first, oldest first inside it; undated last as in the whole thread", () => {
    const p = pageOf(thread, 2, null);
    expect(texts(p.items)).toEqual(["d", "undated"]);
    expect(p).toMatchObject({ totalItems: 6, hasOlder: true });
  });

  it("walking olderCursor returns every item exactly once, in order", () => {
    const walked: TimelineItem[] = [];
    let before = null as ReturnType<typeof decodeCursor>;
    for (;;) {
      const p = pageOf(thread, 2, before);
      walked.unshift(...p.items);
      if (!p.olderCursor) {
        expect(p.hasOlder).toBe(false);
        break;
      }
      before = decodeCursor(p.olderCursor);
    }
    expect(texts(walked)).toEqual(["a", "b1", "b2", "c", "d", "undated"]);
  });

  it("a new message does not shift an older page: the cursor names a position, not an offset", () => {
    const p1 = pageOf(thread, 2, null);
    const later = [...thread, item("2026-10-05T00:00:00Z", "e")];
    expect(texts(pageOf(later, 2, decodeCursor(p1.olderCursor!)).items)).toEqual(["b2", "c"]);
  });

  it("a cursor we never minted is refused", () => {
    expect(decodeCursor("not-a-cursor")).toBeNull();
    expect(decodeCursor(Buffer.from(JSON.stringify({ at: "x", k: 1 })).toString("base64url"))).toBeNull();
  });
});
