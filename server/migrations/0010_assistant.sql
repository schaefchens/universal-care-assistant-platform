-- The assistant (docs/plan.md, S9): notes, the conversation's focus and recent exchanges, and actions that wait for
-- the person's confirmation.

-- A person's notes, searchable in full text (German stemming; M1 has no embeddings). Every change keeps the version
-- before it, so a change or a deletion can be undone ("Rückgängig").
CREATE TABLE notes (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES users (id),
  -- Made on the device or by the assistant before saving: the same note sent twice is one note.
  client_note_id uuid NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  -- typed in the app, dictated through the assistant, or written by the assistant from a request.
  source text NOT NULL CHECK (source IN ('typed', 'voice', 'assistant')),
  version int NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  search tsvector GENERATED ALWAYS AS (to_tsvector('german', title || ' ' || body)) STORED,
  UNIQUE (person_id, client_note_id)
);
CREATE INDEX notes_search ON notes USING gin (search);
CREATE INDEX notes_person ON notes (person_id, updated_at DESC) WHERE deleted_at IS NULL;

CREATE TABLE note_versions (
  note_id uuid NOT NULL REFERENCES notes (id),
  version int NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  deleted boolean NOT NULL,
  at timestamptz NOT NULL,
  by_user uuid REFERENCES users (id),
  PRIMARY KEY (note_id, version)
);

-- One conversation per person and device: what it is about now (ids and names, never content) and the last few
-- exchanges for follow-up questions, forgotten after half an hour of quiet.
CREATE TABLE assistant_sessions (
  user_id uuid NOT NULL REFERENCES users (id),
  device_id uuid NOT NULL REFERENCES devices (id),
  focus jsonb NOT NULL DEFAULT '{}',
  history jsonb NOT NULL DEFAULT '[]',
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (user_id, device_id)
);

-- What the assistant proposed to do (Appendix E): prepared, waiting for the confirmation of the device it was asked
-- on, attempted, done or not. `args` holds what it would write (a note's text): cleared a day after it ended.
CREATE TABLE assistant_actions (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  device_id uuid NOT NULL REFERENCES devices (id),
  turn_id uuid,
  tool text NOT NULL,
  args jsonb NOT NULL,
  content_hash text NOT NULL,
  status text NOT NULL CHECK (status IN ('prepared', 'awaiting_confirmation', 'attempting', 'completed', 'failed', 'cancelled', 'expired', 'superseded', 'uncertain', 'undone')),
  -- Untrusted text (a note, a message) was read in the turn that proposed it.
  tainted boolean NOT NULL DEFAULT false,
  expires_at timestamptz,
  confirmed_via text CHECK (confirmed_via IN ('touch', 'voice')),
  attempt_started_at timestamptz,
  result jsonb,
  error text,
  -- What undoing restores: the version of a note before, the reminder made.
  undo jsonb,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX assistant_actions_device ON assistant_actions (device_id, status);
CREATE INDEX assistant_actions_user ON assistant_actions (user_id, updated_at DESC);
