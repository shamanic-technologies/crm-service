/**
 * STATED merges: someone says two people of a brand are the same human.
 *
 * The sources merge people only on a record stating two keys at once
 * (identity.ts). A WhatsApp chat with a number the owner never saved and the same
 * human on Gmail share no key, so they stay two people until someone who KNOWS
 * says so (staff, an agent through the MCP). That statement is recorded here and
 * the builder honours it as `stated_merge` evidence on every rebuild, until it is
 * taken back.
 *
 *  - Stating ties every identity key both people hold at that moment.
 *  - The merged person takes an id by the person-id rule (most keys wins); the
 *    other id is retired into it, so a link holding it still opens the person.
 *  - Taking it back (undo) gives each side its own id back, then rebuilds: two
 *    people again (unless a source record ties them on its own).
 *  - Idempotent: the same two people stated twice answer the existing statement.
 *  - Never silent: an unknown id, an id of another brand, or a person merged
 *    with themself is refused with the reason.
 */

import { and, eq, isNull, or, sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import {
  personIdAliases,
  personIds,
  personMerges,
  type Person,
  type PersonMerge,
} from "../../db/schema.js";
import { findPersonById } from "./person-id.js";

export type MergeRefusal =
  | { status: 404; reason: "person_not_found"; personId: string; error: string }
  | { status: 422; reason: "different_brand"; personId: string; error: string }
  | { status: 422; reason: "same_person"; error: string }
  | {
      status: 409;
      reason: "already_one_person";
      personId: string;
      error: string;
    };

export type MergeOutcome =
  | {
      ok: true;
      merge: PersonMerge;
      duplicate: boolean;
      people: [Person, Person] | null;
    }
  | { ok: false; refusal: MergeRefusal };

/** Whether the opaque id names a person of ANOTHER brand of the org (to say why it is refused). */
async function idBelongsToAnotherBrand(
  orgId: string,
  brandId: string,
  personId: string,
): Promise<boolean> {
  const [row] = await db
    .select({ brandId: personIds.brandId })
    .from(personIds)
    .where(
      and(
        eq(personIds.orgId, orgId),
        eq(personIds.personId, personId),
        sql`${personIds.brandId} <> ${brandId}`,
      ),
    )
    .limit(1);
  if (row) return true;
  const [alias] = await db
    .select({ brandId: personIdAliases.brandId })
    .from(personIdAliases)
    .where(
      and(
        eq(personIdAliases.orgId, orgId),
        eq(personIdAliases.retiredId, personId),
        sql`${personIdAliases.brandId} <> ${brandId}`,
      ),
    )
    .limit(1);
  return !!alias;
}

async function resolveOrRefuse(
  orgId: string,
  brandId: string,
  personId: string,
): Promise<Person | MergeRefusal> {
  const person = await findPersonById(orgId, brandId, personId);
  if (person) return person;
  if (await idBelongsToAnotherBrand(orgId, brandId, personId)) {
    return {
      status: 422,
      reason: "different_brand",
      personId,
      error: `person ${personId} belongs to another brand: only two people of the same brand can be merged`,
    };
  }
  return {
    status: 404,
    reason: "person_not_found",
    personId,
    error: `no person ${personId} in this brand`,
  };
}

const isRefusal = (x: Person | MergeRefusal): x is MergeRefusal =>
  "reason" in x && "status" in x;

/** The active statement naming these two ids (either order, either id as stated or as retired). */
async function activeMergeBetween(
  orgId: string,
  brandId: string,
  a: string,
  b: string,
): Promise<PersonMerge | null> {
  const [row] = await db
    .select()
    .from(personMerges)
    .where(
      and(
        eq(personMerges.orgId, orgId),
        eq(personMerges.brandId, brandId),
        isNull(personMerges.undoneAt),
        or(
          and(eq(personMerges.personIdA, a), eq(personMerges.personIdB, b)),
          and(eq(personMerges.personIdA, b), eq(personMerges.personIdB, a)),
        ),
      ),
    )
    .limit(1);
  return row ?? null;
}

export async function stateMerge(input: {
  orgId: string;
  brandId: string;
  personIds: [string, string];
  reason: string | null;
  userId: string;
  runId: string | null;
}): Promise<MergeOutcome> {
  const [idA, idB] = input.personIds;
  if (idA === idB)
    return {
      ok: false,
      refusal: {
        status: 422,
        reason: "same_person",
        error: "the two person ids are the same id",
      },
    };

  const existing = await activeMergeBetween(
    input.orgId,
    input.brandId,
    idA,
    idB,
  );
  if (existing)
    return { ok: true, merge: existing, duplicate: true, people: null };

  const a = await resolveOrRefuse(input.orgId, input.brandId, idA);
  if (isRefusal(a)) return { ok: false, refusal: a };
  const b = await resolveOrRefuse(input.orgId, input.brandId, idB);
  if (isRefusal(b)) return { ok: false, refusal: b };
  if (a.id === b.id) {
    return {
      ok: false,
      refusal: {
        status: 409,
        reason: "already_one_person",
        personId: a.personId!,
        error: `both ids already name one person (${a.personId})`,
      },
    };
  }

  // One statement per pair even when the same call races itself: serialised per brand.
  return db.transaction(async (tx) => {
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtext(${`person_merges:${input.orgId}:${input.brandId}`}))`,
    );
    const [raced] = await tx
      .select()
      .from(personMerges)
      .where(
        and(
          eq(personMerges.orgId, input.orgId),
          eq(personMerges.brandId, input.brandId),
          isNull(personMerges.undoneAt),
          or(
            and(
              eq(personMerges.personIdA, a.personId!),
              eq(personMerges.personIdB, b.personId!),
            ),
            and(
              eq(personMerges.personIdA, b.personId!),
              eq(personMerges.personIdB, a.personId!),
            ),
          ),
        ),
      )
      .limit(1);
    if (raced)
      return { ok: true as const, merge: raced, duplicate: true, people: null };
    const [merge] = await tx
      .insert(personMerges)
      .values({
        orgId: input.orgId,
        brandId: input.brandId,
        personIdA: a.personId!,
        personIdB: b.personId!,
        keysA: a.identityKeys as string[],
        keysB: b.identityKeys as string[],
        reason: input.reason,
        statedByUserId: input.userId,
        runId: input.runId,
      })
      .returning();
    return {
      ok: true as const,
      merge,
      duplicate: false,
      people: [a, b] as [Person, Person],
    };
  });
}

export type UndoOutcome =
  | { ok: true; merge: PersonMerge; duplicate: boolean }
  | {
      ok: false;
      refusal: { status: 404; reason: "merge_not_found"; error: string };
    };

/**
 * Take a statement back. Each side's keys point at its own id again and the
 * retirement aliases are dropped, so the next build gives each person back the
 * id it had before the merge.
 */
export async function undoMerge(input: {
  orgId: string;
  brandId: string;
  mergeId: string;
  userId: string;
  runId: string | null;
}): Promise<UndoOutcome> {
  return db.transaction(async (tx) => {
    const [row] = await tx
      .select()
      .from(personMerges)
      .where(
        and(
          eq(personMerges.id, input.mergeId),
          eq(personMerges.orgId, input.orgId),
          eq(personMerges.brandId, input.brandId),
        ),
      )
      .for("update");
    if (!row)
      return {
        ok: false as const,
        refusal: {
          status: 404 as const,
          reason: "merge_not_found" as const,
          error: `no merge ${input.mergeId} in this brand`,
        },
      };
    if (row.undoneAt) return { ok: true as const, merge: row, duplicate: true };

    for (const [personId, keys] of [
      [row.personIdA, row.keysA as string[]],
      [row.personIdB, row.keysB as string[]],
    ] as const) {
      if (keys.length === 0) continue;
      await tx
        .insert(personIds)
        .values(
          keys.map((identityKey) => ({
            orgId: row.orgId,
            brandId: row.brandId,
            identityKey,
            personId,
          })),
        )
        .onConflictDoUpdate({
          target: [personIds.orgId, personIds.brandId, personIds.identityKey],
          set: { personId: sql`excluded.person_id`, updatedAt: sql`now()` },
        });
    }
    await tx
      .delete(personIdAliases)
      .where(
        and(
          eq(personIdAliases.orgId, row.orgId),
          eq(personIdAliases.brandId, row.brandId),
          or(
            eq(personIdAliases.retiredId, row.personIdA),
            eq(personIdAliases.retiredId, row.personIdB),
          ),
        ),
      );
    const [undone] = await tx
      .update(personMerges)
      .set({
        undoneAt: new Date(),
        undoneByUserId: input.userId,
        undoRunId: input.runId,
      })
      .where(eq(personMerges.id, row.id))
      .returning();
    return { ok: true as const, merge: undone, duplicate: false };
  });
}

export async function listMerges(
  orgId: string,
  brandId: string,
): Promise<PersonMerge[]> {
  return db
    .select()
    .from(personMerges)
    .where(
      and(eq(personMerges.orgId, orgId), eq(personMerges.brandId, brandId)),
    )
    .orderBy(sql`${personMerges.createdAt} DESC`, personMerges.id);
}

/**
 * Whether the latest build applied the statement: the ids it names resolve to
 * ONE person today. `null` = a side no longer resolves (its source vanished).
 */
export async function mergeApplied(
  m: PersonMerge,
): Promise<{ applied: boolean | null; personId: string | null }> {
  const [a, b] = await Promise.all([
    findPersonById(m.orgId, m.brandId, m.personIdA),
    findPersonById(m.orgId, m.brandId, m.personIdB),
  ]);
  if (!a || !b) return { applied: null, personId: null };
  return a.id === b.id
    ? { applied: true, personId: a.personId }
    : { applied: false, personId: null };
}

export function mergeView(m: PersonMerge) {
  return {
    mergeId: m.id,
    brandId: m.brandId,
    personIds: [m.personIdA, m.personIdB],
    keys: { a: m.keysA as string[], b: m.keysB as string[] },
    reason: m.reason,
    statedByUserId: m.statedByUserId,
    statedAt: m.createdAt.toISOString(),
    runId: m.runId,
    active: m.undoneAt === null,
    undoneAt: m.undoneAt?.toISOString() ?? null,
    undoneByUserId: m.undoneByUserId,
  };
}
