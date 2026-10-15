-- An email's subject goes with what the person confirmed (docs/plan-m3.md, K1): the thread's "Re: …" or their own,
-- read back in the confirmation question (C1) and sent as it was read.
ALTER TABLE messaging_outbound ADD COLUMN subject text;
