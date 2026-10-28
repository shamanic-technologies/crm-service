import { describe, expect, it } from "vitest";
import {
  accountTypeOfRole,
  automationOn,
  narrowByType,
  roleOfAccountType,
  type AccountType,
} from "../../src/lib/matrix/account-types.js";

const a = (loginId: string, accountType: AccountType | null) => ({ loginId, accountType });

describe("account types (ACCOUNT-TYPES-1028)", () => {
  it("nothing typed: every account, the pick is the one before types", () => {
    const plain = [a("1", null), a("2", null)];
    expect(narrowByType(plain, { fromAccountDigits: null, fromAccountType: null })).toEqual({ accounts: plain, by: "none" });
  });

  it("every pro_ai account is a candidate, no cap per type", () => {
    const lines = [a("1", "pro_human"), a("2", "pro_ai"), a("3", "pro_ai"), a("4", "personal_human")];
    expect(narrowByType(lines, { fromAccountDigits: null, fromAccountType: null })).toEqual({ accounts: [lines[1], lines[2]], by: "pro_ai" });
  });

  it("a type asked narrows to it; a number asked wins", () => {
    const lines = [a("1", "pro_human"), a("2", "pro_ai"), a("33633333333", null)];
    expect(narrowByType(lines, { fromAccountDigits: null, fromAccountType: "pro_human" }).accounts).toEqual([lines[0]]);
    expect(narrowByType([a("1", null)], { fromAccountDigits: null, fromAccountType: "pro_human" })).toEqual({ accounts: [], by: "type" });
    expect(narrowByType(lines, { fromAccountDigits: "33633333333", fromAccountType: null })).toEqual({ accounts: [lines[2]], by: "account" });
  });

  it("a personal line is never automated, whatever its automation flag", () => {
    expect(automationOn({ automationAllowed: true, accountType: "personal_human" })).toBe(false);
    expect(automationOn({ automationAllowed: true, accountType: "pro_human" })).toBe(true);
    expect(automationOn({ automationAllowed: true, accountType: null })).toBe(true);
    expect(automationOn({ automationAllowed: false, accountType: "pro_ai" })).toBe(false);
  });

  it("SOPHIE-SENDS-1028 roles read as types and back", () => {
    expect(accountTypeOfRole("assistant")).toBe("pro_ai");
    expect(accountTypeOfRole("founder")).toBe("pro_human");
    expect(roleOfAccountType("pro_ai")).toBe("assistant");
    expect(roleOfAccountType("pro_human")).toBe("founder");
    expect(roleOfAccountType("personal_human")).toBeNull();
    expect(roleOfAccountType(null)).toBeNull();
  });
});
