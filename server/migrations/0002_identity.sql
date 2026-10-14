-- Identity and devices (docs/plan.md, Appendix A and C). No email, phone or password (CONCEPT §14): a person is an
-- identity key derived from their recovery phrase (used only to create, recover and rotate), and each of their
-- devices has its own key. The phrase itself never reaches the server.

CREATE TABLE users (
  id uuid PRIMARY KEY,
  display_name text NOT NULL CHECK (length(display_name) BETWEEN 1 AND 60),
  locale text NOT NULL,
  address_form text NOT NULL DEFAULT 'du' CHECK (address_form IN ('du', 'Sie')),
  timezone text NOT NULL,
  -- none: no phrase yet (reserved for helper-led setup); unconfirmed: shown, not yet verified; confirmed: verified.
  recovery_state text NOT NULL CHECK (recovery_state IN ('none', 'unconfirmed', 'confirmed')),
  is_admin boolean NOT NULL DEFAULT false,
  settings jsonb NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  deleted_at timestamptz
);

-- Rotatable: a leaked phrase is replaced by a new one, the old key retired (never deleted: the proofs chain).
CREATE TABLE identity_keys (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  alg text NOT NULL DEFAULT 'ed25519' CHECK (alg = 'ed25519'),
  public_key bytea NOT NULL UNIQUE,
  kdf text NOT NULL DEFAULT 'hkdf-sha256/ucap-identity-v1',
  status text NOT NULL CHECK (status IN ('active', 'retired')),
  rotation_proof jsonb,
  created_at timestamptz NOT NULL,
  retired_at timestamptz
);
CREATE UNIQUE INDEX identity_keys_one_active ON identity_keys (user_id) WHERE status = 'active';

CREATE TABLE devices (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  name text NOT NULL CHECK (length(name) BETWEEN 1 AND 60),
  platform text NOT NULL CHECK (platform IN ('android', 'ios', 'web')),
  form_factor text CHECK (form_factor IN ('phone', 'tablet', 'desktop')),
  -- The device's P-256 public key and its RFC 7638 thumbprint; signatures arrive as P1363 (r || s).
  public_jwk jsonb NOT NULL,
  jkt text NOT NULL UNIQUE,
  key_store text NOT NULL CHECK (key_store IN ('keystore', 'webcrypto')),
  enrolled_via text NOT NULL CHECK (enrolled_via IN ('create', 'recover', 'link')),
  enrollment_proof jsonb NOT NULL,
  capabilities jsonb NOT NULL DEFAULT '{}',
  experience text NOT NULL DEFAULT 'simple' CHECK (experience IN ('simple', 'assistant', 'helper', 'admin')),
  app_version text,
  created_at timestamptz NOT NULL,
  last_seen_at timestamptz,
  revoked_at timestamptz,
  revoked_by uuid,
  revoke_reason text
);
CREATE INDEX devices_user ON devices (user_id) WHERE revoked_at IS NULL;

-- One-time nonces for proofs, bound to a purpose, valid 120 s. Only their hash is kept.
CREATE TABLE auth_challenges (
  id uuid PRIMARY KEY,
  nonce_hash bytea NOT NULL UNIQUE,
  purpose text NOT NULL,
  device_id uuid,
  identity_key bytea,
  expires_at timestamptz NOT NULL,
  used_at timestamptz
);
CREATE INDEX auth_challenges_expiry ON auth_challenges (expires_at);

-- Access tokens: 15 minutes, kept by the app in memory only, renewed with a device-key proof. Only HMACs are kept.
CREATE TABLE sessions (
  id uuid PRIMARY KEY,
  token_mac bytea NOT NULL UNIQUE,
  user_id uuid NOT NULL REFERENCES users (id),
  device_id uuid NOT NULL REFERENCES devices (id),
  scopes text[] NOT NULL,
  created_at timestamptz NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE INDEX sessions_device ON sessions (device_id) WHERE revoked_at IS NULL;

-- Invitations: a link code (130 bits, in the link's fragment, 7 days) and optionally a spoken code (10 digits, 24 h,
-- 5 attempts). Only HMACs are kept. Kinds: account (by an admin), helper and supported_person (S3).
CREATE TABLE invites (
  id uuid PRIMARY KEY,
  kind text NOT NULL CHECK (kind IN ('account', 'helper', 'supported_person')),
  code_mac bytea NOT NULL UNIQUE,
  spoken_mac bytea UNIQUE,
  spoken_expires_at timestamptz,
  created_by uuid,
  preset jsonb NOT NULL DEFAULT '{}',
  proposed_scopes text[] NOT NULL DEFAULT '{}',
  grants_admin boolean NOT NULL DEFAULT false,
  label text,
  expires_at timestamptz NOT NULL,
  failed_tries int NOT NULL DEFAULT 0,
  used_at timestamptz,
  used_by uuid,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL
);
