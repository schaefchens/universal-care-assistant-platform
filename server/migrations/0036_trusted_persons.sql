-- Trusted persons (docs/plan-m4.md, G7; CONCEPT §14: "Optional trusted-person recovery arrangements should be
-- explicitly established"): an arrangement of its own, not a permission. The person names accounts on this server,
-- each agreeing on their own device ("Du siehst dadurch nichts von Claras Daten."), and how many must agree. With
-- every device gone, a new device shows a code; when that many trusted persons said yes to it, its new words wait a
-- day (G5), and every device of the person and the old words can stop them.
CREATE TABLE trustees (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES users (id),
  trustee_id uuid NOT NULL REFERENCES users (id),
  state text NOT NULL CHECK (state IN ('asked', 'accepted', 'ended')),
  created_at timestamptz NOT NULL,
  accepted_at timestamptz,
  ended_at timestamptz,
  ended_by uuid REFERENCES users (id),
  CHECK (person_id <> trustee_id)
);
CREATE UNIQUE INDEX trustees_one ON trustees (person_id, trustee_id) WHERE state <> 'ended';

-- How many trusted persons must agree (one to all of them).
ALTER TABLE users ADD COLUMN trust_threshold int CHECK (trust_threshold BETWEEN 1 AND 20);

CREATE TABLE trusted_recoveries (
  id uuid PRIMARY KEY,
  -- The six digits the new device shows, as a MAC; one open recovery per code.
  code_mac bytea NOT NULL,
  -- Whose account, once the first trusted person said so.
  person_id uuid REFERENCES users (id),
  new_key bytea NOT NULL,
  proof jsonb NOT NULL,
  new_device jsonb NOT NULL,
  -- For the four fingerprint words both sides see (as in G3).
  salt bytea NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'waiting', 'declined', 'expired')),
  change_id uuid REFERENCES identity_changes (id),
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX trusted_recoveries_code ON trusted_recoveries (code_mac) WHERE state = 'open';

CREATE TABLE trusted_approvals (
  recovery_id uuid NOT NULL REFERENCES trusted_recoveries (id),
  trustee_id uuid NOT NULL REFERENCES users (id),
  -- The trusted person's yes, signed by their device: what they saw (the recovery, whose, the new device's key).
  proof jsonb NOT NULL,
  at timestamptz NOT NULL,
  PRIMARY KEY (recovery_id, trustee_id)
);
