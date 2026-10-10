/**
 * The person's OPAQUE id: a random uuid carrying no personal data, safe to put
 * in a URL, a shared link or an analytics event (an `email:` / `phone:` person
 * key is not). The `people` rows are deleted and re-inserted on every build, so
 * their row ids change; this id does not.
 *
 * It is carried over by the person's identity keys. `person_ids` remembers which
 * id every key belongs to, per (org, brand), and is never wiped by a build. At
 * each build every person takes the id its keys already point at:
 *
 *  - nothing known (a new person)          → a fresh random uuid;
 *  - every key points at one id            → that id (the everyday case);
 *  - MERGE: keys point at two ids or more  → the id holding the most of the
 *    person's keys wins (tie: the older id, then the smaller); every other id
 *    is RETIRED into it (`person_id_aliases`), so a link holding a retired id
 *    still opens the merged person;
 *  - SPLIT: two people share one old id    → the part holding the most of its
 *    keys keeps it (tie: the smaller person key); the other part gets a fresh
 *    id, kept from then on;
 *  - a person who vanishes keeps their keys' memory: if they come back, same id.
 *
 * Every key of every person is then pointed at that person's id, in the same
 * transaction as the rebuilt rows.
 */

import { randomUUID } from "node:crypto";
import { and, eq, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { people, personIdAliases, personIds, type Person } from "../../db/schema.js";

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

export interface KnownKey {
  personId: string;
  createdAt: Date;
}

export interface PersonIdAssignment {
  /** person key → opaque person id */
  ids: Map<string, string>;
  /** ids retired by a merge, each pointing at the id that absorbed it */
  retired: { retiredId: string; personId: string }[];
}

/** Pure: which id each person takes, given what the keys remember. Deterministic but for minting. */
export function assignPersonIds(
  persons: { personKey: string; identityKeys: string[] }[],
  known: Map<string, KnownKey>,
  mint: () => string = randomUUID,
): PersonIdAssignment {
  const age = new Map<string, number>();
  for (const k of known.values()) {
    const t = k.createdAt.getTime();
    if (!age.has(k.personId) || t < age.get(k.personId)!) age.set(k.personId, t);
  }

  const pairs: { personKey: string; id: string; count: number }[] = [];
  for (const p of persons) {
    const counts = new Map<string, number>();
    for (const key of p.identityKeys) {
      const k = known.get(key);
      if (k) counts.set(k.personId, (counts.get(k.personId) ?? 0) + 1);
    }
    for (const [id, count] of counts) pairs.push({ personKey: p.personKey, id, count });
  }
  pairs.sort(
    (a, b) =>
      b.count - a.count ||
      age.get(a.id)! - age.get(b.id)! ||
      (a.id < b.id ? -1 : a.id > b.id ? 1 : 0) ||
      (a.personKey < b.personKey ? -1 : a.personKey > b.personKey ? 1 : 0),
  );

  const ids = new Map<string, string>();
  const taken = new Set<string>();
  for (const pair of pairs) {
    if (ids.has(pair.personKey) || taken.has(pair.id)) continue;
    ids.set(pair.personKey, pair.id);
    taken.add(pair.id);
  }
  for (const p of persons) if (!ids.has(p.personKey)) ids.set(p.personKey, mint());

  // An old id no person kept was absorbed: it points at the person holding most of its keys.
  const retired: PersonIdAssignment["retired"] = [];
  const seen = new Set<string>();
  for (const pair of pairs) {
    if (taken.has(pair.id) || seen.has(pair.id)) continue;
    seen.add(pair.id);
    retired.push({ retiredId: pair.id, personId: ids.get(pair.personKey)! });
  }
  return { ids, retired };
}

/** Assigns the ids of a scope's rebuilt people and records them, inside the build's transaction. */
export async function persistPersonIds(
  tx: Tx,
  orgId: string,
  brandId: string,
  persons: { personKey: string; identityKeys: string[] }[],
): Promise<PersonIdAssignment> {
  const rows = await tx
    .select({ identityKey: personIds.identityKey, personId: personIds.personId, createdAt: personIds.createdAt })
    .from(personIds)
    .where(and(eq(personIds.orgId, orgId), eq(personIds.brandId, brandId)));
  const known = new Map(rows.map((r) => [r.identityKey, { personId: r.personId, createdAt: r.createdAt }]));
  const assignment = assignPersonIds(persons, known);

  const changed = persons.flatMap((p) => {
    const id = assignment.ids.get(p.personKey)!;
    return p.identityKeys
      .filter((k) => known.get(k)?.personId !== id)
      .map((identityKey) => ({ orgId, brandId, identityKey, personId: id }));
  });
  for (let i = 0; i < changed.length; i += 500) {
    await tx
      .insert(personIds)
      .values(changed.slice(i, i + 500))
      .onConflictDoUpdate({
        target: [personIds.orgId, personIds.brandId, personIds.identityKey],
        set: { personId: sql`excluded.person_id`, updatedAt: sql`now()` },
      });
  }
  for (const r of assignment.retired) {
    await tx
      .insert(personIdAliases)
      .values({ orgId, brandId, retiredId: r.retiredId, personId: r.personId })
      .onConflictDoUpdate({
        target: [personIdAliases.orgId, personIdAliases.brandId, personIdAliases.retiredId],
        set: { personId: r.personId },
      });
  }
  return assignment;
}

const MAX_ALIAS_HOPS = 10;

/** The person an opaque id names today, following merges; null when nobody holds it. */
export async function findPersonById(orgId: string, brandId: string, personId: string): Promise<Person | null> {
  let id = personId;
  for (let hop = 0; hop <= MAX_ALIAS_HOPS; hop++) {
    const [row] = await db
      .select()
      .from(people)
      .where(and(eq(people.orgId, orgId), eq(people.brandId, brandId), eq(people.personId, id)))
      .limit(1);
    if (row) return row;
    const [alias] = await db
      .select({ personId: personIdAliases.personId })
      .from(personIdAliases)
      .where(and(eq(personIdAliases.orgId, orgId), eq(personIdAliases.brandId, brandId), eq(personIdAliases.retiredId, id)))
      .limit(1);
    if (!alias || alias.personId === id) break;
    id = alias.personId;
  }
  return null;
}
