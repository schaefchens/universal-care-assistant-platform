-- People and permissions (docs/plan.md, S3; Appendix A "People"). A relationship joins a person and a helper; each
-- permission is one grant row, made by the person on their own device. Withdrawing ends rows, never deletes them.

CREATE TABLE relationships (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES users (id),
  helper_id uuid NOT NULL REFERENCES users (id),
  -- pending: the helper accepted an invitation and the person has not approved yet; active; ended.
  state text NOT NULL CHECK (state IN ('pending', 'active', 'ended')),
  invite_id uuid REFERENCES invites (id),
  proposed_scopes text[] NOT NULL DEFAULT '{}',
  created_at timestamptz NOT NULL,
  approved_at timestamptz,
  ended_at timestamptz,
  ended_by uuid REFERENCES users (id),
  CHECK (person_id <> helper_id)
);
-- One open relationship per pair; an ended one stays as history.
CREATE UNIQUE INDEX relationships_one_open ON relationships (person_id, helper_id) WHERE state <> 'ended';
CREATE INDEX relationships_person ON relationships (person_id) WHERE state <> 'ended';
CREATE INDEX relationships_helper ON relationships (helper_id) WHERE state <> 'ended';

CREATE TABLE grants (
  id uuid PRIMARY KEY,
  relationship_id uuid NOT NULL REFERENCES relationships (id),
  scope text NOT NULL,
  granted_by_user uuid NOT NULL REFERENCES users (id),
  -- Reserved (M4): a representative acting on the person's behalf.
  representation_ref uuid,
  created_at timestamptz NOT NULL,
  revoked_at timestamptz,
  revoked_by uuid REFERENCES users (id)
);
CREATE UNIQUE INDEX grants_one_active ON grants (relationship_id, scope) WHERE revoked_at IS NULL;
