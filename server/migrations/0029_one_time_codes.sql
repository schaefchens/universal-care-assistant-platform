-- A message that carries a one-time code (docs/plan-m3.md, Data: "a mark for one-time codes"; K8: "One-time codes are
-- never said by themselves"). Set as each message is stored, from its text and subject (server/src/messaging/codes.ts);
-- messages stored before carry none, and LIVE's news reach back a day.
ALTER TABLE messaging_messages ADD COLUMN one_time_code boolean NOT NULL DEFAULT false;
