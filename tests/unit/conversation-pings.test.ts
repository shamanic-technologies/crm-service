import { describe, it, expect } from "vitest";
import { anyStaff, uniboxThreadUrl } from "../../src/lib/conversation-pings.js";
import { isStaffEmail } from "../../src/lib/owner-telegram.js";

describe("staff never pings", () => {
  it("knows the owner's addresses, plus-addressing and the whole @distribute.you domain", () => {
    for (const e of ["kevin@distribute.you", "Kevin.Lourd@gmail.com", "kevin.lourd+test@gmail.com", "kevin@pressbeat.io", "anyone@distribute.you"]) {
      expect(isStaffEmail(e)).toBe(true);
    }
    for (const e of ["jane@prospect.io", "kevin@gmail.com", "", null, undefined]) {
      expect(isStaffEmail(e)).toBe(false);
    }
  });

  it("a user id ever seen with a staff address is staff", () => {
    expect(anyStaff(["jane@prospect.io", "kevin.lourd@gmail.com"])).toBe(true);
    expect(anyStaff(["jane@prospect.io"])).toBe(false);
  });
});

describe("the thread link", () => {
  it("opens the person in the staff Unibox", () => {
    expect(uniboxThreadUrl("org_abc", "b1", "p1")).toBe("https://dashboard.distribute.you/v2/orgs/org_abc/brands/b1/unibox?person=p1");
  });
});
