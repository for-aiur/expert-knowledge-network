ALTER TABLE workflow_submissions ADD COLUMN assessment_override TEXT
  CHECK (assessment_override IS NULL OR assessment_override = 'needs_clarification');
ALTER TABLE workflow_submissions ADD COLUMN previous_revision_id TEXT REFERENCES workflow_submissions(id);
CREATE UNIQUE INDEX repair_one_next_revision ON workflow_submissions(previous_revision_id)
  WHERE previous_revision_id IS NOT NULL;
ALTER TABLE repair_drafts ADD COLUMN previous_revision_id TEXT REFERENCES workflow_submissions(id);
CREATE UNIQUE INDEX repair_one_revision_draft ON repair_drafts(previous_revision_id)
  WHERE previous_revision_id IS NOT NULL;

ALTER TABLE review_assignments ADD COLUMN purpose TEXT NOT NULL DEFAULT 'initial'
  CHECK (purpose IN ('initial', 'replacement', 'tie_break'));
ALTER TABLE reviews ADD COLUMN rubric_version INTEGER;
ALTER TABLE reviews ADD COLUMN overall_assessment TEXT
  CHECK (overall_assessment IN ('valid', 'needs_improvement', 'invalid', 'cannot_assess'));
UPDATE reviews SET overall_assessment = CASE decision
  WHEN 'approve' THEN 'valid' WHEN 'reject' THEN 'invalid' ELSE 'cannot_assess' END;
UPDATE review_assignments SET purpose = 'tie_break'
WHERE id IN (
  SELECT id FROM (
    SELECT id, row_number() OVER (PARTITION BY submission_id ORDER BY created_at, rowid) AS position
    FROM review_assignments
  ) WHERE position = 3
);

ALTER TABLE review_assignments ADD COLUMN rubric_version INTEGER NOT NULL DEFAULT 1 CHECK (rubric_version > 0);

CREATE VIEW repair_review_tally AS
SELECT a.submission_id, count(*) AS assigned, count(r.id) AS completed,
  sum(CASE WHEN a.purpose = 'tie_break' THEN 1 ELSE 0 END) AS tie_breaks,
  sum(CASE WHEN r.overall_assessment = 'valid' THEN 1 ELSE 0 END) AS valid_votes,
  sum(CASE WHEN r.overall_assessment = 'invalid' THEN 1 ELSE 0 END) AS invalid_votes,
  sum(CASE WHEN r.overall_assessment = 'needs_improvement' THEN 1 ELSE 0 END) AS clarification_votes
FROM review_assignments a LEFT JOIN reviews r ON r.assignment_id = a.id
WHERE a.status <> 'cancelled'
GROUP BY a.submission_id;
