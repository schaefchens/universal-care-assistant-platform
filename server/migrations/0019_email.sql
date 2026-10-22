-- Email (docs/plan-m3.md, K3).
-- A sent email can come back: a mail server's report names it by its Message-ID (the external id), after "sent". The
-- person is told (C13), with the reason the report gives.
ALTER TABLE messaging_outbound DROP CONSTRAINT messaging_outbound_state_check;
ALTER TABLE messaging_outbound ADD CONSTRAINT messaging_outbound_state_check
  CHECK (state IN ('queued', 'attempting', 'pending_service', 'sent', 'failed', 'uncertain', 'bounced'));
CREATE INDEX messaging_outbound_external ON messaging_outbound (connection_id, external_id) WHERE external_id IS NOT NULL;
-- An email's quoted part, kept apart from what is new: said as "Darunter zitiert: …" with its first line, and read
-- when asked.
ALTER TABLE messaging_messages ADD COLUMN quoted text;
