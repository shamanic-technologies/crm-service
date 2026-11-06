/**
 * THE BRAND'S OWN ADDRESSES, AND WHICH MAILS ARE BETWEEN A PERSON AND US.
 *
 * Own addresses = the org's connected Gmail mailboxes (google-service `GET /orgs/google/accounts`), every sending
 * mailbox (instantly-service) and the brand's domain (brand-service): `readOwnAddresses` + the mailboxes. Read by the
 * Gmail reply trigger (reply-trigger/gmail.ts: own address, addressed to the brand) and by the person's timeline.
 *
 * SOPHIE-WA-HUMAN-1106 (owner 2026-11-04, « complètement à côté de la plaque »): google-service's conversation "with
 * an address" is every mail of the connected mailbox naming it. When the person IS the mailbox owner (Kevin's person
 * holds kevin.lourd@gmail.com, the distribute.you org's connected mailbox), that is the whole mailbox: his mail to a
 * third party read as « THEM », the newsletters landing in it as « US », and the assistant answered a deal it was
 * never part of. A message belongs to a person's thread with us only when it goes between THEM and US
 * (`exchangedWithUs`), for every person, no special case.
 */
import { normalizeEmail } from "./identity.js";
import { isOwnAddress, readOwnAddresses, type OwnAddresses } from "./sources.js";
import { siblingGet, type SiblingIdentity } from "./siblings.js";

export interface BrandAddresses {
  /** Sending mailboxes + the brand's domain (people/sources.ts). */
  addresses: OwnAddresses;
  /** The org's connected Gmail mailboxes (google-service `GET /orgs/google/accounts`). */
  mailboxes: Set<string>;
}

/** PURE: the address is the brand's own (connected mailbox, sending mailbox, domain). */
export function isBrandAddress(email: string, own: BrandAddresses): boolean {
  const e = normalizeEmail(email);
  return !!e && (own.mailboxes.has(e) || isOwnAddress(e, own.addresses));
}

/** PURE: the mail is addressed TO the brand: one of its addresses in To, or no To at all (Bcc: benefit of the doubt). */
export function addressedToBrand(to: string[], own: BrandAddresses): boolean {
  return to.length === 0 || to.some((t) => isBrandAddress(t, own));
}

/**
 * PURE: the mail went between the person and us (SOPHIE-WA-HUMAN-1106). From the person to one of our addresses, or
 * from one of our addresses to the person. A mail with no recipient (a draft, a Bcc) counts only when its sender is
 * on ONE side: the person's mail Bcc'd to us, or ours Bcc'd to them; a sender who is both (the person owns our
 * mailbox) names nobody on the other side. Anything else (the person writing to a third party, a newsletter landing
 * in a mailbox we mirror) is not a message between them and us.
 */
export function exchangedWithUs(mail: { from: string | null; to: readonly string[] }, personEmails: ReadonlySet<string>, own: BrandAddresses): boolean {
  const from = normalizeEmail(mail.from);
  if (!from) return false;
  const fromPerson = personEmails.has(from);
  const fromUs = isBrandAddress(from, own);
  if (!fromPerson && !fromUs) return false;
  const to = mail.to.map((t) => normalizeEmail(t)).filter((t): t is string => !!t && t !== from);
  if (to.length === 0) return mail.to.length === 0 && fromPerson !== fromUs;
  return to.some((t) => (fromPerson && isBrandAddress(t, own)) || (fromUs && personEmails.has(t)));
}

/** Read the brand's own addresses + the org's connected mailboxes. Throws when either is unreadable. */
export async function readBrandAddresses(identity: SiblingIdentity): Promise<BrandAddresses> {
  const [read, accounts] = await Promise.all([readOwnAddresses(identity), siblingGet("google", "/orgs/google/accounts", identity)]);
  if (read.status !== "ok") throw new Error(`own addresses unreadable: ${read.error}`);
  if (accounts.status !== 200) {
    throw new Error(`google-service GET /orgs/google/accounts returned ${accounts.status}: ${JSON.stringify(accounts.body).slice(0, 300)}`);
  }
  const mailboxes = new Set<string>();
  for (const a of (accounts.body as { accounts?: { email?: string | null }[] } | null)?.accounts ?? []) {
    const e = normalizeEmail(a.email ?? null);
    if (e) mailboxes.add(e);
  }
  return { addresses: read, mailboxes };
}

/** How long the timeline reuses one read of a brand's own addresses (they change when a mailbox is linked). */
export const BRAND_ADDRESSES_TTL_MS = 5 * 60_000;
const cache = new Map<string, { at: number; value: Promise<BrandAddresses> }>();

/** `readBrandAddresses`, reused for `BRAND_ADDRESSES_TTL_MS` per (org, brand); a failed read is never kept. */
export function cachedBrandAddresses(identity: SiblingIdentity, now: number = Date.now()): Promise<BrandAddresses> {
  const key = `${identity.orgId}|${identity.brandId}`;
  const hit = cache.get(key);
  if (hit && now - hit.at < BRAND_ADDRESSES_TTL_MS) return hit.value;
  const value = readBrandAddresses(identity);
  cache.set(key, { at: now, value });
  value.catch(() => {
    if (cache.get(key)?.value === value) cache.delete(key);
  });
  return value;
}

/** Tests only. */
export function clearBrandAddressesCache(): void {
  cache.clear();
}
