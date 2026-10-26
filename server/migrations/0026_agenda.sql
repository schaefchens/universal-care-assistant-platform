-- Appointments and tasks (docs/plan-m3.md, K7; CONCEPT §11: "The platform should support calendars, appointments,
-- tasks …"): the person's own, in core next to notes and reminders, so an appointment rings with the assistant
-- stopped. A helper with agenda.manage ("Termine und Aufgaben verwalten") keeps them too, never what the person marked
-- private, and never the message one came from.
CREATE TABLE appointments (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  -- The day it is, or first is; its time, or null for the whole day; both in its time zone (the person's).
  day date NOT NULL,
  time text CHECK (time ~ '^([01][0-9]|2[0-3]):[0-5][0-9]$'),
  duration_min integer CHECK (duration_min BETWEEN 1 AND 1440),
  timezone text NOT NULL,
  -- Weekly on these ISO weekdays (1 Monday … 7 Sunday), from `day` on; null: once.
  weekdays integer[],
  place text,
  note text,
  -- How long before it the person is reminded, in minutes (an M1 reminder each, linked by appointment_id).
  remind_before integer[] NOT NULL DEFAULT '{}',
  private boolean NOT NULL DEFAULT false,
  -- Where it came from, when it came from a message (later in K7); null: entered.
  source jsonb,
  version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);
CREATE INDEX appointments_person ON appointments (person_id, day) WHERE deleted_at IS NULL;

CREATE TABLE appointment_versions (
  appointment_id uuid NOT NULL REFERENCES appointments(id) ON DELETE CASCADE,
  version integer NOT NULL,
  -- {title, day, time, durationMin, weekdays, place, note, remindBefore, private, deleted}
  data jsonb NOT NULL,
  changed_by uuid NOT NULL REFERENCES users(id),
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (appointment_id, version)
);

CREATE TABLE tasks (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title text NOT NULL,
  note text,
  due_day date,
  -- Open while null.
  done_at timestamptz,
  private boolean NOT NULL DEFAULT false,
  source jsonb,
  version integer NOT NULL DEFAULT 1,
  created_by uuid NOT NULL REFERENCES users(id),
  updated_by uuid NOT NULL REFERENCES users(id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz
);
CREATE INDEX tasks_person ON tasks (person_id) WHERE deleted_at IS NULL;

CREATE TABLE task_versions (
  task_id uuid NOT NULL REFERENCES tasks(id) ON DELETE CASCADE,
  version integer NOT NULL,
  -- {title, note, dueDay, done, private, deleted}
  data jsonb NOT NULL,
  changed_by uuid NOT NULL REFERENCES users(id),
  changed_at timestamptz NOT NULL,
  PRIMARY KEY (task_id, version)
);

-- An appointment's reminders are M1's reminders (K7): made, moved and ended with it.
ALTER TABLE reminders ADD COLUMN appointment_id uuid REFERENCES appointments(id) ON DELETE SET NULL;
CREATE INDEX reminders_appointment ON reminders (appointment_id) WHERE appointment_id IS NOT NULL;
