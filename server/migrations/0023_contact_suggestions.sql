-- A suggestion the person said no to (docs/plan-m3.md, K6: "other matches are suggested to the person … never merged
-- by name alone"): that one on that service is never asked about that contact again.
CREATE TABLE contact_suggestions_dismissed (
  person_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  connection_id uuid NOT NULL REFERENCES messaging_connections(id) ON DELETE CASCADE,
  external_id text NOT NULL,
  contact_id uuid NOT NULL REFERENCES contacts(id) ON DELETE CASCADE,
  at timestamptz NOT NULL,
  PRIMARY KEY (connection_id, external_id, contact_id)
);
