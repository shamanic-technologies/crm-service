/**
 * Who is the same person — decided on POSITIVE EVIDENCE only.
 *
 * A person is keyed on their email addresses and phone numbers. Two keys belong
 * to the same person only when one record states both at once: a GoHighLevel,
 * Google or Stripe contact holding an email AND a phone, a CSV row carrying both, or a
 * lead-service pairing (its `paired` verdict on a CRM contact and one of our leads). Two records sharing a key are the same
 * person (that key IS the identity). Nothing else merges: no name matching, no
 * domain matching, no model. Unmerged stays two people.
 *
 * Keys are normalised exactly, never fuzzily:
 *  - email: trimmed and lower-cased; nothing else (no Gmail dot folding).
 *  - phone: only an INTERNATIONAL number (`+` or `00` prefix, 8-15 digits) is a
 *    key, reduced to `+<digits>`. A national number ("06 12 34 56 78") carries
 *    no country, so it cannot be compared with anything and is not a key.
 */

export const PEOPLE_SOURCES = ["gmail", "instantly", "matrix", "gohighlevel", "posthog", "stripe"] as const;
export type PeopleSource = (typeof PEOPLE_SOURCES)[number];

export function normalizeEmail(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const email = raw.trim().toLowerCase();
  return /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function normalizePhone(raw: string | null | undefined): string | null {
  if (typeof raw !== "string") return null;
  const trimmed = raw.trim();
  let digits: string;
  if (trimmed.startsWith("+")) digits = trimmed.slice(1).replace(/\D/g, "");
  else if (trimmed.startsWith("00")) digits = trimmed.slice(2).replace(/\D/g, "");
  else return null;
  return digits.length >= 8 && digits.length <= 15 ? `+${digits}` : null;
}

export const emailKey = (email: string) => `email:${email}`;
export const phoneKey = (phone: string) => `phone:${phone}`;

/** One source record a person appears on. */
export interface Presence {
  source: PeopleSource;
  /** The record's id in its source (an email, a contact id). */
  sourceRef: string;
  displayName: string | null;
  company: string | null;
  emails: string[];
  phones: string[];
  firstActivityAt: string | null;
  lastActivityAt: string | null;
  messageCount: number | null;
  inboundCount: number | null;
  outboundCount: number | null;
  detail: Record<string, unknown>;
}

export const EVIDENCE_KINDS = [
  "google_contact",
  "gohighlevel_contact",
  "csv_contact",
  "lead_pairing",
  "stripe_customer",
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];

/** A record that ties keys together without itself being a conversation. */
export interface Evidence {
  kind: EvidenceKind;
  ref: string;
  displayName: string | null;
  company: string | null;
  emails: string[];
  phones: string[];
}

/** The keys a record states. A record with neither email nor phone gets its own. */
export function keysOf(record: { emails: string[]; phones: string[] }, fallback: string | null): string[] {
  const keys = new Set<string>();
  for (const e of record.emails) {
    const n = normalizeEmail(e);
    if (n) keys.add(emailKey(n));
  }
  for (const p of record.phones) {
    const n = normalizePhone(p);
    if (n) keys.add(phoneKey(n));
  }
  if (keys.size === 0 && fallback) keys.add(fallback);
  return [...keys];
}

export const presenceFallbackKey = (p: Presence) => `${p.source}:${p.sourceRef}`;

export interface PersonCluster {
  personKey: string;
  identityKeys: string[];
  emails: string[];
  phones: string[];
  presences: Presence[];
  evidence: Evidence[];
}

/** The smallest email key, else the smallest phone key, else the smallest key. */
export function pickPersonKey(keys: string[]): string {
  const sorted = [...keys].sort();
  return (
    sorted.find((k) => k.startsWith("email:")) ??
    sorted.find((k) => k.startsWith("phone:")) ??
    sorted[0]
  );
}

/**
 * Group presences into people. Evidence only CONNECTS keys: a cluster holding
 * evidence but no presence is nobody the brand is in conversation with, and is
 * dropped. Deterministic: the same input always yields the same people, in
 * person-key order.
 */
export function clusterPeople(presences: Presence[], evidence: Evidence[]): PersonCluster[] {
  const parent = new Map<string, string>();
  const find = (k: string): string => {
    let root = k;
    while (parent.get(root) !== root) root = parent.get(root)!;
    let cur = k;
    while (parent.get(cur) !== root) {
      const next = parent.get(cur)!;
      parent.set(cur, root);
      cur = next;
    }
    return root;
  };
  const add = (k: string) => {
    if (!parent.has(k)) parent.set(k, k);
  };
  const union = (keys: string[]) => {
    keys.forEach(add);
    for (let i = 1; i < keys.length; i++) {
      const a = find(keys[0]);
      const b = find(keys[i]);
      if (a !== b) parent.set(a < b ? b : a, a < b ? a : b);
    }
  };

  const presenceKeys = presences.map((p) => keysOf(p, presenceFallbackKey(p)));
  presenceKeys.forEach(union);
  const evidenceKeys = evidence.map((e) => keysOf(e, null));
  evidenceKeys.forEach((keys) => {
    if (keys.length > 0) union(keys);
  });

  const byRoot = new Map<string, { keys: Set<string>; presences: Presence[]; evidence: Evidence[] }>();
  const bucket = (root: string) => {
    let b = byRoot.get(root);
    if (!b) {
      b = { keys: new Set(), presences: [], evidence: [] };
      byRoot.set(root, b);
    }
    return b;
  };
  presences.forEach((p, i) => {
    const b = bucket(find(presenceKeys[i][0]));
    presenceKeys[i].forEach((k) => b.keys.add(k));
    b.presences.push(p);
  });
  evidence.forEach((e, i) => {
    if (evidenceKeys[i].length === 0) return;
    const root = find(evidenceKeys[i][0]);
    const b = byRoot.get(root);
    if (!b) return;
    // Evidence only counts when it actually tied two keys of this person.
    if (evidenceKeys[i].length > 1) b.evidence.push(e);
    evidenceKeys[i].forEach((k) => b.keys.add(k));
  });

  const clusters: PersonCluster[] = [];
  for (const b of byRoot.values()) {
    if (b.presences.length === 0) continue;
    const identityKeys = [...b.keys].sort();
    clusters.push({
      personKey: pickPersonKey(identityKeys),
      identityKeys,
      emails: identityKeys.filter((k) => k.startsWith("email:")).map((k) => k.slice(6)),
      phones: identityKeys.filter((k) => k.startsWith("phone:")).map((k) => k.slice(6)),
      presences: b.presences,
      evidence: b.evidence,
    });
  }
  return clusters.sort((a, b) => (a.personKey < b.personKey ? -1 : a.personKey > b.personKey ? 1 : 0));
}
