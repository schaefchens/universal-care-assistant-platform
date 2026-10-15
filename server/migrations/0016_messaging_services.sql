-- More connectors (docs/plan-m3.md, K1): a person's messaging is no longer Telegram alone.
-- - Server-side services run in connector processes of their own: Telegram, WhatsApp, and email, with several
--   accounts per person.
-- - Device-side ones run on one of the person's phones: UCAP as the SMS app, and previews of another app's
--   notifications, one connection per app.
-- What each connection can do is kept with it (docs/plan.md, Appendix K: "capability descriptors per connection").

ALTER TABLE messaging_connections DROP CONSTRAINT messaging_connections_service_check;
ALTER TABLE messaging_connections ADD CONSTRAINT messaging_connections_service_check
  CHECK (service IN ('telegram', 'whatsapp', 'email', 'sms', 'notifications'));
-- wait_pairing: WhatsApp's pairing code waits to be typed on the phone (K2); off: a phone stopped running it (it gave
-- the SMS role back, or notification access was taken away).
ALTER TABLE messaging_connections DROP CONSTRAINT messaging_connections_state_check;
ALTER TABLE messaging_connections ADD CONSTRAINT messaging_connections_state_check
  CHECK (state IN ('starting', 'wait_phone', 'wait_code', 'wait_password', 'wait_qr', 'wait_pairing', 'ready', 'logged_out', 'closed', 'error', 'off'));
ALTER TABLE messaging_connections DROP CONSTRAINT messaging_connections_user_id_service_key;

-- Which account of the service (an email address) or which app shows its previews (its package); '' where a person
-- has one.
ALTER TABLE messaging_connections ADD COLUMN account text NOT NULL DEFAULT '';
-- The phone that runs it (SMS, previews); NULL for what the server runs.
ALTER TABLE messaging_connections ADD COLUMN device_id uuid REFERENCES devices (id);
-- One connection per person, service, account and phone.
CREATE UNIQUE INDEX messaging_connections_one ON messaging_connections (user_id, service, account, device_id) NULLS NOT DISTINCT;
-- Its name as the person hears it where the service's own is not enough: an app's name for previews ("Signal").
ALTER TABLE messaging_connections ADD COLUMN label text;
-- What it can do: how much history it has, whom it sends to, what "gesendet" means for it, voice messages, read
-- states, groups, subjects, the other side's delivery reports.
ALTER TABLE messaging_connections ADD COLUMN capabilities jsonb NOT NULL DEFAULT '{}';
-- The service's secret, sealed (TDLib's database key, WhatsApp's store key, an email account's password); a phone
-- keeps its own.
ALTER TABLE messaging_connections RENAME COLUMN db_key_sealed TO secret_sealed;
ALTER TABLE messaging_connections ALTER COLUMN secret_sealed DROP NOT NULL;
UPDATE messaging_connections
  SET capabilities = '{"history":"full","send":"conversations","sent":"service","voice":true,"readState":true,"groups":true,"subject":false,"delivery":true}'::jsonb
  WHERE service = 'telegram';

-- Email: a thread and each mail have a subject.
ALTER TABLE messaging_conversations ADD COLUMN subject text;
ALTER TABLE messaging_messages ADD COLUMN subject text;
