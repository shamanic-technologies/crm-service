-- UNIBOX-NEWSLETTER-1113: a newsletter send is filed only on the brand it names. Read the sent-newsletters feed again from
-- the first send so every stored row takes the brand the producer now states (the release's, else its list's).
DELETE FROM "calendar_feed_cursors" WHERE "feed" = 'transactional_sent_newsletters';
