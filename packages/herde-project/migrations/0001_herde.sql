-- herde protocol v2, the project side (ported from ARCHE's migrations 17 and 18, server/app/Schema.php).
-- Times are timestamptz with NULL for "none" (ARCHE used 0). Ids are bigint: herde's TaskId is an integer.
-- serves_org_id / org_id carry no foreign key here: this package knows no application; the application adds them.

CREATE TABLE herde_workers (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  name           text        NOT NULL,
  key_mac        text        NOT NULL UNIQUE,            -- HMAC-SHA256(pepper, 'worker:' || key); the key itself is never stored
  key_hint       text        NOT NULL DEFAULT '',        -- the key's last 4 characters, for admins
  trust          text        NOT NULL CHECK (trust IN ('own', 'lender')),
  live           boolean     NOT NULL DEFAULT false,     -- a lender may take live work (ARCHE's `live`)
  serves_org_id  uuid        NULL,                       -- bound to one organisation's clients; NULL: the operator's computer
  active         boolean     NOT NULL DEFAULT true,
  protocol       smallint    NOT NULL DEFAULT 2,
  version        text        NOT NULL DEFAULT '',
  state          text        NOT NULL DEFAULT '' CHECK (state IN ('', 'ready', 'paused', 'loading')),
  resume_at      timestamptz NULL,
  caps           jsonb       NOT NULL DEFAULT '{}',      -- sanitised as ARCHE's Computers::caps() does
  caps_hash      text        NOT NULL DEFAULT '',        -- exactly as the worker sent it; never recomputed (floats differ in JS)
  profile_state  text        NOT NULL DEFAULT '',        -- ok | old | syncing | unmet | failing | stale | differs
  profile_detail text        NOT NULL DEFAULT '',
  fails          smallint    NOT NULL DEFAULT 0,         -- failures in a row
  resting_until  timestamptz NULL,
  last_seen      timestamptz NULL,
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE herde_invites (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  code_mac       text        NOT NULL UNIQUE,            -- HMAC-SHA256(pepper, 'worker:invite:' || code)
  name           text        NOT NULL DEFAULT '',
  trust          text        NOT NULL CHECK (trust IN ('own', 'lender')),
  serves_org_id  uuid        NULL,
  created_by     text        NOT NULL,                   -- a person id, or 'cli'
  expires_at     timestamptz NOT NULL,
  used_at        timestamptz NULL,
  worker_id      bigint      NULL REFERENCES herde_workers(id) ON DELETE SET NULL,
  created_at     timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE herde_tasks (
  id             bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  kind           text        NOT NULL CHECK (kind IN ('tts', 'text')),
  class          text        NOT NULL CHECK (class IN ('live', 'interactive', 'background')),
  purpose        text        NOT NULL,                   -- the TaskHandler that takes its result
  ref            text        NOT NULL DEFAULT '',        -- the owner's reference: a clip key, an utterance id
  privacy        text        NOT NULL CHECK (privacy IN ('private', 'public')),
  org_id         uuid        NULL,                       -- the data's controller; NULL for instance-wide work
  model          text        NOT NULL,                   -- tts: the family; text: the exact name
  voice          text        NOT NULL DEFAULT '',
  lang           text        NOT NULL DEFAULT '',
  size           integer     NOT NULL DEFAULT 0,         -- tts: characters; text: estimated input tokens
  input          jsonb       NOT NULL,                   -- validated against herde's TtsInput / TextInput before insert
  extra          jsonb       NOT NULL DEFAULT '{}',      -- kept with the task, never sent
  state          text        NOT NULL DEFAULT 'queued' CHECK (state IN ('queued', 'leased', 'done', 'failed', 'cancelled')),
  worker_id      bigint      NULL REFERENCES herde_workers(id) ON DELETE SET NULL,
  lease          text        NOT NULL DEFAULT '',
  lease_until    timestamptz NULL,
  missing_polls  smallint    NOT NULL DEFAULT 0,         -- polls of its worker that did not list it (dropped-lease detection)
  claimed_at     timestamptz NULL,                       -- when this lease began: a poll already in flight then may not list it yet
  outcome        jsonb       NULL,                       -- {status, body}: the answer a repeated result or fail gets
  takes          smallint    NOT NULL DEFAULT 0,
  failures       smallint    NOT NULL DEFAULT 0,
  failed_by      bigint[]    NOT NULL DEFAULT '{}',      -- workers that answered invalid / too_large (ARCHE kept one)
  priority       smallint    NOT NULL DEFAULT 50,        -- lower first
  claim_by       timestamptz NULL,                       -- ARCHE's deadline: nobody starts it after this
  due_at         timestamptz NULL,                       -- after this the result is useless and the task is cancelled
  result         jsonb       NULL,                       -- tts: what the handler kept; text: {content, finish, usage}
  ms             integer     NOT NULL DEFAULT 0,
  error          text        NOT NULL DEFAULT '',        -- at most 200 characters, never the input
  created_at     timestamptz NOT NULL DEFAULT now(),
  updated_at     timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX herde_tasks_open ON herde_tasks (kind, priority, claim_by, id) WHERE state IN ('queued', 'leased');
CREATE INDEX herde_tasks_held ON herde_tasks (worker_id) WHERE state = 'leased';
CREATE INDEX herde_tasks_ref  ON herde_tasks (purpose, ref);

-- Failed attempts only (a wrong invite code, a wrong key), counted per address and hour: a valid poll never writes here.
CREATE TABLE herde_rate_limits (
  bucket       text        NOT NULL,
  window_start timestamptz NOT NULL,
  hits         integer     NOT NULL DEFAULT 0,
  PRIMARY KEY (bucket, window_start)
);
