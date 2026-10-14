-- AI and speech providers (docs/plan.md, S7; Appendix I "Privacy routing"): what may go where, with whose consent,
-- at what cost. A provider's key is sealed and written only; nobody reads it back. Personal data goes to an external
-- provider only when the operator's policy for that provider allows its data class AND the person consented.

CREATE TABLE providers (
  id uuid PRIMARY KEY,
  function text NOT NULL CHECK (function IN ('tts', 'stt', 'llm')),
  type text NOT NULL CHECK (type IN ('herde', 'openai', 'elevenlabs', 'anthropic', 'ollama', 'stt_mlx')),
  name text NOT NULL,
  base_url text,
  -- server: on this server; operator_lan: on the operator's own machines (an own herde worker, Ollama on the host);
  -- external: someone else's service.
  location text NOT NULL CHECK (location IN ('server', 'operator_lan', 'external')),
  model text,
  secret_sealed bytea,
  -- The operator's policy: the data classes this provider may receive (public needs no listing).
  allowed_classes text[] NOT NULL DEFAULT '{}',
  -- What the admin entered: the price per unit (speech: per 1000 characters) in millionths of a euro, and a cap per
  -- calendar month. A provider over its cap is refused out loud, never switched silently.
  price_micros_per_unit bigint NOT NULL DEFAULT 0,
  monthly_cap_micros bigint,
  -- Speech: the voices offered ([{id, label, langs}]), an instruction for voices that take one.
  settings jsonb NOT NULL DEFAULT '{}',
  enabled boolean NOT NULL DEFAULT true,
  health text NOT NULL DEFAULT 'unknown' CHECK (health IN ('unknown', 'ok', 'failing')),
  health_checked_at timestamptz,
  -- A class of failure only (timeout, http_401, …), never a provider's message.
  health_error text,
  created_by uuid REFERENCES users (id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);

-- A person's consent that a provider may receive these classes of their data (Appendix I).
CREATE TABLE privacy_consents (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  provider_id uuid NOT NULL REFERENCES providers (id),
  classes text[] NOT NULL,
  granted_by uuid NOT NULL REFERENCES users (id),
  granted_at timestamptz NOT NULL,
  revoked_at timestamptz
);
CREATE UNIQUE INDEX privacy_consents_live ON privacy_consents (user_id, provider_id) WHERE revoked_at IS NULL;

-- What each call used and cost: counts only, never content.
CREATE TABLE provider_usage (
  id bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  provider_id uuid NOT NULL REFERENCES providers (id),
  user_id uuid REFERENCES users (id),
  function text NOT NULL,
  purpose text NOT NULL,
  units int NOT NULL,
  cost_micros bigint NOT NULL,
  at timestamptz NOT NULL
);
CREATE INDEX provider_usage_month ON provider_usage (provider_id, at);

-- Rendered speech, kept for a week and reused for the same words in the same voice (Appendix A "speech_segments").
-- The key is a hash of voice and text: the text itself is not kept here.
CREATE TABLE speech_segments (
  id uuid PRIMARY KEY,
  cache_key text NOT NULL UNIQUE,
  voice_ref text NOT NULL,
  lang text NOT NULL,
  file_id uuid REFERENCES files (id),
  ms int,
  state text NOT NULL CHECK (state IN ('rendering', 'ready', 'failed')),
  herde_task bigint,
  created_at timestamptz NOT NULL,
  last_used_at timestamptz NOT NULL
);
