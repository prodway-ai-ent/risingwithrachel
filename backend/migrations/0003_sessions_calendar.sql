ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS google_event_id text;

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS calendar_sync_status text NOT NULL DEFAULT 'pending';

ALTER TABLE sessions
  ADD COLUMN IF NOT EXISTS calendar_sync_error text;

CREATE TABLE IF NOT EXISTS availability (
  id smallint PRIMARY KEY,
  timezone text NOT NULL,
  work_start_minute integer NOT NULL,
  work_end_minute integer NOT NULL,
  weekdays text NOT NULL,
  CONSTRAINT availability_one_row CHECK (id = 1)
);

INSERT INTO availability (id, timezone, work_start_minute, work_end_minute, weekdays)
SELECT 1, 'America/Chicago', 540, 1020, '1,2,3,4,5'
WHERE NOT EXISTS (SELECT 1 FROM availability WHERE id = 1);
