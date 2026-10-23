-- A new message to one of the person's contacts with no conversation yet (docs/plan-m3.md, K6; docs/decisions.md, to
-- confirm 7 and 10): by SMS to their number, by email to their address. It goes to that number or address, and what is
-- said of it (C3–C6) names the contact it was confirmed with (C1). Its conversation comes as the phone or the mail
-- server makes it, as any other; it keeps no draft.
ALTER TABLE messaging_outbound ALTER COLUMN conversation_id DROP NOT NULL;
ALTER TABLE messaging_outbound ADD COLUMN to_address text;
ALTER TABLE messaging_outbound ADD COLUMN recipient text;
ALTER TABLE messaging_outbound ADD CONSTRAINT messaging_outbound_to
  CHECK (conversation_id IS NOT NULL OR (to_address IS NOT NULL AND recipient IS NOT NULL));
