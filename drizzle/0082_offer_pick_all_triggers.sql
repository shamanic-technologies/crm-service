-- OFFER-PICK-ALL-1108: the phone and reply triggers place their offer with the form's resolver (lib/offer-pick.ts), judged once.
ALTER TABLE "phone_given_reports" ADD COLUMN IF NOT EXISTS "offer_basis" text;--> statement-breakpoint
ALTER TABLE "phone_given_reports" ADD COLUMN IF NOT EXISTS "offer_verdict" jsonb;--> statement-breakpoint
ALTER TABLE "reply_trigger_reports" ADD COLUMN IF NOT EXISTS "offer_verdict" jsonb;
