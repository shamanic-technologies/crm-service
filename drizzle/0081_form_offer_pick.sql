-- FORM-OFFER-PICK-1108: how a form fill's offer was placed, and Jev's verdict when judged (judged once).
ALTER TABLE "form_trigger_reports" ADD COLUMN IF NOT EXISTS "offer_basis" text;--> statement-breakpoint
ALTER TABLE "form_trigger_reports" ADD COLUMN IF NOT EXISTS "offer_verdict" jsonb;
