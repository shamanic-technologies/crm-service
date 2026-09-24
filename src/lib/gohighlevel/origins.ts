/**
 * Where a brand's mirrored GoHighLevel contacts came from — counted over the
 * WHOLE population, in the database, so no caller has to page every contact
 * into a browser to answer "how many came from Meta Ads".
 *
 * Every value is the customer's own word, exactly as silver holds it: no
 * mapping onto a vocabulary of ours, no case folding ("form 13" and "Form 13"
 * are two buckets because the customer typed two things). A contact carrying no
 * value is its own bucket (`value: null`), always present, never dropped — so
 * for every single-valued dimension the bucket counts sum to `totalContacts`.
 *
 * Tags are the exception, and they are shaped differently on purpose: a contact
 * can carry several, so per-label counts OVERLAP and cannot sum to the total.
 * What does reconcile is `tagged + untagged === totalContacts`.
 */

import { sql } from "drizzle-orm";
import { db } from "../../db/index.js";
import { GHL_SOURCE } from "./records.js";

export interface OriginBucket {
  /** The customer's own value, verbatim. `null` = the contact carries none. */
  value: string | null;
  count: number;
}

export interface TagLabelCount {
  value: string;
  count: number;
}

export interface ContactOriginsView {
  brandId: string;
  totalContacts: number;
  /** GoHighLevel's `source` field. Buckets sum to `totalContacts`. */
  leadSource: OriginBucket[];
  /** First-touch attribution medium. Buckets sum to `totalContacts`. */
  originMedium: OriginBucket[];
  /** GoHighLevel's contact `type`. Buckets sum to `totalContacts`. */
  contactType: OriginBucket[];
  tags: {
    /** Contacts carrying at least one tag. */
    tagged: number;
    /** Contacts with no tag (no tags field, or an empty one). */
    untagged: number;
    /** Contacts per label. Overlapping: one contact counts under each of its tags. */
    labels: TagLabelCount[];
  };
}

type Column = "lead_source" | "origin_medium" | "contact_type";

/**
 * Most-carried first; ties broken on the value so the order is stable. The
 * `null` bucket is ordered like any other — a population that mostly carries
 * no source should read that way first.
 */
function sortBuckets<T extends { value: string | null; count: number }>(rows: T[]): T[] {
  return rows.sort((a, b) => {
    if (b.count !== a.count) return b.count - a.count;
    if (a.value === null) return 1;
    if (b.value === null) return -1;
    return a.value < b.value ? -1 : a.value > b.value ? 1 : 0;
  });
}

async function bucketsFor(
  column: Column,
  orgId: string,
  brandId: string,
): Promise<OriginBucket[]> {
  const rows = (await db.execute(sql`
    SELECT ${sql.raw(column)} AS value, count(*)::int AS count
    FROM contacts
    WHERE org_id = ${orgId} AND brand_id = ${brandId} AND source = ${GHL_SOURCE}
    GROUP BY 1
  `)) as unknown as { value: string | null; count: number }[];

  const buckets = rows.map((r) => ({ value: r.value, count: Number(r.count) }));
  // "None" is stated even when nobody is in it, so a reader never has to infer
  // that an absent bucket means zero.
  if (!buckets.some((b) => b.value === null)) buckets.push({ value: null, count: 0 });
  return sortBuckets(buckets);
}

export async function readContactOrigins(
  orgId: string,
  brandId: string,
): Promise<ContactOriginsView> {
  const [totalRows, leadSource, originMedium, contactType, tagSummary, tagLabels] =
    await Promise.all([
      db.execute(sql`
        SELECT count(*)::int AS total
        FROM contacts
        WHERE org_id = ${orgId} AND brand_id = ${brandId} AND source = ${GHL_SOURCE}
      `) as unknown as Promise<{ total: number }[]>,
      bucketsFor("lead_source", orgId, brandId),
      bucketsFor("origin_medium", orgId, brandId),
      bucketsFor("contact_type", orgId, brandId),
      db.execute(sql`
        SELECT count(*) FILTER (
          WHERE jsonb_typeof(tags) = 'array' AND jsonb_array_length(tags) > 0
        )::int AS tagged
        FROM contacts
        WHERE org_id = ${orgId} AND brand_id = ${brandId} AND source = ${GHL_SOURCE}
      `) as unknown as Promise<{ tagged: number }[]>,
      // DISTINCT per contact: a label listed twice on one record is one contact.
      db.execute(sql`
        SELECT label AS value, count(DISTINCT c.id)::int AS count
        FROM contacts c
        CROSS JOIN LATERAL jsonb_array_elements_text(c.tags) AS label
        WHERE c.org_id = ${orgId} AND c.brand_id = ${brandId} AND c.source = ${GHL_SOURCE}
          AND jsonb_typeof(c.tags) = 'array'
        GROUP BY 1
      `) as unknown as Promise<{ value: string; count: number }[]>,
    ]);

  const totalContacts = Number(totalRows[0]?.total ?? 0);
  const tagged = Number(tagSummary[0]?.tagged ?? 0);

  return {
    brandId,
    totalContacts,
    leadSource,
    originMedium,
    contactType,
    tags: {
      tagged,
      untagged: totalContacts - tagged,
      labels: sortBuckets(tagLabels.map((r) => ({ value: r.value, count: Number(r.count) }))),
    },
  };
}
