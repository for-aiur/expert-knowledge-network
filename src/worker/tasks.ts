import { rubricFor } from '../repair';
import { isRecord, validateFields, workflowFor } from '../workflows';
import { allocation } from './review-allocation';
import type { Database } from './db';

type TaskResult = { data: unknown; status?: number; headers?: Record<string, string> };
const fail = (code: string, status: number): TaskResult => ({ data: { code }, status });
const keyPattern = /^ekn_[a-f0-9]{64}$/;
const uuidPattern = /^[a-f\d]{8}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{4}-[a-f\d]{12}$/;
const contactPattern = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/[^\s]+|\bekn_[a-f0-9]{64}\b/gi;
const forbiddenText = /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]|data:[^,\s]+,/i;

async function hash(value: string) {
  const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
  return Array.from(new Uint8Array(bytes), byte => byte.toString(16).padStart(2, '0')).join('');
}

export async function taskRoute(db: Database, request: Request, path: string,
  readJson: (request: Request, maxBytes?: number) => Promise<unknown>): Promise<TaskResult> {
  const id = path === '/api/v1/tasks' ? null : path.slice('/api/v1/tasks/'.length);
  if (id === null ? request.method !== 'POST' : request.method !== 'GET' || !uuidPattern.test(id)) {
    return fail('not_found', 404);
  }
  const key = /^Bearer (\S+)$/i.exec(request.headers.get('Authorization') ?? '')?.[1];
  const client = key && keyPattern.test(key) && await db.prepare(`
    SELECT id FROM external_api_clients WHERE api_key_hash = ? AND revoked_at IS NULL
  `).bind(await hash(key)).first<{ id: string }>();
  if (!client) {
    return { data: { code: 'unauthorized' }, status: 401, headers: { 'WWW-Authenticate': 'Bearer' } };
  }
  const limit = await db.prepare(`
    INSERT INTO external_client_limits (client_id, window_start, request_count)
    VALUES (?, unixepoch() / 60, 1)
    ON CONFLICT(client_id) DO UPDATE SET
      request_count = CASE WHEN window_start = excluded.window_start THEN request_count + 1 ELSE 1 END,
      window_start = excluded.window_start
    RETURNING request_count
  `).bind(client.id).first<{ request_count: number }>();
  if (!limit || limit.request_count > 60) {
    return { data: { code: 'rate_limited' }, status: 429, headers: { 'Retry-After': '60' } };
  }
  if (id) return taskResults(db, client.id, id);
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return fail('unsupported_media_type', 415);
  }
  const reference = request.headers.get('Idempotency-Key');
  if (!reference || !/^[a-zA-Z0-9._:-]{1,128}$/.test(reference)) return fail('invalid_idempotency_key', 400);
  const input = await readJson(request, 80_000);
  if (!isRecord(input)) return fail('invalid_body', 400);
  return createTask(db, client.id, reference, input);
}

async function createTask(db: Database, client: string, reference: string, input: Record<string, unknown>): Promise<TaskResult> {
  const { schema_version, content_language, required_reviews = 2, ...fields } = input;
  const schema = typeof schema_version === 'number' && workflowFor('diagnosis_review', schema_version);
  if (!schema || typeof content_language !== 'string' || content_language.length > 35 ||
      !/^[a-z]{2,8}(?:-[a-z\d]{1,8})*$/i.test(content_language) ||
      (required_reviews !== 2 && required_reviews !== 3)) return fail('invalid_task_metadata', 422);

  const { errors } = validateFields(schema, fields);
  if (Object.keys(errors).length) return { data: { code: 'invalid_task_fields', errors }, status: 422 };
  const payload: Record<string, string> = {};
  for (const field of schema.fields) {
    const value = fields[field.name];
    if (typeof value !== 'string') continue;
    if (forbiddenText.test(value) || value.replace(contactPattern, '') !== value) {
      return { data: { code: 'redact_private_context', field: field.name }, status: 422 };
    }
    payload[field.name] = field.type === 'select' ? value.trim() : value;
  }

  const digest = await hash(JSON.stringify([schema.version, content_language, required_reviews, payload]));
  const id = crypto.randomUUID();
  await db.batch([
    db.prepare(`INSERT INTO workflow_submissions
        (id, workflow_type, schema_version, equipment_category, source_type, payload, content_language, required_reviews)
      SELECT ?, 'diagnosis_review', ?, ?, 'external', ?, ?, ?
      WHERE NOT EXISTS (SELECT 1 FROM external_tasks WHERE client_id = ? AND client_reference = ?)
        AND EXISTS (SELECT 1 FROM external_api_clients WHERE id = ? AND revoked_at IS NULL)`)
      .bind(id, schema.version, payload.equipment_category, JSON.stringify(payload), content_language, required_reviews,
        client, reference, client),
    db.prepare(`INSERT INTO external_tasks (id, client_id, client_reference, submission_id, request_hash)
      SELECT id, ?, ?, id, ? FROM workflow_submissions WHERE id = ?`).bind(client, reference, digest, id),
    ...allocation(db, id),
  ]);
  const stored = await db.prepare(`SELECT id, request_hash FROM external_tasks
    WHERE client_id = ? AND client_reference = ?`).bind(client, reference).first<{ id: string; request_hash: string }>();
  if (!stored) return fail('unauthorized', 401);
  if (stored.request_hash !== digest) return fail('idempotency_conflict', 409);
  return { data: { id: stored.id, status: 'pending' }, status: stored.id === id ? 201 : 200 };
}

type ReviewResult = { nickname: string; assessment: string; rubric_version: number; created_at: number; answers: Record<string, string> };
type TaskRow = {
  id: string; schema_version: number; content_language: string; required_reviews: number;
  review_status: string; assessment_override: string | null; created_at: number; updated_at: number;
  assigned: number; completed: number; valid_votes: number; invalid_votes: number; unsafe: number;
  needed: number | null; candidates: number; reviews: string;
};

async function taskResults(db: Database, client: string, id: string): Promise<TaskResult> {
  const row = await db.prepare(`SELECT x.id, s.schema_version, s.content_language, s.required_reviews,
      s.review_status, s.assessment_override, x.created_at, s.updated_at,
      t.assigned, t.completed, t.valid_votes, t.invalid_votes, t.unsafe, p.needed,
      (SELECT count(*) FROM user_expertise e WHERE e.category_id = s.equipment_category
        AND e.user_id IS NOT s.user_id AND NOT EXISTS (
          SELECT 1 FROM review_assignments a WHERE a.submission_id = s.id AND a.reviewer_id = e.user_id
        )) AS candidates,
      (SELECT json_group_array(json_object(
          'assessment', r.overall_assessment, 'rubric_version', r.rubric_version,
          'created_at', r.created_at, 'answers', json(r.answers), 'nickname', r.nickname)
        ORDER BY r.created_at, r.id)
        FROM (SELECT r.*, u.nickname FROM review_assignments a
          JOIN reviews r ON r.assignment_id = a.id JOIN users u ON u.id = a.reviewer_id
          WHERE a.submission_id = s.id AND a.status = 'completed') r) AS reviews
    FROM external_tasks x JOIN workflow_submissions s ON s.id = x.submission_id
    JOIN workflow_review_round t ON t.id = s.id LEFT JOIN workflow_review_plan p ON p.id = s.id
    WHERE x.id = ? AND x.client_id = ? AND s.workflow_type = 'diagnosis_review'`)
    .bind(id, client).first<TaskRow>();
  if (!row) return fail('not_found', 404);

  const dissent = row.valid_votes > 0 && row.invalid_votes > 0;
  let status = row.assessment_override ?? (row.review_status === 'approved' ? 'peer_reviewed' : row.review_status);
  if (status === 'disputed') {
    if (row.assigned === row.completed && (row.needed === null || row.candidates < row.needed)) status = 'inconclusive';
    else if (!dissent) status = 'in_review';
  }
  const originalReviews = JSON.parse(row.reviews) as ReviewResult[];
  const reviews = originalReviews.map((review, index) => {
    const rubric = rubricFor(review.rubric_version, 'diagnosis_review');
    const answers = Object.fromEntries((rubric?.fields ?? []).map(field => [field.name, review.answers[field.name]]));
    return {
      review_number: index + 1, assessment: review.assessment, rubric_version: review.rubric_version,
      submitted_at: timestamp(review.created_at), answers,
      reasoning: redactReasoning(review.answers.reasoning ?? '', review.nickname),
    };
  });
  return { data: {
    id: row.id, workflow_type: 'diagnosis_review', schema_version: row.schema_version,
    content_language: row.content_language, status,
    review_counts: { required: row.required_reviews, assigned: row.assigned, completed: row.completed },
    aggregate: {
      assessment: status === 'peer_reviewed' ? 'valid' : status === 'rejected' ? 'invalid' :
        status === 'needs_clarification' ? 'needs_improvement' : null,
      disagreement: dissent, unsafe_next_step: Boolean(row.unsafe),
      clarification_requested: status === 'needs_clarification',
      reason: row.unsafe ? 'unsafe_next_step' : status === 'needs_clarification' ? 'needs_more_context' :
        status === 'peer_reviewed' || status === 'rejected' ? (dissent ? 'tie_break_majority' : 'consensus') :
        status === 'pending' ? 'waiting_for_eligible_reviewers' :
        status === 'inconclusive' ? 'insufficient_decisive_reviews' :
        status === 'disputed' ? 'conflicting_assessments' : 'reviews_in_progress',
    },
    reviews, created_at: timestamp(row.created_at),
    updated_at: timestamp(Math.max(row.updated_at, ...originalReviews.map(review => review.created_at))),
  } };
}

const timestamp = (seconds: number) => new Date(seconds * 1000).toISOString();

function redactReasoning(reasoning: string, nickname: string) {
  const text = reasoning.replace(contactPattern, '[redacted]');
  if (!nickname.trim()) return text;
  const escaped = nickname.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return text.replace(new RegExp('(?<![\\p{L}\\p{N}])' + escaped + '(?![\\p{L}\\p{N}])', 'giu'), '[redacted]');
}
