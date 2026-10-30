import { describe, it, expect } from "vitest";
import { activityLine, noDashes } from "../../src/lib/account-activity/line.js";
import { composeActivityPing } from "../../src/lib/account-activity/activity.js";

describe("account activity line (CLIENT-ACTIVITY-1030)", () => {
  it("names who, what, the campaign, and each change before to after", () => {
    expect(activityLine({ title: "Campaign created", subject: { name: "ABA Owners Meetings" }, changes: [], actorName: "Chaim Tesser" })).toBe(
      'Chaim Tesser · Campaign created: "ABA Owners Meetings"',
    );
    expect(
      activityLine({
        title: "Budget changed",
        subject: { name: "ABA Owners Meetings" },
        changes: [{ label: "Daily budget", before: "$20/day", after: "$50/day" }],
        actorName: "Chaim Tesser",
      }),
    ).toBe('Chaim Tesser · Budget changed: "ABA Owners Meetings" · Daily budget: $20/day to $50/day');
    expect(activityLine({ title: "Campaign paused", subject: null, changes: [{ label: "Cap", before: null, after: "$5" }] })).toBe(
      "Campaign paused · Cap: none to $5",
    );
  });

  it("never an em or en dash", () => {
    expect(noDashes("Budget — up")).toBe("Budget - up");
    expect(noDashes("$20–$50")).toBe("$20-$50");
    expect(activityLine({ title: "Campaign edited — name", subject: { name: "A – B" }, changes: [] })).not.toMatch(/[—–]/);
  });

  it("the ping: the line, then who, org, brand, via, thread; absent lines dropped", () => {
    expect(
      composeActivityPing({ line: "Jane · Campaign created", email: "jane@x.io", name: null, orgName: null, brandName: null, via: null, threadUrl: null }),
    ).toBe("Jane · Campaign created\nWho: jane@x.io");
  });
});
