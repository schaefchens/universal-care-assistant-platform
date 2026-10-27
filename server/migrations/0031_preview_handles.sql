-- Whoever writes in another app's notifications, kept with one of the person's contacts once they said it is the same
-- person (docs/decisions.md, M3, To confirm 19; the owner, 2026-10-27, chose K6's suggestions for preview names too,
-- "kept with the contact as a handle of its own, after which the warning is not said"): the app's package and the
-- sender's id there ("org.thoughtcrime.securesms:p1a2b3…"), the app's name as its label.
ALTER TABLE contact_handles DROP CONSTRAINT contact_handles_kind_check;
ALTER TABLE contact_handles ADD CONSTRAINT contact_handles_kind_check CHECK (kind IN ('phone', 'email', 'telegram', 'whatsapp', 'preview'));

-- Each participant with the person's contact it is: by its number or address, its Telegram id, or its app and id.
CREATE OR REPLACE VIEW messaging_people AS
  SELECT p.connection_id, p.external_id, p.name, p.is_contact, p.is_bot, p.address, c.id AS contact_id, c.name AS contact_name
  FROM messaging_participants p
  JOIN messaging_connections k ON k.id = p.connection_id
  LEFT JOIN LATERAL (
    SELECT c.id, c.name FROM contact_handles h JOIN contacts c ON c.id = h.contact_id
    WHERE h.person_id = k.user_id AND c.deleted_at IS NULL
      AND ((h.kind IN ('phone', 'whatsapp', 'email') AND h.value = p.address)
        OR (h.kind = 'telegram' AND k.service = 'telegram' AND 'user:' || h.value = p.external_id)
        OR (h.kind = 'preview' AND k.service = 'notifications' AND h.value = k.account || ':' || p.external_id))
    ORDER BY c.created_at, c.id LIMIT 1
  ) c ON true;
