import { describe, it, expect } from "vitest";
import { matchStoredRows } from "../../src/lib/people/item-fill.js";

const ref = { rowId: "old-id", scopeId: "s1", source: "instantly", unit: "c1:a@x.io", messageKey: "k1" };
const row = (id: string, messageKey: string, text: string) => ({
  id,
  scopeId: "s1",
  source: "instantly",
  unit: "c1:a@x.io",
  messageKey,
  item: { text, textClean: null },
});

describe("a paged thread's message text (UNIBOX-TEXT-ON-REREAD-1112)", () => {
  it("found by its row id while the row stands", () => {
    expect(matchStoredRows([ref], [row("old-id", "k1", "Hi Amerigo")]).get("old-id")?.text).toBe("Hi Amerigo");
  });

  it("found by its key when a re-read of the thread re-wrote the row under a new id", () => {
    expect(matchStoredRows([ref], [row("new-id", "k1", "Hi Amerigo")]).get("old-id")?.text).toBe("Hi Amerigo");
  });

  it("null only when the message left the store, never another message's text", () => {
    expect(matchStoredRows([ref], [row("new-id", "k2", "Other email")]).get("old-id")).toBeNull();
  });
});
