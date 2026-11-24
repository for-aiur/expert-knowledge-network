CREATE TABLE users (
  id TEXT PRIMARY KEY NOT NULL,
  email TEXT NOT NULL UNIQUE COLLATE NOCASE,
  nickname TEXT NOT NULL,
  password_salt TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  password_iterations INTEGER NOT NULL CHECK (password_iterations > 0),
  role TEXT NOT NULL DEFAULT 'member' CHECK (role IN ('member', 'admin')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE user_expertise (
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  category_id TEXT NOT NULL,
  PRIMARY KEY (user_id, category_id)
);
CREATE INDEX user_expertise_by_category ON user_expertise(category_id, user_id);

CREATE TABLE sessions (
  token_hash TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  expires_at INTEGER NOT NULL
);
CREATE INDEX sessions_by_user ON sessions(user_id);
CREATE INDEX sessions_by_expiry ON sessions(expires_at);

CREATE TABLE auth_limits (
  rate_key TEXT PRIMARY KEY NOT NULL,
  window_start INTEGER NOT NULL,
  attempts INTEGER NOT NULL CHECK (attempts > 0)
);
CREATE INDEX auth_limits_by_window ON auth_limits(window_start);

CREATE TABLE workflow_submissions (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT REFERENCES users(id),
  workflow_type TEXT NOT NULL CHECK (workflow_type IN ('repair_case', 'diagnosis_review')),
  schema_version INTEGER NOT NULL CHECK (schema_version > 0),
  equipment_category TEXT NOT NULL,
  source_type TEXT NOT NULL CHECK (source_type IN ('firsthand', 'observed', 'secondhand', 'external')),
  review_status TEXT NOT NULL DEFAULT 'pending' CHECK (review_status IN ('pending', 'in_review', 'approved', 'rejected', 'disputed')),
  sharing_permission TEXT NOT NULL DEFAULT 'private' CHECK (sharing_permission IN ('private', 'community')),
  sharing_recorded_at INTEGER NOT NULL DEFAULT (unixepoch()),
  payload TEXT NOT NULL CHECK (json_valid(payload) AND json_type(payload) = 'object'),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK (workflow_type != 'repair_case' OR (user_id IS NOT NULL AND source_type != 'external')),
  CHECK (workflow_type != 'diagnosis_review' OR sharing_permission = 'private'),
  UNIQUE (id, workflow_type)
);
CREATE INDEX submissions_by_owner ON workflow_submissions(user_id, created_at);
CREATE INDEX submissions_by_workflow_status ON workflow_submissions(workflow_type, review_status, created_at);

CREATE TABLE review_assignments (
  id TEXT PRIMARY KEY NOT NULL,
  submission_id TEXT NOT NULL REFERENCES workflow_submissions(id),
  reviewer_id TEXT NOT NULL REFERENCES users(id),
  status TEXT NOT NULL DEFAULT 'assigned' CHECK (status IN ('assigned', 'completed', 'cancelled')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  UNIQUE (submission_id, reviewer_id)
);
CREATE INDEX assignments_by_reviewer ON review_assignments(reviewer_id, status);

CREATE TABLE reviews (
  id TEXT PRIMARY KEY NOT NULL,
  assignment_id TEXT NOT NULL UNIQUE REFERENCES review_assignments(id),
  decision TEXT NOT NULL CHECK (decision IN ('approve', 'reject', 'uncertain')),
  answers TEXT NOT NULL CHECK (json_valid(answers) AND json_type(answers) = 'object'),
  created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE TABLE points_ledger (
  id TEXT PRIMARY KEY NOT NULL,
  user_id TEXT NOT NULL REFERENCES users(id),
  submission_id TEXT REFERENCES workflow_submissions(id),
  review_id TEXT REFERENCES reviews(id),
  points INTEGER NOT NULL CHECK (points > 0),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  CHECK ((submission_id IS NULL) != (review_id IS NULL)),
  UNIQUE (submission_id),
  UNIQUE (review_id)
);
CREATE INDEX points_by_user ON points_ledger(user_id, created_at);

CREATE TABLE external_api_clients (
  id TEXT PRIMARY KEY NOT NULL,
  label TEXT NOT NULL,
  api_key_hash TEXT NOT NULL UNIQUE,
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  revoked_at INTEGER
);

CREATE TABLE external_tasks (
  id TEXT PRIMARY KEY NOT NULL,
  client_id TEXT NOT NULL REFERENCES external_api_clients(id),
  client_reference TEXT NOT NULL,
  submission_id TEXT NOT NULL UNIQUE,
  workflow_type TEXT NOT NULL DEFAULT 'diagnosis_review' CHECK (workflow_type = 'diagnosis_review'),
  status TEXT NOT NULL DEFAULT 'queued' CHECK (status IN ('queued', 'in_review', 'completed', 'cancelled')),
  created_at INTEGER NOT NULL DEFAULT (unixepoch()),
  updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
  FOREIGN KEY (submission_id, workflow_type) REFERENCES workflow_submissions(id, workflow_type),
  UNIQUE (client_id, client_reference)
);
