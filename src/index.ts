import * as Sentry from "@sentry/node";
import express from "express";
import cors from "cors";
import { readFileSync, existsSync } from "fs";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import { getSql } from "./db/index.js";
import { restorePostgresArrayTypes } from "./db/postgres-array-types.js";
import healthRoutes from "./routes/health.js";
import contactsRoutes from "./routes/contacts.js";
import internalRoutes from "./routes/internal.js";
import matrixRoutes from "./routes/matrix.js";
import gohighlevelRoutes from "./routes/gohighlevel.js";
import peopleRoutes from "./routes/people.js";
import posthogStripeRoutes from "./routes/posthog-stripe.js";
import authProviderRoutes from "./routes/auth-providers.js";
import copilotRoutes from "./routes/copilot.js";
import whatsappRoutes from "./routes/whatsapp.js";
import apiCallsRoutes from "./routes/api-calls.js";
import formTriggerRoutes from "./routes/form-triggers.js";
import phoneTriggerRoutes from "./routes/phone-triggers.js";
import whatsappLineRoutes from "./routes/whatsapp-lines.js";
import triggerHealthRoutes from "./routes/trigger-health.js";
import teamMembershipRoutes from "./routes/team-membership.js";
import calendarRoutes from "./routes/calendar.js";
import creditEventRoutes from "./routes/credit-events.js";
import transactionalRoutes from "./routes/transactional.js";
import { startFreshnessWatch } from "./lib/people/freshness.js";
import { startFormWatch } from "./lib/form-trigger/watch.js";
import { startPhoneWatch } from "./lib/phone-trigger/watch.js";
import { startMatrixLiveWatch } from "./lib/matrix/sync.js";
import { startCalendarWatch } from "./lib/calendar/feed.js";
import { startCreditWatch } from "./lib/credit-events/feed.js";
import { startTxEmailWatch } from "./lib/transactional/sent-emails.js";
import { startLineWatch } from "./lib/whatsapp/line-health.js";
import { startOutcomeDeclarations } from "./lib/reply-trigger/outcome.js";
import { startLeadIdentifiedDeclarations } from "./lib/people/lead-identified.js";
import { startMessageSentDeclarations } from "./lib/whatsapp/message-sent.js";
import { startFormSubmittedDeclarations } from "./lib/gohighlevel/form-submitted.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);
const openapiPath = join(__dirname, "..", "openapi.json");

const app = express();
const PORT = process.env.PORT || 3010;

app.use(cors());
// JSON body parsing. Multipart (CSV upload) is handled by multer in the route,
// so express.json only touches application/json requests.
// API-call batches from api-service carry request + response bodies (each cut at
// 256 KB, batches kept under 8 MB by the sender): their own, larger limit.
app.use("/internal/api-calls", express.json({ limit: "16mb" }));
app.use(express.json({ limit: "2mb" }));

app.get("/openapi.json", (_req, res) => {
  if (existsSync(openapiPath)) {
    res.json(JSON.parse(readFileSync(openapiPath, "utf-8")));
  } else {
    res.status(404).json({
      type: "not_found",
      error: "OpenAPI spec not generated. Run: pnpm generate:openapi",
    });
  }
});

app.use(healthRoutes);

/**
 * The port is bound BEFORE migrations run (a long data migration held the old
 * pre-listen boot past deploy.sh's 60s health window: the deploy rolled back and
 * the OLD code wrote onto the NEW schema). Until migrations finish, every route
 * but /health and /openapi.json answers 503, loud, never on a half-migrated schema.
 */
let migrated = false;
app.use((_req, res, next) => {
  if (migrated || process.env.NODE_ENV === "test") return next();
  res.status(503).json({ type: "unavailable", error: "migrations in progress, retry shortly" });
});
app.use(contactsRoutes);
app.use(internalRoutes);
app.use(matrixRoutes);
app.use(gohighlevelRoutes);
app.use(apiCallsRoutes);
app.use(peopleRoutes);
app.use(posthogStripeRoutes);
app.use(authProviderRoutes);
app.use(copilotRoutes);
app.use(whatsappRoutes);
app.use(formTriggerRoutes);
app.use(phoneTriggerRoutes);
app.use(whatsappLineRoutes);
app.use(triggerHealthRoutes);
app.use(calendarRoutes);
app.use(creditEventRoutes);
app.use(transactionalRoutes);
app.use(teamMembershipRoutes);

app.use((_req, res) => {
  res.status(404).json({ type: "not_found", error: "Not found" });
});

Sentry.setupExpressErrorHandler(app);

app.use((err: Error, _req: express.Request, res: express.Response, _next: express.NextFunction) => {
  console.error("[crm-service] Unhandled error:", err);
  res.status(500).json({ type: "internal", error: "Internal server error" });
});

if (process.env.NODE_ENV !== "test") {
  const dbUrl = process.env.CRM_SERVICE_DATABASE_URL;

  const startServer = () => {
    app.listen(Number(PORT), "::", () => {
      console.log(`[crm-service] running on port ${PORT}`);
    });
  };

  if (dbUrl) {
    startServer();
    const migrateDb = drizzle(getSql());
    // drizzle(client) re-installs its array-type pass-through on the SHARED client: undo it.
    restorePostgresArrayTypes(getSql());
    migrate(migrateDb, { migrationsFolder: "./drizzle" })
      .then(() => {
        console.log("[crm-service] Migrations complete");
        migrated = true;
        // Keeps the people message store current before anyone opens a person.
        startFreshnessWatch();
        // Reports each new CRM form submission as a `form_submitted` trigger, within a minute.
        startFormWatch();
        // Reports a person giving the brand their phone number (any connector) as `whatsapp_number_given`, within a minute.
        startPhoneWatch();
        // Mirrors every linked chat account every ~10s and reports a person's new message at once.
        startMatrixLiveWatch();
        // Mirrors google-service's calendar feed and states meetings with the brand's people as facts.
        startCalendarWatch();
        // Mirrors billing-service's credit events: "Credit ran out" / "Credit restored" on the client's staff Unibox thread.
        startCreditWatch();
        // Mirrors transactional-email-service's sent emails onto each client's staff Unibox thread.
        startTxEmailWatch();
        // Records every linked WhatsApp line's state (bridge /whoami) as spans + a daily series for Monitoring.
        startLineWatch();
        // Declares each reply judged positive as a Positive reply on its judge run at runs-service (cost ledger).
        startOutcomeDeclarations();
        // Declares each lead the registry's Jev identified (a conversation tagged professional_to_brand) as lead_identified.
        startLeadIdentifiedDeclarations();
        // Declares each WhatsApp message a campaign sent as message_sent on its send run (past and future, one path).
        startMessageSentDeclarations();
        // Declares each CRM form submission crm-service holds as form_submitted on its lead (past and future, one path).
        startFormSubmittedDeclarations();
      })
      .catch((err) => {
        console.error("[crm-service] Migration failed:", err);
        process.exit(1);
      });
  } else {
    console.warn("[crm-service] CRM_SERVICE_DATABASE_URL not set, skipping migrations");
    migrated = true;
    startServer();
  }
}

export default app;
