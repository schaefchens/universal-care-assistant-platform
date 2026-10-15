-- LIVE mode (docs/plan-m2.md): a turn heard by the always-open microphone is marked so, and one the assistant judged
-- was not meant for it (the television, someone else in the room) is an outcome of its own: nothing was said or done.
ALTER TABLE assistant_turns ADD COLUMN mode text NOT NULL DEFAULT 'push' CHECK (mode IN ('push', 'live'));
ALTER TABLE assistant_turns DROP CONSTRAINT assistant_turns_outcome_check;
ALTER TABLE assistant_turns ADD CONSTRAINT assistant_turns_outcome_check CHECK (outcome IN ('command', 'ask', 'unmatched', 'nothing', 'leak', 'error', 'aborted', 'assistant', 'ignored'));
