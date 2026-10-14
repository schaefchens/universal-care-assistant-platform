-- Voice input (docs/plan.md, S8). A turn is recorded by its timings and outcome only: what was said is never kept
-- here, and the audio lives in memory for the recognition call alone (Retention).
CREATE TABLE assistant_turns (
  id uuid PRIMARY KEY,
  user_id uuid NOT NULL REFERENCES users (id),
  device_id uuid NOT NULL REFERENCES devices (id),
  -- Where it was said: global, confirm (a yes-or-no question waited), reminder.
  context text NOT NULL,
  outcome text NOT NULL CHECK (outcome IN ('command', 'ask', 'unmatched', 'nothing', 'leak', 'error', 'aborted')),
  -- A command's name (help, time, …) or the error's code: names, never words.
  detail text,
  stt_provider uuid REFERENCES providers (id),
  audio_ms int,
  stt_ms int,
  total_ms int,
  created_at timestamptz NOT NULL
);
CREATE INDEX assistant_turns_user ON assistant_turns (user_id, created_at);

-- A help question unanswered twice in push-to-talk: sent marked "unconfirmed" (the default), or not sent
-- (docs/plan.md, Decisions "Other help"; never in LIVE mode).
ALTER TABLE escalation_plans ADD COLUMN unconfirmed_policy text NOT NULL DEFAULT 'send' CHECK (unconfirmed_policy IN ('send', 'drop'));
