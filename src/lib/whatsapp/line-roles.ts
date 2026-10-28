/**
 * WHICH LINKED LINE AN AUTOMATED SEND WRITES FROM, BY ROLE (SOPHIE-SENDS-1028).
 *
 * Owner 2026-10-28: « les campagnes de base envoient via Sophie. Mais juste une
 * welcome WA de plus en parallèle depuis mon WA pro ». A brand with several
 * linked lines states, per line, a role (`matrix_links.line_role`, set with
 * PATCH /orgs/matrix/links/{linkId} `lineRole`), one line per role:
 *  - `assistant`: EVERY automated send writes from it, even for a person whose
 *    conversation is on another linked line (the default pick by conversation
 *    / outreach default no longer applies);
 *  - `founder`: only a send (or reach check) asking `fromLine: "founder"`
 *    writes from it (a founder hello next to the assistant's messages).
 * Nothing stated = the pick is unchanged (conversation > outreach default > oldest).
 * A role is never inferred from a number or a persona: only what the brand stated.
 */

export const LINE_ROLES = ["assistant", "founder"] as const;
export type LineRole = (typeof LINE_ROLES)[number];

export function isLineRole(v: unknown): v is LineRole {
  return typeof v === "string" && (LINE_ROLES as readonly string[]).includes(v);
}

/**
 * PURE: the linked accounts a send may pick from, narrowed by what the request
 * names and what the brand stated. `fromAccount` (a number) wins, then
 * `fromLine` (a role), then the brand's assistant line when one is stated.
 * Returns the narrowed list and how it was narrowed (for the refusal words).
 */
export function narrowByLine<T extends { loginId: string; lineRole: LineRole | null }>(
  linked: T[],
  ask: { fromAccountDigits: string | null; fromLine: LineRole | null },
): { accounts: T[]; by: "account" | "line" | "assistant" | "none" } {
  if (ask.fromAccountDigits) {
    return { accounts: linked.filter((a) => a.loginId.replace(/\D/g, "") === ask.fromAccountDigits), by: "account" };
  }
  if (ask.fromLine) return { accounts: linked.filter((a) => a.lineRole === ask.fromLine), by: "line" };
  const assistant = linked.filter((a) => a.lineRole === "assistant");
  if (assistant.length > 0) return { accounts: assistant, by: "assistant" };
  return { accounts: linked, by: "none" };
}
