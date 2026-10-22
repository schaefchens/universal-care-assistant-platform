-- UCAP as the SMS app (docs/plan-m3.md, K4).
-- A phone is woken for what waits for it (a reply it is to send): a push that says no more than "SMS".
ALTER TABLE deliveries DROP CONSTRAINT deliveries_purpose_check;
ALTER TABLE deliveries ADD CONSTRAINT deliveries_purpose_check CHECK (purpose IN ('care', 'reminder', 'test', 'heartbeat', 'wake'));
-- The other side's phone has a message the person sent (an SMS delivery report, WhatsApp's "delivered"): kept with it,
-- as the other side's "read" is (read_at).
ALTER TABLE messaging_messages ADD COLUMN delivered_at timestamptz;
