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
  voiceNoteTranscripts,
  calendarAttendeeMatches,
  samePersonVerdicts,
  calendarAttendanceVerdicts,
  matrixRawEvents,
  conversations,
  matrixLeads,
  matrixGroups,
  matrixGroupMembers,
  ghlConnections,
  ghlRawRecords,
  ghlPipelines,
  ghlOpportunities,
  ghlAppointments,
  ghlFormSubmissions,
  ghlOpportunityHistory,
  ghlStageMeanings,
  crmLabelVerdicts,
  peopleScopes,
  people,
  leadStandingObservations,
  posthogConnections,
  posthogRawRecords,
  posthogActivities,
  stripeConnections,
  stripeRawRecords,
  stripeTransactions,
  authConnections,
  authRawRecords,
  peopleFacts,
  personIds,
  personIdAliases,
  conversationVerdicts,
  whatsappSends,
  copilotMessages,
  apiCalls,
  personMerges,
  formTriggerReports,
  formOfferMappings,
  leadIdentifiedDeclarations,
  messageSentDeclarations,
  formSubmittedDeclarations,
  replyTriggerReports,
  humanLinkStatements,
  humanFactStatements,
  phoneGivenReports,
  phoneWatchArtifacts,
  peopleCorrections,
  contactPointOrgVerdicts,
  contactEmailLookups,
  whatsappLineSpans,
  whatsappLineDays,
} from "../db/schema.js";

export const TRANSFER_TABLES: PgTable[] = [
  contactUploads,
  whatsappSends,
  // WhatsApp line health (WA-LINE-HEALTH-1023): a line's history follows its brand.
  whatsappLineSpans,
  whatsappLineDays,
  contactRowsRaw,
  contacts,
  contactServes,
  // Email lookups of contacts whose email was not known (CRM-ADD-ONE-CONTACT-1021).
  contactEmailLookups,
  matrixConnections,
  matrixLinks,
  matrixRawEvents,
  conversations,
  matrixLeads,
  // Bridged groups and their members (RELATIONSHIP-TAGS-1014).
  matrixGroups,
  matrixGroupMembers,
  ghlConnections,
  ghlRawRecords,
  ghlPipelines,
  ghlOpportunities,
  ghlAppointments,
  ghlFormSubmissions,
  ghlOpportunityHistory,
  ghlStageMeanings,
  crmLabelVerdicts,
  peopleScopes,
  people,
  leadStandingObservations,
  posthogConnections,
  posthogRawRecords,
  posthogActivities,
  stripeConnections,
  stripeRawRecords,
  stripeTransactions,
  authConnections,
  authRawRecords,
  // The fact feed follows its brand (a fact keeps its id and seq; only org/brand change).
  peopleFacts,
  // The person-id memory follows too, so a moved person keeps their id.
  personIds,
  personIdAliases,
  // Jev's business / brand / offer verdicts on the brand's conversations.
  conversationVerdicts,
  // The Copilot chat turns filed under the staff Unibox scope.
  copilotMessages,
  // Calls to our API / MCP filed under the staff Unibox scope.
  apiCalls,
  // Stated merges (two people said to be one) follow the people they tie.
  personMerges,
  // Users' corrections (tags, companies, domains) follow the people they correct.
  peopleCorrections,
  // Which company each contact point speaks for (PERSON-RELATIONS-1017).
  contactPointOrgVerdicts,
  // CRM form submissions reported as `form_submitted`, and the offer each form is about.
  formTriggerReports,
  formOfferMappings,
  // Answers in campaign-opened threads reported as `positive_reply_received`.
  replyTriggerReports,
  // The lead_identified occurrences crm-service declared (COST-ACCOUNTING-1024).
  leadIdentifiedDeclarations,
  // The campaign WhatsApp messages crm-service declared as message_sent (LEDGER-HISTORY-1024).
  messageSentDeclarations,
  // The CRM form submissions crm-service declared as form_submitted (CRM-FORM-SUBMITTED-LEDGER-1025).
  formSubmittedDeclarations,
  // What the brand's CRM stated to human-service (judgment merges, do-not-contact
  // marks). A link stated for the old org is stated again for the new one.
  humanLinkStatements,
  humanFactStatements,
  // Phone numbers the brand learned ("WhatsApp number given") and the sources the watch looked at.
  phoneGivenReports,
  phoneWatchArtifacts,
  // What the brand's voice notes said (SOPHIE-VOICE-1019), beside the bronze events they read.
  voiceNoteTranscripts,
  // Who each calendar attendee is among the brand's people, and who joined the Meet call (GOOGLE-CALENDAR-MEETING-FACTS-1021).
  calendarAttendeeMatches,
  samePersonVerdicts,
  calendarAttendanceVerdicts,
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
