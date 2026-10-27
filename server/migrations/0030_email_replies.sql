-- An email thread's replies (the owner, 2026-10-27: "should have default only sender with option to reply all"): whom a
-- reply goes to, everyone a reply to all goes to, and which of the person's addresses the newest mail came to, as the
-- email connector tells them (packages/shared, WireChat.mail).
ALTER TABLE messaging_conversations ADD COLUMN mail jsonb;

-- The person's senders on an email account (the owner, 2026-10-27: "the user might have different aliases and therefore
-- its importan to reply with the correct email and name. we need to configure identities like email apps have"): a
-- list of {name, address}, the default first. An account connected before has its address alone, without a name, as
-- its mail went out until now.
ALTER TABLE messaging_connections ADD COLUMN identities jsonb;
UPDATE messaging_connections SET identities = jsonb_build_array(jsonb_build_object('name', '', 'address', account)) WHERE service = 'email';

-- A reply to everyone in an email thread, and the sender a mail goes out as, as the person confirmed them.
ALTER TABLE messaging_outbound ADD COLUMN reply_all boolean NOT NULL DEFAULT false;
ALTER TABLE messaging_outbound ADD COLUMN sender jsonb;
