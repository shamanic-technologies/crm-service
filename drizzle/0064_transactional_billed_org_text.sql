-- TX-EMAIL-IN-UNIBOX-1024: the feed's billed org is verbatim (old sends carry a Clerk org id or "legacy"), not always a uuid.
ALTER TABLE "transactional_emails" ALTER COLUMN "billed_org_id" TYPE text USING "billed_org_id"::text;
