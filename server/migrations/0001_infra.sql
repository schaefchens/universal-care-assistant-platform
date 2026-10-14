-- UCAP's infrastructure (docs/plan.md, Appendix A). Times are timestamptz; ids of things people create are UUIDv7
-- made by the app; append-only logs use identity columns. User ids here have no foreign keys: users come in S2, and
-- audit entries must outlive the rows they name.

CREATE TABLE server_meta (
  key text PRIMARY KEY,
  value text NOT NULL
);

-- Durable timers and background work. Each process runs its own queue. A job is claimed by setting locked_until
-- (FOR UPDATE SKIP LOCKED), runs outside the claiming transaction, and must be idempotent: it may run again after a
-- crash. `key` dedupes and cancels (care:esc:<request>:<tier>).
CREATE TABLE jobs (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  queue text NOT NULL CHECK (queue IN ('core', 'assistant')),
  kind text NOT NULL,
  key text UNIQUE,
  run_at timestamptz NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  attempts int NOT NULL DEFAULT 0,
  max_attempts int NOT NULL DEFAULT 10,
  locked_until timestamptz,
  last_error text,
  dead boolean NOT NULL DEFAULT false,
  done_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX jobs_due ON jobs (queue, run_at) WHERE done_at IS NULL;

-- The transactional outbox: domain changes insert their events here in the same transaction. After commit, one
-- dispatcher (core) gives each recipient's events a per-person sequence and fans them out (WebSocket, push).
CREATE TABLE outbox_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind text NOT NULL,
  recipients uuid[] NOT NULL,
  payload jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL DEFAULT now(),
  dispatched_at timestamptz
);
CREATE INDEX outbox_pending ON outbox_events (id) WHERE dispatched_at IS NULL;

CREATE TABLE user_event_heads (
  user_id uuid PRIMARY KEY,
  last_seq bigint NOT NULL
);

-- What each person's devices replay after a reconnect (since their last seq). Kept 30 days.
CREATE TABLE user_events (
  user_id uuid NOT NULL,
  seq bigint NOT NULL,
  type text NOT NULL,
  data jsonb NOT NULL,
  at timestamptz NOT NULL,
  PRIMARY KEY (user_id, seq)
);
CREATE INDEX user_events_at ON user_events (at);

-- Who did what to whom. Never content: ids, actions and the names of changed fields only.
CREATE TABLE audit_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  at timestamptz NOT NULL,
  actor_user uuid,
  actor_device uuid,
  subject_user uuid,
  action text NOT NULL,
  target_type text,
  target_id text,
  detail jsonb NOT NULL DEFAULT '{}'
);
CREATE INDEX audit_subject ON audit_events (subject_user, at);

-- Stored files (speech clips, voice messages, uploads), served through signed URLs with Range support.
CREATE TABLE files (
  id uuid PRIMARY KEY,
  owner_user uuid,
  kind text NOT NULL,
  mime text NOT NULL,
  bytes bigint NOT NULL,
  sha256 bytea NOT NULL,
  path text NOT NULL,
  source jsonb,
  expires_at timestamptz,
  created_at timestamptz NOT NULL
);
CREATE INDEX files_expiry ON files (expires_at) WHERE expires_at IS NOT NULL;

-- Failed attempts only (wrong codes, bad signatures): successful calls write nothing here.
CREATE TABLE rate_limits (
  bucket text NOT NULL,
  window_start timestamptz NOT NULL,
  hits int NOT NULL,
  PRIMARY KEY (bucket, window_start)
);
