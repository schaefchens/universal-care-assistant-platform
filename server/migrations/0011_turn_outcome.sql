-- A turn the assistant answered (S9) is an outcome of its own: what it did is in assistant_actions, never here.
ALTER TABLE assistant_turns DROP CONSTRAINT assistant_turns_outcome_check;
ALTER TABLE assistant_turns ADD CONSTRAINT assistant_turns_outcome_check CHECK (outcome IN ('command', 'ask', 'unmatched', 'nothing', 'leak', 'error', 'aborted', 'assistant'));
