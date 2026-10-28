/**
 * THE TYPE OF EVERY LINKED ACCOUNT (ACCOUNT-TYPES-1028).
 *
 * Owner 2026-10-28: « la possibilité de créer des comptes pro (human), des
 * comptes perso (human), ou des comptes pro (AI) ». Every account a brand links
 * (WhatsApp, LinkedIn, Telegram...) carries ONE type the brand picks
 * (`matrix_links.account_type`, PATCH /orgs/matrix/links/{linkId} `accountType`):
 *  - `pro_ai`: automated sends write from it. Any number of them per brand and
 *    channel (no cap: « tu es en train de faire plein d'exceptions là »); an
 *    automated send picks among them, the one the person already talks with first;
 *  - `pro_human`: a person of the brand's work line; an automated send writes
 *    from it only when the send asks for it (`fromAccountType: "pro_human"`);
 *  - `personal_human`: the person's private line, mirrored for the Unibox,
 *    NEVER written from by automation and never fires an automated reply.
 * null = not typed yet: the pick is the one before types existed.
 * Same three values as meta-service's Threads accounts.
 *
 * SOPHIE-SENDS-1028 roles are the same thing under older words, kept readable
 * and writable: `assistant` = `pro_ai`, `founder` = `pro_human`.
 * A type is never inferred from a number or a persona: only what the brand stated.
 */

export const ACCOUNT_TYPES = ["pro_human", "personal_human", "pro_ai"] as const;
export type AccountType = (typeof ACCOUNT_TYPES)[number];

/** The types an automated send may ask for (`fromAccountType`): never the personal one. */
export const SENDING_ACCOUNT_TYPES = ["pro_human", "pro_ai"] as const;
export type SendingAccountType = (typeof SENDING_ACCOUNT_TYPES)[number];

/** SOPHIE-SENDS-1028 words, kept for the callers that use them. */
export const LINE_ROLES = ["assistant", "founder"] as const;
export type LineRole = (typeof LINE_ROLES)[number];

export function isAccountType(v: unknown): v is AccountType {
  return typeof v === "string" && (ACCOUNT_TYPES as readonly string[]).includes(v);
}

export function accountTypeOfRole(role: LineRole): SendingAccountType {
  return role === "assistant" ? "pro_ai" : "pro_human";
}

/** The older role word of a type (served as `lineRole`), null for personal / untyped. */
export function roleOfAccountType(type: AccountType | null): LineRole | null {
  return type === "pro_ai" ? "assistant" : type === "pro_human" ? "founder" : null;
}

/** May automation write from / answer on this account: the brand allows it AND it is not a personal line. */
export function automationOn(a: { automationAllowed: boolean; accountType: AccountType | null }): boolean {
  return a.automationAllowed && a.accountType !== "personal_human";
}

/**
 * PURE: the linked accounts an automated send may pick from, narrowed by what
 * the request names and what the brand stated. `fromAccount` (a number) wins,
 * then the type asked, then every `pro_ai` account when the brand typed one,
 * else every account. Personal lines are dropped later with the other accounts
 * automation may not use (`automationOn`), so the refusal names them.
 */
export function narrowByType<T extends { loginId: string; accountType: AccountType | null }>(
  linked: T[],
  ask: { fromAccountDigits: string | null; fromAccountType: SendingAccountType | null },
): { accounts: T[]; by: "account" | "type" | "pro_ai" | "none" } {
  if (ask.fromAccountDigits) {
    return { accounts: linked.filter((a) => a.loginId.replace(/\D/g, "") === ask.fromAccountDigits), by: "account" };
  }
  if (ask.fromAccountType) return { accounts: linked.filter((a) => a.accountType === ask.fromAccountType), by: "type" };
  const ai = linked.filter((a) => a.accountType === "pro_ai");
  if (ai.length > 0) return { accounts: ai, by: "pro_ai" };
  return { accounts: linked, by: "none" };
}
