ALTER TABLE sessions DROP CONSTRAINT IF EXISTS sessions_status_check;

ALTER TABLE sessions
  ADD CONSTRAINT sessions_status_check
  CHECK (status IN ('requested', 'scheduled', 'completed', 'cancelled', 'denied'));

ALTER TABLE availability
  ADD COLUMN IF NOT EXISTS slot_minutes integer NOT NULL DEFAULT 60;

UPDATE availability
SET timezone = 'America/New_York',
    work_start_minute = 540,
    work_end_minute = 1020,
    weekdays = '1,2,3,4,5',
    slot_minutes = 60
WHERE id = 1;
