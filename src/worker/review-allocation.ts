import { rubricFor } from '../repair';
import type { Database } from './db';

export function allocation(db: Database, id: string) {
  return [
    db.prepare(`
      WITH candidates AS MATERIALIZED (
        SELECT e.user_id, t.id, t.needed, t.purpose, t.workflow_type
        FROM workflow_review_plan t JOIN user_expertise e ON e.category_id = t.equipment_category
        WHERE t.id = ? AND e.user_id IS NOT t.user_id AND NOT EXISTS (
          SELECT 1 FROM review_assignments a WHERE a.submission_id = t.id AND a.reviewer_id = e.user_id)
        ORDER BY random() LIMIT 3
      )
      INSERT INTO review_assignments (id, submission_id, reviewer_id, purpose, rubric_version)
      SELECT lower(hex(randomblob(16))), id, user_id, purpose,
        CASE workflow_type WHEN 'diagnosis_review' THEN ? ELSE ? END
      FROM candidates WHERE (SELECT count(*) FROM candidates) >= needed
      LIMIT coalesce((SELECT needed FROM candidates LIMIT 1), 0)
    `).bind(id, rubricFor(undefined, 'diagnosis_review').version, rubricFor().version),
    db.prepare(`UPDATE workflow_submissions SET review_status = 'in_review', updated_at = unixepoch()
      WHERE id = ? AND review_status = 'pending'
        AND (SELECT count(*) FROM review_assignments WHERE submission_id = ?) >= required_reviews`).bind(id, id),
  ];
}
