ALTER TABLE workflow_submissions ADD COLUMN required_reviews INTEGER NOT NULL DEFAULT 2
  CHECK (required_reviews BETWEEN 2 AND 3);
ALTER TABLE external_tasks ADD COLUMN request_hash TEXT;

CREATE TABLE external_client_limits (
  client_id TEXT PRIMARY KEY REFERENCES external_api_clients(id),
  window_start INTEGER NOT NULL,
  request_count INTEGER NOT NULL
);

CREATE VIEW workflow_review_round AS
SELECT s.id, s.workflow_type, s.user_id, s.equipment_category, s.required_reviews,
  s.review_status, s.assessment_override,
  coalesce(t.assigned, 0) AS assigned, coalesce(t.completed, 0) AS completed,
  coalesce(t.tie_breaks, 0) AS tie_breaks, coalesce(t.valid_votes, 0) AS valid_votes,
  coalesce(t.invalid_votes, 0) AS invalid_votes, coalesce(t.clarification_votes, 0) AS clarification_votes,
  EXISTS (SELECT 1 FROM review_assignments a JOIN reviews r ON r.assignment_id = a.id
    WHERE a.submission_id = s.id AND a.purpose = 'tie_break' AND a.status = 'completed'
      AND r.overall_assessment IN ('valid', 'invalid')) AS decisive_tie_break,
  CASE WHEN s.workflow_type = 'diagnosis_review' THEN EXISTS (
    SELECT 1 FROM review_assignments a JOIN reviews r ON r.assignment_id = a.id
    WHERE a.submission_id = s.id AND a.status = 'completed'
      AND json_extract(r.answers, '$.next_step_safety') = 'unsafe'
  ) ELSE 0 END AS unsafe
FROM workflow_submissions s LEFT JOIN repair_review_tally t ON t.submission_id = s.id
WHERE (s.workflow_type = 'repair_case' AND s.review_consented_at IS NOT NULL)
   OR (s.workflow_type = 'diagnosis_review' AND EXISTS (
     SELECT 1 FROM external_tasks x WHERE x.submission_id = s.id AND x.status <> 'cancelled'
   ));

CREATE VIEW workflow_review_plan AS
SELECT *, CASE WHEN assigned = 0 THEN required_reviews ELSE 1 END AS needed,
  CASE WHEN assigned = 0 THEN 'initial'
    WHEN valid_votes > 0 AND invalid_votes > 0 THEN 'tie_break'
    ELSE 'replacement' END AS purpose
FROM workflow_review_round
WHERE assessment_override IS NULL AND review_status IN ('pending', 'in_review', 'disputed')
  AND unsafe = 0 AND clarification_votes = 0
  AND (assigned = 0 OR (
    assigned = completed AND assigned >= required_reviews AND tie_breaks = 0
    AND (workflow_type = 'repair_case' OR assigned < 5)
    AND (valid_votes + invalid_votes < required_reviews OR (valid_votes > 0 AND invalid_votes > 0))
  ));

CREATE TRIGGER sync_external_task_review_status
AFTER UPDATE OF review_status, assessment_override ON workflow_submissions
WHEN NEW.workflow_type = 'diagnosis_review'
BEGIN
  UPDATE external_tasks SET status = CASE
    WHEN NEW.review_status IN ('approved', 'rejected') OR NEW.assessment_override IS NOT NULL THEN 'completed'
    WHEN NEW.review_status = 'pending' THEN 'queued' ELSE 'in_review' END,
    updated_at = NEW.updated_at
  WHERE submission_id = NEW.id AND status <> 'cancelled';
END;
