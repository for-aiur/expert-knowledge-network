CREATE TABLE repair_drafts (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  content_language TEXT NOT NULL,
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  review_consent INTEGER NOT NULL CHECK (review_consent IN (0, 1)),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
CREATE INDEX repair_drafts_owner ON repair_drafts(user_id, updated_at);
ALTER TABLE workflow_submissions ADD COLUMN review_consented_at INTEGER;

CREATE TABLE point_reversals (
  entry_id TEXT PRIMARY KEY NOT NULL REFERENCES points_ledger(id),
  reason TEXT NOT NULL,
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX repairs_community ON workflow_submissions(updated_at, id)
  WHERE workflow_type = 'repair_case' AND review_status = 'approved' AND sharing_permission = 'community';

CREATE TRIGGER repair_review_no_self
BEFORE INSERT ON review_assignments
WHEN EXISTS (SELECT 1 FROM workflow_submissions
  WHERE id = NEW.submission_id AND workflow_type = 'repair_case' AND user_id = NEW.reviewer_id)
BEGIN
  SELECT RAISE(ABORT, 'Self review');
END;
