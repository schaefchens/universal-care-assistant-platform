-- New recovery words without the old ones (docs/plan-m4.md, G5: the roadmap's "delayed key rotation"; the owner: 24
-- hours). From one of the person's devices (the words were lost), through trusted persons (G7), or by an operator's
-- reset: the new identity key waits a day, every device of the person hears it at once and can stop it, and so can the
-- old words (a recovery with them). With the old words a rotation needs no wait (M1).

CREATE TABLE identity_changes (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  kind text NOT NULL CHECK (kind IN ('device', 'trusted', 'reset')),
  new_key bytea NOT NULL,
  -- The new key's signature over the change, and what it signed.
  proof jsonb NOT NULL,
  -- A reset or a trusted recovery brings a new device with it: its key and how it names itself, its proof.
  new_device jsonb,
  requested_by_user uuid REFERENCES users (id),
  requested_by_device uuid REFERENCES devices (id),
  -- An administrator's reason for a reset, shown to the person.
  reason text CHECK (length(reason) <= 300),
  state text NOT NULL CHECK (state IN ('waiting', 'done', 'stopped')),
  effective_at timestamptz NOT NULL,
  created_at timestamptz NOT NULL,
  ended_at timestamptz,
  stopped_by_user uuid REFERENCES users (id),
  stopped_by_device uuid REFERENCES devices (id),
  stopped_how text CHECK (stopped_how IN ('device', 'words', 'admin', 'replaced')),
  -- The device a reset or trusted recovery enrolled, once it took effect.
  device_id uuid REFERENCES devices (id)
);
-- One waiting change per person: a new one replaces the one before (stopped as `replaced`).
CREATE UNIQUE INDEX identity_changes_waiting ON identity_changes (user_id) WHERE state = 'waiting';

ALTER TABLE devices DROP CONSTRAINT devices_enrolled_via_check;
ALTER TABLE devices ADD CONSTRAINT devices_enrolled_via_check CHECK (enrolled_via IN ('create', 'recover', 'link', 'trusted', 'reset'));

-- An operator's reset code is an invitation of its own kind, for one person.
ALTER TABLE invites DROP CONSTRAINT invites_kind_check;
ALTER TABLE invites ADD CONSTRAINT invites_kind_check CHECK (kind IN ('account', 'helper', 'supported_person', 'reset'));
ALTER TABLE invites ADD COLUMN for_user uuid REFERENCES users (id);
