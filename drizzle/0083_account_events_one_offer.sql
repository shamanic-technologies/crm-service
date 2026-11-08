-- ACCOUNT-EVENTS-ONE-OFFER-1108: a refused charge and a credit event reach a person through ONE offer (lib/offer-pick.ts), judged once.
ALTER TABLE "payment_refusal_reports" ADD COLUMN IF NOT EXISTS "offer_id" uuid;--> statement-breakpoint
ALTER TABLE "payment_refusal_reports" ADD COLUMN IF NOT EXISTS "offer_basis" text;--> statement-breakpoint
ALTER TABLE "payment_refusal_reports" ADD COLUMN IF NOT EXISTS "offer_verdict" jsonb;--> statement-breakpoint
ALTER TABLE "credit_event_reports" ADD COLUMN IF NOT EXISTS "org_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_event_reports" ADD COLUMN IF NOT EXISTS "brand_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_event_reports" ADD COLUMN IF NOT EXISTS "offer_id" uuid;--> statement-breakpoint
ALTER TABLE "credit_event_reports" ADD COLUMN IF NOT EXISTS "offer_basis" text;--> statement-breakpoint
ALTER TABLE "credit_event_reports" ADD COLUMN IF NOT EXISTS "offer_verdict" jsonb;
