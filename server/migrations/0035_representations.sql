-- Representatives (docs/plan-m4.md, G6; the owner, 2026-10-27: "Person, or admin with a reason"): an arrangement of its
-- own, not a permission. The person names one of their helpers on their own device; an administrator can when the
-- person cannot, with a written reason, never naming themselves. A representative manages who may help the person and
-- what (helpers, their permissions, the person's devices): nothing of the person's data, no device linking, no
-- recovery, no consent to outside providers. One at a time; every act carries the arrangement.
CREATE TABLE representations (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES users (id),
  representative_id uuid NOT NULL REFERENCES users (id),
  made_by uuid NOT NULL REFERENCES users (id),
  made_how text NOT NULL CHECK (made_how IN ('person', 'admin')),
  -- An administrator's reason, said to the person.
  reason text CHECK (length(reason) BETWEEN 3 AND 300),
  started_at timestamptz NOT NULL,
  ended_at timestamptz,
  ended_by uuid REFERENCES users (id),
  CHECK (representative_id <> person_id),
  CHECK (made_how = 'person' OR (reason IS NOT NULL AND made_by <> representative_id))
);
CREATE UNIQUE INDEX representations_one ON representations (person_id) WHERE ended_at IS NULL;

-- Reserved since M1: a grant a representative made names the arrangement.
ALTER TABLE grants ADD CONSTRAINT grants_representation_fk FOREIGN KEY (representation_ref) REFERENCES representations (id);
