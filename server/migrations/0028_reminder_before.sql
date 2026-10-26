-- An appointment's reminder keeps how long before the appointment it rings (docs/plan-m3.md, K7), so the person's
-- device says "Der Termin ist in einer Stunde, um 10 Uhr, …" in its own language, as it says every reminder's default
-- question (docs/plan.md, S6). Words kept by the server would be in the language the person signed up with.
ALTER TABLE reminders ADD COLUMN before_min integer CHECK (before_min >= 0);
UPDATE reminders SET prompt = '' WHERE appointment_id IS NOT NULL;
