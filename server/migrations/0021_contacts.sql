-- The person's own contacts (docs/plan-m3.md, K6; Data): a name of the person's own, and the ways to reach them.
-- In core, next to notes and reminders: a helper with contacts.manage keeps them too, never anything of messages.
CREATE TABLE contacts (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  name text NOT NULL,
  version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);
CREATE INDEX contacts_person ON contacts (person_id) WHERE deleted_at IS NULL;

-- A number in E.164, an address in lower case, a Telegram user's id, a WhatsApp number in E.164. A deleted contact
-- has none: its versions keep them, for undo.
CREATE TABLE contact_handles (
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  person_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  kind text NOT NULL CHECK (kind IN ('phone', 'email', 'telegram', 'whatsapp')),
  value text NOT NULL,
  -- "Handy", "Festnetz": said when there are several ("Anna anrufen, Handy?").
  label text,
  position integer NOT NULL,
  PRIMARY KEY (contact_id, kind, value)
);
-- One number or address is one contact of the person's: the same one is never two people.
CREATE UNIQUE INDEX contact_handles_one ON contact_handles (person_id, kind, value);

-- Every version as it was after its change, for undo and for what the history names.
CREATE TABLE contact_versions (
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  version integer NOT NULL,
  -- {name, handles: [{kind, value, label}], deleted}
  data jsonb NOT NULL,
  changed_by uuid NOT NULL REFERENCES users(id),
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (contact_id, version)
);
