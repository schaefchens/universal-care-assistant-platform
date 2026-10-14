-- Messaging (docs/plan.md, S10; Appendix A "Messaging", Appendix F): a person's own connection to a messaging service
-- (Telegram in M1). The connectors process runs it and has no database access: the assistant stores what it reports.
-- Personal communication stays apart from care permissions (CONCEPT §3): no helper scope reaches these tables in M1.
-- What is stored here is a copy of what the service holds; disconnecting deletes the copy (the service keeps its own).

CREATE TABLE messaging_connections (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  service text NOT NULL CHECK (service IN ('telegram')),
  state text NOT NULL CHECK (state IN ('starting', 'wait_phone', 'wait_code', 'wait_password', 'wait_qr', 'ready', 'logged_out', 'closed', 'error')),
  -- Where the login code went, the password's hint, the QR link, an error's code: never a code or a password.
  detail jsonb NOT NULL DEFAULT '{}',
  me_external_id text,
  me_name text,
  -- TDLib's database key, 32 random bytes, sealed; it reaches the connectors process in `start` only.
  db_key_sealed bytea NOT NULL,
  test_dc boolean NOT NULL DEFAULT false,
  ready_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  UNIQUE (user_id, service)
);

CREATE TABLE messaging_participants (
  connection_id uuid NOT NULL REFERENCES messaging_connections (id) ON DELETE CASCADE,
  external_id text NOT NULL,
  name text NOT NULL,
  -- In the person's contacts on the service: a message to anyone else is sent with a warning (Appendix E).
  is_contact boolean NOT NULL DEFAULT false,
  is_bot boolean NOT NULL DEFAULT false,
  updated_at timestamptz NOT NULL,
  PRIMARY KEY (connection_id, external_id)
);

CREATE TABLE messaging_conversations (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES messaging_connections (id) ON DELETE CASCADE,
  external_id text NOT NULL,
  kind text NOT NULL CHECK (kind IN ('private', 'group', 'channel', 'secret')),
  title text NOT NULL,
  -- The other person of a private chat.
  peer_external_id text,
  -- Muted chats are shown but not announced; channels are not counted as unread (Appendix F).
  muted boolean NOT NULL DEFAULT false,
  -- The service's own count, and the last message read by the person and by the other side.
  unread int NOT NULL DEFAULT 0,
  read_inbox_max bigint,
  read_outbox_max bigint,
  last_message_at timestamptz,
  -- A reply the person did not send (said no, or nothing): kept a day, so "Der Entwurf ist gespeichert" is true.
  draft text,
  draft_at timestamptz,
  updated_at timestamptz NOT NULL,
  UNIQUE (connection_id, external_id)
);

CREATE TABLE messaging_messages (
  id uuid PRIMARY KEY,
  conversation_id uuid NOT NULL REFERENCES messaging_conversations (id) ON DELETE CASCADE,
  external_id text NOT NULL,
  -- The service's order (Telegram: the message id), for read states.
  sort_key bigint NOT NULL,
  sender_external_id text,
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  kind text NOT NULL CHECK (kind IN ('text', 'voice', 'photo', 'document', 'video_note', 'video', 'audio', 'sticker', 'service', 'other')),
  -- Exactly as the service has it: the text, a caption, a sticker's emoji, a service event in words.
  text text NOT NULL,
  file_name text,
  sent_at timestamptz NOT NULL,
  edited_at timestamptz,
  -- Incoming: read on the service (anywhere). Outgoing: read by the other side ("Anna hat gelesen").
  read_at timestamptz,
  -- The person heard the original through UCAP (played, not summarised): only then is it marked read on the service.
  heard_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  search tsvector GENERATED ALWAYS AS (to_tsvector('german', text || ' ' || coalesce(file_name, ''))) STORED,
  UNIQUE (conversation_id, external_id)
);
CREATE INDEX messaging_messages_recent ON messaging_messages (conversation_id, sent_at DESC);
CREATE INDEX messaging_messages_search ON messaging_messages USING gin (search);

CREATE TABLE messaging_attachments (
  message_id uuid PRIMARY KEY REFERENCES messaging_messages (id) ON DELETE CASCADE,
  -- The service's file id (valid in that connection's TDLib database).
  service_file_id bigint NOT NULL,
  mime text,
  bytes bigint,
  duration_s int,
  -- UCAP's copy: voice notes up to 5 MB are fetched at once (Appendix F).
  file_id uuid REFERENCES files (id) ON DELETE SET NULL,
  download text NOT NULL DEFAULT 'none' CHECK (download IN ('none', 'requested', 'done', 'failed', 'too_large')),
  download_request uuid UNIQUE,
  -- Speech recognition of a voice note, said as "automatisch abgeschrieben" (CONCEPT §3); the original is the audio.
  transcript text,
  transcript_state text NOT NULL DEFAULT 'none' CHECK (transcript_state IN ('none', 'pending', 'done', 'empty', 'refused', 'failed')),
  -- Why there is none: the policy, the person's consent, a failing provider (a class, never a message).
  transcript_reason text,
  updated_at timestamptz NOT NULL
);

-- A message the person confirmed (Appendix F "Sending"): written before the service is asked, then honest about what
-- the service said. `uncertain` is never sent again on its own (C6).
CREATE TABLE messaging_outbound (
  id uuid PRIMARY KEY,
  connection_id uuid NOT NULL REFERENCES messaging_connections (id) ON DELETE CASCADE,
  conversation_id uuid NOT NULL REFERENCES messaging_conversations (id) ON DELETE CASCADE,
  user_id uuid NOT NULL REFERENCES users (id),
  -- The assistant action the person confirmed: one confirmation, one message.
  action_id uuid UNIQUE,
  -- The device it was confirmed on: it says what became of it (C3–C6).
  device_id uuid,
  text text NOT NULL,
  state text NOT NULL CHECK (state IN ('queued', 'attempting', 'pending_service', 'sent', 'failed', 'uncertain')),
  temp_external_id text,
  external_id text,
  error text,
  -- What the person was told (slow: C5), so nothing is said twice.
  told text[] NOT NULL DEFAULT '{}',
  attempted_at timestamptz,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE INDEX messaging_outbound_open ON messaging_outbound (connection_id, state) WHERE state IN ('queued', 'attempting', 'pending_service');
CREATE INDEX messaging_outbound_temp ON messaging_outbound (connection_id, temp_external_id) WHERE temp_external_id IS NOT NULL;
