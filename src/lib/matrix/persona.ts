/**
 * A linked account's sender persona (SOPHIE-WA-1016), shared by the link views
 * and the WhatsApp send / reach.
 */

/**
 * The sender persona the brand gave a linked account (SOPHIE-WA-1016): a
 * workflow renders "You are <name>, <role>" from the account that will send.
 * Null when the brand stated none of the three.
 */
export interface SenderPersona {
  name: string | null;
  role: string | null;
  instructions: string | null;
}

/** PURE: the persona of a link row, null when every field is empty. */
export function personaOf(row: { personaName: string | null; personaRole: string | null; personaInstructions: string | null }): SenderPersona | null {
  if (!row.personaName && !row.personaRole && !row.personaInstructions) return null;
  return { name: row.personaName, role: row.personaRole, instructions: row.personaInstructions };
}
