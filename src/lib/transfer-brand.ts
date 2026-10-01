/**
 * Moving one brand's whole CRM history from one org to another.
 *
 * The fleet contract (`POST /internal/transfer-brand`, orchestrated by
 * brand-service) says each service moves every row it holds for the brand from
 * `sourceOrgId` to `targetOrgId`, rewriting the brand id to `targetBrandId` when
 * one is given. crm-service holds nothing that is org-scoped WITHOUT a brand, so
 * "every row for the brand" is exactly the rows carrying `brand_id = source` in
 * each table below — bronze, silver and the recorded decisions alike.
 *
 * Only `org_id` / `brand_id` change. Every foreign key between these tables is
 * on row ids, so the moved graph stays wired exactly as it was. Provenance
 * (`run_id`, `parent_run_id`, `created_by_user_id`) is history and is left as
 * recorded.
 *
 * ⚠️ A NEW table carrying `brand_id` MUST be added to `TRANSFER_TABLES`, or a
 * transfer silently leaves that table's rows behind in the source org.
 * `tests/unit/transfer-brand.test.ts` fails when a brand-scoped table in the
 * schema is missing from this list.
 */
import { sql } from "drizzle-orm";
import { getTableConfig, type PgTable } from "drizzle-orm/pg-core";
import { db } from "../db/index.js";
import {
  contactUploads,
  contactRowsRaw,
  contacts,
  contactServes,
  matrixConnections,
  matrixLinks,
  matrixRawEvents,
  conversations,
  matrixLeads,
  ghlConnections,
  ghlRawRecords,
  ghlPipelines,
  ghlOpportunities,
  ghlAppointments,
  ghlFormSubmissions,
  ghlOpportunityHistory,
  ghlStageMeanings,
  peopleScopes,
  people,
  leadStandingObservations,
  posthogConnections,
  posthogRawRecords,
  posthogActivities,
  stripeConnections,
  stripeRawRecords,
  stripeTransactions,
} from "../db/schema.js";

export const TRANSFER_TABLES: PgTable[] = [
  contactUploads,
  contactRowsRaw,
  contacts,
  contactServes,
  matrixConnections,
  matrixLinks,
  matrixRawEvents,
  conversations,
  matrixLeads,
  ghlConnections,
  ghlRawRecords,
  ghlPipelines,
  ghlOpportunities,
  ghlAppointments,
  ghlFormSubmissions,
  ghlOpportunityHistory,
  ghlStageMeanings,
  peopleScopes,
  people,
  leadStandingObservations,
  posthogConnections,
  posthogRawRecords,
  posthogActivities,
  stripeConnections,
  stripeRawRecords,
  stripeTransactions,
];

export interface TransferBrandInput {
  sourceBrandId: string;
  sourceOrgId: string;
  targetOrgId: string;
  targetBrandId?: string;
}

export interface TransferTableResult {
  tableName: string;
  count: number;
}

/**
 * Moves every row of the brand in ONE transaction: either the whole CRM moves or
 * nothing does, so a failure can never leave a brand split across two orgs.
 *
 * Idempotent: a row already in its final state (target org, final brand) is not
 * matched, so a second call moves nothing and reports 0 everywhere. A row left
 * half-way by an earlier call WITHOUT `targetBrandId` (already in the target
 * org, still on the source brand) is still matched and finished.
 */
export async function transferBrand(input: TransferBrandInput): Promise<TransferTableResult[]> {
  const finalBrandId = input.targetBrandId ?? input.sourceBrandId;

  return db.transaction(async (tx) => {
    const results: TransferTableResult[] = [];
    for (const table of TRANSFER_TABLES) {
      const tableName = getTableConfig(table).name;
      const moved = await tx.execute(sql`
        UPDATE ${sql.identifier(tableName)}
        SET org_id = ${input.targetOrgId}, brand_id = ${finalBrandId}
        WHERE brand_id = ${input.sourceBrandId}
          AND org_id IN (${input.sourceOrgId}, ${input.targetOrgId})
          AND (org_id, brand_id) IS DISTINCT FROM (${input.targetOrgId}::uuid, ${finalBrandId}::uuid)
      `);
      results.push({ tableName, count: moved.count });
    }
    return results;
  });
}
