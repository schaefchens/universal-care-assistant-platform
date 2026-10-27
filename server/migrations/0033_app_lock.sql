-- The app lock (docs/plan-m4.md, G4; CONCEPT §14: "Normal access should rely on an authorized device with appropriate
-- local unlocking options"). Per device, off by default. A device with it signs in for help, reminders and its
-- configuration only; the person's code (or Android's own lock, through a second key) unlocks the rest for that
-- session and the sessions that renew it. The code is one per person, kept only as a slow hash.

CREATE TABLE unlock_codes (
  user_id uuid PRIMARY KEY REFERENCES users (id),
  -- scrypt over the code with a salt of its own; the code itself is never kept, logged or said.
  verifier bytea NOT NULL,
  salt bytea NOT NULL,
  length int NOT NULL,
  set_at timestamptz NOT NULL,
  set_by_device uuid REFERENCES devices (id),
  -- Wrong codes in a row, and until when the next try must wait.
  failed int NOT NULL DEFAULT 0,
  wait_until timestamptz
);

ALTER TABLE devices ADD COLUMN locked boolean NOT NULL DEFAULT false;
-- After how long in the background or with the screen off the device locks itself again (the device keeps time).
ALTER TABLE devices ADD COLUMN lock_after_s int NOT NULL DEFAULT 300;
-- Android's extra: a key bound to the phone's own lock (spikes/m4.md, A); gone when the person removes that lock.
ALTER TABLE devices ADD COLUMN unlock_jwk jsonb;
