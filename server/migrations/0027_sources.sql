-- What is made from a message keeps it as its source (docs/plan-m3.md, K7; CONCEPT §11: "Information saved from
-- messages, documents, and websites should retain its source so that users can revisit the original"): the message's
-- id, its service, who sent it and when, never its text. Appointments and tasks have theirs since 0026. A note's
-- `source` already says how it was made (typed, voice, assistant): the message a note came from is its `origin`.
ALTER TABLE notes ADD COLUMN origin jsonb;
ALTER TABLE reminders ADD COLUMN source jsonb;
