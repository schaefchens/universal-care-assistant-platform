-- A connection keeps only what differs from its service's capabilities (docs/plan-m3.md, K1); the service's own come
-- from the code, so a correction there reaches every connection. Until now each row held a copy, and Telegram's said
-- "full" history although UCAP fetches 30 days at linking ("since": CONCEPT §3, connector honesty).
UPDATE messaging_connections SET capabilities = '{}'::jsonb;
