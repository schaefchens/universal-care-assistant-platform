-- Care on Android (docs/plan.md, S5): the phone fallback of the escalation plan. When the person's device cannot
-- reach the server, it offers to call this person instead (A3b), by a deliberate activation only; opt-in per person.
-- {"name": "Maria", "number": "+4930…", "direct": false}; direct = call at once (CALL_PHONE granted), else the dialler.
ALTER TABLE escalation_plans ADD COLUMN phone_fallback jsonb;
