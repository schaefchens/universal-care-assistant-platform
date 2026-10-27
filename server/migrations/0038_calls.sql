-- The phone's calls as UCAP keeps them (docs/plan-m4.md, G10): what UCAP saw as the phone app, told by the person's
-- phone, signed with its key: the number and the name the phone's contacts give it, in or out, answered, missed or
-- declined, when and how long. For "Wer hat angerufen?" and the missed calls said on the person's devices; never what
-- was said.
CREATE TABLE calls (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES users (id),
  device_id uuid NOT NULL REFERENCES devices (id),
  -- The phone's own id for the call: the same call told twice is kept once.
  client_id text NOT NULL CHECK (length(client_id) <= 64),
  number text NOT NULL CHECK (length(number) <= 40),
  name text CHECK (length(name) <= 100),
  direction text NOT NULL CHECK (direction IN ('in', 'out')),
  outcome text NOT NULL CHECK (outcome IN ('answered', 'missed', 'declined', 'unanswered')),
  at timestamptz NOT NULL,
  duration_s int NOT NULL DEFAULT 0 CHECK (duration_s >= 0),
  -- A missed call is said once, on whichever of the person's devices says it first (the phone, or LIVE anywhere).
  announced_at timestamptz,
  created_at timestamptz NOT NULL,
  UNIQUE (device_id, client_id)
);
CREATE INDEX calls_person ON calls (person_id, at DESC);
CREATE INDEX calls_unannounced ON calls (person_id) WHERE announced_at IS NULL;
