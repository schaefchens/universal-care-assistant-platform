-- Care: help requests, their escalation, deliveries to helpers' devices and their receipts (docs/plan.md, S4;
-- Appendix A "Care and push", Appendix D). The help path depends on nothing optional (CONCEPT §4).

-- Who is alerted, in which order. Without a row, every helper with care.respond is one tier.
CREATE TABLE escalation_plans (
  person_id uuid PRIMARY KEY REFERENCES users (id),
  version int NOT NULL,
  -- [{"waitS": 120, "helpers": ["<user id>", …]}, …]
  tiers jsonb NOT NULL,
  realert_s int NOT NULL DEFAULT 300 CHECK (realert_s >= 120),
  reopen_s int NOT NULL DEFAULT 1800,
  watchdog_s int NOT NULL DEFAULT 1200,
  sos_number text NOT NULL DEFAULT '112',
  updated_at timestamptz NOT NULL,
  updated_by uuid REFERENCES users (id)
);

CREATE TABLE care_requests (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES users (id),
  -- Made on the device before sending: the same press sent twice is one request, forever.
  client_request_id uuid NOT NULL,
  origin_device uuid REFERENCES devices (id),
  source text NOT NULL CHECK (source IN ('touch', 'key', 'voice_exact', 'voice_confirmed', 'voice_unconfirmed', 'assistant', 'reminder')),
  urgency text,
  status text NOT NULL CHECK (status IN ('open', 'accepted', 'resolved', 'cancelled')),
  episode int NOT NULL DEFAULT 1,
  tier int NOT NULL DEFAULT 1,
  exhausted boolean NOT NULL DEFAULT false,
  accepted_by uuid REFERENCES users (id),
  accepted_at timestamptz,
  received_at timestamptz NOT NULL,
  -- When it was pressed, by the device's own clock: received_at minus the delay the device measured.
  pressed_at_est timestamptz,
  client_delay_ms int,
  next_action_at timestamptz,
  last_alert_at timestamptz,
  resolved_at timestamptz,
  ended_at timestamptz,
  reminder_id uuid,
  version int NOT NULL DEFAULT 1,
  UNIQUE (person_id, client_request_id)
);
-- At most one request per person is open or accepted: a new press while one is open is the same request (coalescing).
CREATE UNIQUE INDEX care_requests_one_open ON care_requests (person_id) WHERE status IN ('open', 'accepted');
CREATE INDEX care_requests_person ON care_requests (person_id, received_at);

-- What happened to a request. `idem` makes every command count once (I6).
CREATE TABLE care_events (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  request_id uuid NOT NULL REFERENCES care_requests (id),
  episode int NOT NULL,
  type text NOT NULL,
  actor uuid REFERENCES users (id),
  data jsonb NOT NULL DEFAULT '{}',
  idem text UNIQUE,
  at timestamptz NOT NULL
);
CREATE INDEX care_events_request ON care_events (request_id, id);

-- One row per alert to one device on one channel.
CREATE TABLE deliveries (
  id uuid PRIMARY KEY,
  purpose text NOT NULL CHECK (purpose IN ('care', 'reminder', 'test', 'heartbeat')),
  ref uuid,
  episode int,
  recipient uuid NOT NULL REFERENCES users (id),
  device_id uuid NOT NULL REFERENCES devices (id),
  channel text NOT NULL CHECK (channel IN ('ws', 'unifiedpush', 'webpush')),
  kind text NOT NULL,
  attempt int NOT NULL DEFAULT 1,
  -- The receipt proves the device decrypted this delivery: it carries a nonce only the payload held.
  nonce_hash bytea NOT NULL UNIQUE,
  status text NOT NULL CHECK (status IN ('queued', 'sending', 'handed_off', 'push_failed', 'delivered', 'delivered_silenced', 'expired', 'superseded')),
  receipt_state jsonb,
  created_at timestamptz NOT NULL,
  handed_off_at timestamptz,
  receipt_at timestamptz,
  expires_at timestamptz NOT NULL
);
CREATE INDEX deliveries_ref ON deliveries (ref, episode);
CREATE INDEX deliveries_open ON deliveries (status, created_at) WHERE status IN ('queued', 'sending', 'handed_off');

CREATE TABLE push_endpoints (
  id uuid PRIMARY KEY,
  device_id uuid NOT NULL REFERENCES devices (id),
  kind text NOT NULL CHECK (kind IN ('webpush', 'unifiedpush')),
  endpoint text NOT NULL,
  -- The subscription's keys, sealed (a push auth secret is a credential, docs/plan.md Appendix I).
  keys_sealed bytea NOT NULL,
  created_at timestamptz NOT NULL,
  last_ok_at timestamptz,
  failures int NOT NULL DEFAULT 0,
  UNIQUE (device_id, kind)
);

-- Heartbeats and readiness of a helper's device.
CREATE TABLE device_health (
  device_id uuid PRIMARY KEY REFERENCES devices (id),
  hb_sent_at timestamptz,
  hb_received_at timestamptz,
  readiness text NOT NULL DEFAULT 'unknown' CHECK (readiness IN ('unknown', 'ready', 'degraded', 'unreachable')),
  updated_at timestamptz NOT NULL
);

-- Server secrets made at first start (the VAPID keys), sealed with a key derived from the master key.
CREATE TABLE stored_secrets (
  name text PRIMARY KEY,
  sealed bytea NOT NULL,
  created_at timestamptz NOT NULL
);
