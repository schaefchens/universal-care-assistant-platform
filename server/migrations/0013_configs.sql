-- The device configuration (docs/plan.md, S11; Appendix A "Configuration"): one document per device (layout, touch,
-- how it looks), revisioned. Helpers with device.configure change it from their own devices; the device applies a new
-- version when nobody is using it, and says what changed (CONCEPT §8: "previewable, traceable, and reversible").

CREATE TABLE device_configs (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES users (id),
  -- The device it is for; NULL is the person's template for a new device (reserved: M1 makes none).
  device_id uuid REFERENCES devices (id),
  current_version int NOT NULL,
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL
);
CREATE UNIQUE INDEX device_configs_device ON device_configs (device_id) WHERE device_id IS NOT NULL;
CREATE UNIQUE INDEX device_configs_template ON device_configs (person_id) WHERE device_id IS NULL;

CREATE TABLE device_config_versions (
  config_id uuid NOT NULL REFERENCES device_configs (id) ON DELETE CASCADE,
  version int NOT NULL,
  -- The version it was made from: a new one must be made from the current one (409 otherwise).
  base int,
  body jsonb NOT NULL,
  -- Made on the device itself (the person's own settings), edited from elsewhere, or set back to an earlier version.
  kind text NOT NULL CHECK (kind IN ('device', 'edit', 'revert')),
  author_user uuid REFERENCES users (id),
  note text,
  -- The warnings the author saw and saved anyway (a colour hard to read on): traceable.
  acknowledged text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  PRIMARY KEY (config_id, version)
);

CREATE TABLE device_config_state (
  config_id uuid PRIMARY KEY REFERENCES device_configs (id) ON DELETE CASCADE,
  -- What the device received and what it applied: the helper's page tells them apart (CONCEPT §8: "distinguish
  -- between a configuration saved on the server and one actually received by the device").
  delivered_version int,
  delivered_at timestamptz,
  applied_version int,
  applied_at timestamptz,
  -- Why the newest is not applied yet, and which screens the device had to repair.
  deferred_reason text CHECK (deferred_reason IN ('touch', 'speech', 'awaiting', 'care')),
  repaired text[] NOT NULL DEFAULT '{}',
  updated_at timestamptz NOT NULL
);
