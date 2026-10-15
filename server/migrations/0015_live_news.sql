-- LIVE mode's attention manager (docs/plan-m2.md, L4): when a message was announced by itself, so it is never
-- announced twice (on any of the person's devices); what it said is not kept.
ALTER TABLE messaging_messages ADD COLUMN live_announced_at timestamptz;
CREATE INDEX messaging_messages_live_pending ON messaging_messages (conversation_id, sent_at) WHERE direction = 'in' AND read_at IS NULL AND heard_at IS NULL AND live_announced_at IS NULL;
