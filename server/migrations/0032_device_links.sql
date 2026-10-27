-- Device linking (docs/plan-m4.md, G3; CONCEPT §21: "he also might use multiple devices at once"). A signed-in device
-- offers a six-digit code; a new device claims it with a key of its own; both show the same fingerprint words (from a
-- salt the server draws at the claim and the new key); the person approves on the offering device, which signs it.
-- Only then is the new device enrolled (`via link`). Only HMACs of codes are kept.

CREATE TABLE device_links (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  offered_by uuid NOT NULL REFERENCES devices (id),
  code_mac bytea NOT NULL,
  state text NOT NULL CHECK (state IN ('open', 'claimed', 'approved', 'declined', 'cancelled')),
  -- The new device's claim: its key, as it names itself, its proof on a challenge.
  claim_jwk jsonb,
  claim_jkt text,
  claim jsonb,
  salt bytea,
  claimed_at timestamptz,
  -- The approval: by the offering device, signed by its key; the device it made.
  approved_at timestamptz,
  approval jsonb,
  device_id uuid REFERENCES devices (id),
  expires_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  ended_at timestamptz
);
-- A code is looked up while open; one person has at most one open or claimed link (the newest wins).
CREATE UNIQUE INDEX device_links_code_open ON device_links (code_mac) WHERE state = 'open';
CREATE INDEX device_links_user ON device_links (user_id) WHERE state IN ('open', 'claimed');
CREATE INDEX device_links_expiry ON device_links (expires_at);

ALTER TABLE devices ADD COLUMN linked_by uuid REFERENCES devices (id);
