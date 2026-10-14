-- Whether a person's help requests can reach anyone (docs/plan.md, Appendix D "Heartbeats"): the last state the
-- person was told, so a change is announced once (A21), not on every heartbeat.
CREATE TABLE care_reachability (
  person_id uuid PRIMARY KEY REFERENCES users (id),
  reachable boolean NOT NULL,
  changed_at timestamptz NOT NULL
);
