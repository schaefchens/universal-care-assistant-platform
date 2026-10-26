-- A new message to a contact (K6) that was not sent is kept with the contact for a day, as a reply's is kept with its
-- conversation (docs/decisions.md, M3, 13: the owner, 2026-10-25), and offered when the person writes to them again.
ALTER TABLE messaging_outbound ADD COLUMN contact_id uuid REFERENCES contacts (id) ON DELETE SET NULL;

CREATE TABLE messaging_contact_drafts (
  person_id uuid NOT NULL REFERENCES users (id) ON DELETE CASCADE,
  contact_id uuid NOT NULL REFERENCES contacts (id) ON DELETE CASCADE,
  -- The service it was meant for: a draft to Anna by SMS is not one to her on WhatsApp.
  service text NOT NULL,
  text text NOT NULL,
  saved_at timestamptz NOT NULL,
  PRIMARY KEY (person_id, contact_id, service)
);
