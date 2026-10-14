-- Interactive reminders (docs/plan.md, S6; CONCEPT §9): schedules in the person's time zone, occurrences made 48 h
-- ahead, prompts repeated while unanswered, and what the person answered. An answer is what the person reported,
-- never proof of a health outcome (CONCEPT §9: "distinguish user-reported information from independently verified
-- events"). Silence is never an emergency: a missed reminder informs helpers by agreed rules, it never alarms.

CREATE TABLE reminders (
  id uuid PRIMARY KEY,
  person_id uuid NOT NULL REFERENCES users (id),
  -- Made on the device that created it: the same creation sent twice is one reminder.
  client_reminder_id uuid NOT NULL,
  title text NOT NULL,
  prompt text NOT NULL,
  category text NOT NULL CHECK (category IN ('drink', 'meal', 'medication', 'movement', 'wellbeing', 'appointment', 'other')),
  -- {"kind": "once" | "daily" | "interval", …} (packages/shared/src/schedule.ts)
  schedule jsonb NOT NULL,
  timezone text NOT NULL,
  -- While unanswered: asked again every repeat_every_min minutes, repeat_count more times, then missed.
  repeat_every_min int NOT NULL DEFAULT 10 CHECK (repeat_every_min BETWEEN 2 AND 120),
  repeat_count int NOT NULL DEFAULT 2 CHECK (repeat_count BETWEEN 0 AND 6),
  snooze_min int NOT NULL DEFAULT 15 CHECK (snooze_min BETWEEN 5 AND 240),
  -- When missed: tell the helpers who may read this person's responses (none: tell nobody).
  follow_up text NOT NULL DEFAULT 'helpers' CHECK (follow_up IN ('none', 'helpers')),
  active boolean NOT NULL DEFAULT true,
  created_by uuid NOT NULL REFERENCES users (id),
  updated_by uuid NOT NULL REFERENCES users (id),
  created_at timestamptz NOT NULL,
  updated_at timestamptz NOT NULL,
  deleted_at timestamptz,
  version int NOT NULL DEFAULT 1,
  UNIQUE (person_id, client_reminder_id)
);
CREATE INDEX reminders_person ON reminders (person_id) WHERE deleted_at IS NULL;

CREATE TABLE reminder_occurrences (
  id uuid PRIMARY KEY,
  reminder_id uuid NOT NULL REFERENCES reminders (id),
  person_id uuid NOT NULL REFERENCES users (id),
  due_at timestamptz NOT NULL,
  state text NOT NULL CHECK (state IN ('scheduled', 'due', 'answered', 'missed', 'cancelled')),
  -- Prompts so far, and when the next one is (the first at due_at, then repeats or a snooze's end).
  prompts int NOT NULL DEFAULT 0,
  snoozes int NOT NULL DEFAULT 0,
  next_prompt_at timestamptz,
  ended_at timestamptz,
  UNIQUE (reminder_id, due_at)
);
CREATE INDEX reminder_occurrences_person ON reminder_occurrences (person_id, due_at);

CREATE TABLE reminder_responses (
  id uuid PRIMARY KEY,
  occurrence_id uuid NOT NULL REFERENCES reminder_occurrences (id),
  person_id uuid NOT NULL REFERENCES users (id),
  -- Made on the device: an answer sent twice counts once.
  client_response_id uuid NOT NULL UNIQUE,
  kind text NOT NULL CHECK (kind IN ('done', 'later', 'no', 'info', 'help')),
  -- What the person added in their own words (voice, from S9); never shown as fact.
  info text,
  care_request uuid REFERENCES care_requests (id),
  -- Reported by the person; independently verified events are a later, separate source.
  source text NOT NULL DEFAULT 'user_reported' CHECK (source IN ('user_reported')),
  reported_by uuid NOT NULL REFERENCES users (id),
  device_id uuid REFERENCES devices (id),
  at timestamptz NOT NULL
);
CREATE INDEX reminder_responses_person ON reminder_responses (person_id, at);
