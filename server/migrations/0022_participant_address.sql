-- Whom a participant is, to find their contact (docs/plan-m3.md, K6; Data: "an address (a number in E.164, an email
-- address), to find the contact"). Names then come from the person's contacts, on every service.
ALTER TABLE messaging_participants ADD COLUMN address text;

-- The address a service's id holds: an SMS correspondent's id is their number (or a short number as it came), an
-- email one's is their address (never one whose sender was not confirmed), a WhatsApp one's holds their number unless
-- WhatsApp gave a LID. Telegram's ids hold none: its connector says the number where Telegram shows it.
CREATE FUNCTION messaging_address(service text, external_id text) RETURNS text LANGUAGE sql IMMUTABLE AS $$
  SELECT CASE service
    WHEN 'sms' THEN CASE WHEN external_id ~ '^(\+[0-9]{6,15}|[1-9][0-9]{2,5})$' THEN external_id END
    WHEN 'email' THEN CASE WHEN external_id ~ '^(mail:)?[^?@[:space:]]+@[^?[:space:]]+$' THEN lower(regexp_replace(external_id, '^mail:', '')) END
    WHEN 'whatsapp' THEN CASE WHEN external_id ~ '^user:[0-9]{6,15}$' THEN '+' || substr(external_id, 6) END
  END
$$;

UPDATE messaging_participants p SET address = messaging_address(k.service, p.external_id)
  FROM messaging_connections k WHERE k.id = p.connection_id;
CREATE INDEX messaging_participants_address ON messaging_participants (address) WHERE address IS NOT NULL;

-- Each participant with the person's contact it is: by its number or address, or by its Telegram id.
CREATE VIEW messaging_people AS
  SELECT p.connection_id, p.external_id, p.name, p.is_contact, p.is_bot, p.address, c.id AS contact_id, c.name AS contact_name
  FROM messaging_participants p
  JOIN messaging_connections k ON k.id = p.connection_id
  LEFT JOIN LATERAL (
    SELECT c.id, c.name FROM contact_handles h JOIN contacts c ON c.id = h.contact_id
    WHERE h.person_id = k.user_id AND c.deleted_at IS NULL
      AND ((h.kind IN ('phone', 'whatsapp', 'email') AND h.value = p.address)
        OR (h.kind = 'telegram' AND k.service = 'telegram' AND 'user:' || h.value = p.external_id))
    ORDER BY c.created_at, c.id LIMIT 1
  ) c ON true;
