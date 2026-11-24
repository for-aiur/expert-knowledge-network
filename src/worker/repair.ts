import { allocation } from './review-allocation';
import type { WorkflowType } from '../repair';
import { equipmentKey } from '../equipment';
import { rubricFor, rubricOptions, statuses, type Assessment, type FeedbackEntry, type Repair } from '../repair';
import { categories, isRecord, validateFields, workflowFor } from '../workflows';
import type { Locale, Message } from '../i18n/messages';
import type { Database } from './db';

type Result = { data: unknown; status?: number };
type Row = Omit<Repair, 'status' | 'values' | 'review_consent' | 'dissent'> & {
  status: string;
  payload: string;
  review_consent?: number;
  dissent?: number;
};
const fail = (code: Message, status: number): Result => ({ data: { code }, status });
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const publicFilter = "s.workflow_type = 'repair_case' AND s.review_status = 'approved' AND s.sharing_permission = 'community' AND s.review_consented_at IS NOT NULL";
const repairColumns = `s.id, s.schema_version, coalesce(s.assessment_override, s.review_status) AS status, s.source_type, s.sharing_permission,
  s.content_language, s.created_at, s.updated_at, s.payload, s.previous_revision_id,
  EXISTS (SELECT 1 FROM repair_review_tally t WHERE t.submission_id = s.id AND
    t.valid_votes > 0 AND t.invalid_votes > 0) AS dissent`;
const draftColumns = `id, schema_version, 'draft' AS status, json_extract(payload, '$.source_type') AS source_type,
  json_extract(payload, '$.sharing_permission') AS sharing_permission, content_language, updated_at, payload, previous_revision_id, 0 AS dissent, review_consent`;

function serialize(row: Row, type: WorkflowType = 'repair_case') {
  const { payload, review_consent, dissent, ...data } = row;
  const workflow = workflowFor(type, row.schema_version);
  const raw: unknown = JSON.parse(payload);
  const values = Object.fromEntries((workflow?.fields ?? []).flatMap(field =>
    isRecord(raw) && typeof raw[field.name] === 'string' ? [[field.name, raw[field.name]]] : []));
  return {
    ...data,
    dissent: Boolean(dissent),
    status: row.status === 'approved' ? 'peer_reviewed' : row.status,
    values,
    ...(review_consent === undefined ? {} : { review_consent: Boolean(review_consent) }),
  } as Repair;
}

function page(url: URL) {
  const limit = url.searchParams.get('limit') ?? '20';
  const offset = url.searchParams.get('offset') ?? '0';
  if (!/^\d{1,6}$/.test(limit) || !/^\d{1,6}$/.test(offset) || +limit < 1 || +limit > 50) return null;
  return { limit: +limit, offset: +offset };
}

function paginated<T>(items: T[], paging: { limit: number; offset: number }) {
  return { items: items.slice(0, paging.limit), next_offset: items.length > paging.limit ? paging.offset + paging.limit : null };
}

async function own(db: Database, user: string, id: string) {
  return await db.prepare(`SELECT ${draftColumns} FROM repair_drafts WHERE id = ? AND user_id = ?`)
    .bind(id, user).first<Row>() ??
    await db.prepare(`SELECT ${repairColumns} FROM workflow_submissions s
      WHERE s.id = ? AND s.user_id = ? AND s.workflow_type = 'repair_case'`).bind(id, user).first<Row>();
}

async function repairLists(db: Database, url: URL, user: string | null): Promise<Result> {
  const paging = page(url);
  const category = url.searchParams.get('category');
  const source = url.searchParams.get('source_type');
  const status = url.searchParams.get('status');
  const community = url.pathname === '/api/v1/repairs';
  if (!paging || (category !== null && !categories.some(option => option.value === category)) ||
      (source !== null && !['firsthand', 'observed', 'secondhand'].includes(source)) ||
      (status !== null && (community || !statuses.some(item => item === status)))) return fail('formatError', 400);
  if (!community && !user) return fail('needAccount', 401);

  const rows = community
    ? await db.prepare(`SELECT ${repairColumns}, u.nickname AS author_nickname
        FROM workflow_submissions s JOIN users u ON u.id = s.user_id WHERE ${publicFilter}
        AND (? IS NULL OR s.equipment_category = ?) AND (? IS NULL OR s.source_type = ?)
        ORDER BY s.updated_at DESC, s.id DESC LIMIT ? OFFSET ?`)
      .bind(category, category, source, source, paging.limit + 1, paging.offset).all<Row>()
    : await db.prepare(`SELECT * FROM (
        SELECT ${repairColumns.replace('s.created_at, ', '')}, NULL AS review_consent
          FROM workflow_submissions s WHERE s.user_id = ? AND s.workflow_type = 'repair_case'
        UNION ALL SELECT ${draftColumns} FROM repair_drafts WHERE user_id = ?
      ) WHERE (? IS NULL OR status = ?) AND (? IS NULL OR json_extract(payload, '$.equipment_category') = ?)
        AND (? IS NULL OR source_type = ?) ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
      .bind(user, user, status, status === 'peer_reviewed' ? 'approved' : status, category, category,
        source, source, paging.limit + 1, paging.offset).all<Row>();
  return { data: paginated(rows.results.map(row => {
    if (community) delete row.previous_revision_id;
    if (row.status !== 'draft') delete row.review_consent;
    return serialize(row);
  }), paging) };
}

async function saveDraft(db: Database, user: string, id: string, input: Record<string, unknown>, locale: Locale): Promise<Result> {
  const { values, schema_version, content_language, review_consent } = input;
  const workflow = typeof schema_version === 'number' ? workflowFor('repair_case', schema_version) : null;
  if (!workflow || !isRecord(values) || typeof review_consent !== 'boolean' ||
      typeof content_language !== 'string' || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*$/i.test(content_language) ||
      content_language.length > 35) return fail('formatError', 400);
  const { errors } = validateFields({ ...workflow, fields: workflow.fields.map(field =>
    ({ ...field, required: false, required_if: undefined })) }, values, locale);
  if (Object.keys(errors).length) return { data: { errors }, status: 422 };
  const row = await db.prepare(`
    INSERT INTO repair_drafts (id, user_id, schema_version, content_language, payload, review_consent)
    SELECT ?, ?, ?, ?, ?, ? WHERE NOT EXISTS (SELECT 1 FROM workflow_submissions WHERE id = ?)
    ON CONFLICT(id) DO UPDATE SET content_language = excluded.content_language, payload = excluded.payload,
      review_consent = excluded.review_consent, updated_at = unixepoch()
    WHERE repair_drafts.user_id = excluded.user_id AND repair_drafts.schema_version = excluded.schema_version
    RETURNING ${draftColumns}
  `).bind(id, user, schema_version as number, content_language, JSON.stringify(values), Number(review_consent), id).first<Row>();
  return row ? { data: serialize(row) } : fail('repairConflict', 409);
}

async function submit(db: Database, user: string, id: string, locale: Locale): Promise<Result> {
  const row = await own(db, user, id);
  if (!row) return fail('notFound', 404);
  if (row.status !== 'draft') return { data: serialize(row) };
  const workflow = workflowFor('repair_case', row.schema_version);
  if (!workflow) return fail('formMissing', 404);
  if (!row.review_consent) return fail('consentNeeded', 422);
  const { errors } = validateFields(workflow, JSON.parse(row.payload), locale);
  if (Object.keys(errors).length) return { data: { errors }, status: 422 };
  await db.batch([
    db.prepare(`INSERT INTO workflow_submissions
      (id, user_id, workflow_type, schema_version, equipment_category, source_type, sharing_permission,
       payload, content_language, review_consented_at, previous_revision_id)
      SELECT id, user_id, 'repair_case', schema_version, trim(json_extract(payload, '$.equipment_category')),
        trim(json_extract(payload, '$.source_type')), trim(json_extract(payload, '$.sharing_permission')),
        payload, content_language, unixepoch(), previous_revision_id FROM repair_drafts
      WHERE id = ? AND user_id = ? AND payload = ? AND content_language = ? AND review_consent = 1
      ON CONFLICT(id) DO NOTHING`).bind(id, user, row.payload, row.content_language),
    db.prepare(`DELETE FROM repair_drafts WHERE id = ? AND user_id = ?
      AND EXISTS (SELECT 1 FROM workflow_submissions WHERE id = ? AND user_id = ?)`).bind(id, user, id, user),
    db.prepare(`INSERT OR IGNORE INTO points_ledger (id, user_id, submission_id, points)
      SELECT ?, user_id, id, ? FROM workflow_submissions WHERE id = ? AND user_id = ? AND previous_revision_id IS NULL AND ? > 0`)
      .bind(crypto.randomUUID(), workflow.points.submission, id, user, workflow.points.submission),
    ...allocation(db, id),
  ]);
  const saved = await own(db, user, id);
  return saved && saved.status !== 'draft' ? { data: serialize(saved) } : fail('repairConflict', 409);
}

function feedbackEntry(row: { overall_assessment: Assessment; rubric_version: number | null; answers: string }): FeedbackEntry {
  return { assessment: row.overall_assessment, rubric_version: row.rubric_version, answers: JSON.parse(row.answers) };
}

async function ownerDetail(db: Database, user: string, id: string): Promise<Result> {
  const row = await own(db, user, id);
  if (!row) return fail('notFound', 404);
  const repair = serialize(row);
  if (['needs_clarification', 'approved', 'rejected', 'disputed'].includes(row.status)) {
    const { results } = await db.prepare(`SELECT r.overall_assessment, r.rubric_version, r.answers
      FROM reviews r JOIN review_assignments a ON a.id = r.assignment_id
      WHERE a.submission_id = ? AND r.overall_assessment IS NOT NULL
      ORDER BY r.created_at, a.id`).bind(id).all<{
        overall_assessment: Assessment; rubric_version: number | null; answers: string;
      }>();
    repair.feedback = results.map(feedbackEntry);
  }
  if (row.status === 'needs_clarification') {
    const next = await db.prepare(`SELECT id FROM workflow_submissions WHERE previous_revision_id = ? AND user_id = ?
      UNION ALL SELECT id FROM repair_drafts WHERE previous_revision_id = ? AND user_id = ? LIMIT 1`)
      .bind(id, user, id, user).first<{ id: string }>();
    repair.next_revision_id = next?.id ?? null;
  }
  return { data: repair };
}

async function startRevision(db: Database, user: string, id: string): Promise<Result> {
  const row = await own(db, user, id);
  if (!row) return fail('notFound', 404);
  if (row.status !== 'needs_clarification') return fail('repairConflict', 409);
  await db.prepare(`INSERT INTO repair_drafts
      (id, user_id, schema_version, content_language, payload, review_consent, previous_revision_id)
    SELECT ?, user_id, schema_version, content_language, payload, 0, id FROM workflow_submissions
    WHERE id = ? AND user_id = ? AND assessment_override = 'needs_clarification'
      AND NOT EXISTS (SELECT 1 FROM workflow_submissions WHERE previous_revision_id = ?)
    ON CONFLICT DO NOTHING`).bind(crypto.randomUUID(), id, user, id).run();
  const revision = await db.prepare(`SELECT id, 'draft' AS status FROM repair_drafts WHERE previous_revision_id = ? AND user_id = ?
    UNION ALL SELECT id, review_status AS status FROM workflow_submissions WHERE previous_revision_id = ? AND user_id = ? LIMIT 1`)
    .bind(id, user, id, user).first<{ id: string; status: string }>();
  return revision ? { data: revision } : fail('repairConflict', 409);
}

async function assignments(db: Database, user: string, url: URL): Promise<Result> {
  const paging = page(url);
  if (!paging) return fail('formatError', 400);
  const { results } = await db.prepare(`SELECT ${repairColumns}, a.id AS assignment_id,
      s.workflow_type, a.status AS assignment_status, a.rubric_version AS assignment_rubric, r.rubric_version, r.overall_assessment, r.answers
    FROM review_assignments a JOIN workflow_submissions s ON s.id = a.submission_id
    LEFT JOIN reviews r ON r.assignment_id = a.id
    WHERE a.reviewer_id = ? AND a.status <> 'cancelled'
    ORDER BY a.status = 'assigned' DESC, a.created_at DESC, a.id LIMIT ? OFFSET ?`)
    .bind(user, paging.limit + 1, paging.offset).all<Row & {
      workflow_type: WorkflowType; assignment_id: string; assignment_status: string; assignment_rubric: number; rubric_version: number | null;
      overall_assessment: Assessment | null; answers: string | null;
    }>();
  return { data: paginated(results.map(row => {
    const repair = serialize(row, row.workflow_type);
    delete repair.values.sharing_permission;
    return {
      id: row.assignment_id, workflow_type: row.workflow_type, completed: row.assignment_status === 'completed', rubric_version: row.assignment_rubric,
      feedback: row.overall_assessment && row.answers ? feedbackEntry({
        overall_assessment: row.overall_assessment, rubric_version: row.rubric_version, answers: row.answers,
      }) : null,
      repair: { id: repair.id, content_language: repair.content_language, schema_version: repair.schema_version, values: repair.values },
    };
  }), paging) };
}

async function review(db: Database, user: string, id: string, input: Record<string, unknown>): Promise<Result> {
  const row = await db.prepare(`SELECT a.submission_id, a.status, s.schema_version, s.workflow_type, a.rubric_version,
      json_extract(s.payload, '$.outcome') AS outcome,
      json_extract(s.payload, '$.recommended_next_steps') AS next_steps
    FROM review_assignments a JOIN workflow_submissions s ON s.id = a.submission_id
    WHERE a.id = ? AND a.reviewer_id = ? AND a.status <> 'cancelled'`)
    .bind(id, user).first<{
      submission_id: string; status: string; schema_version: number; rubric_version: number; workflow_type: WorkflowType; outcome: string | null; next_steps: string | null;
    }>();
  if (!row) return fail('notFound', 404);
  if (row.status === 'completed') return { data: { completed: true } };
  const rubric = rubricFor(row.rubric_version, row.workflow_type);
  if (!rubric) return fail('formMissing', 404);
  const { answers, reasoning } = input;
  if (!isRecord(answers) || Object.keys(answers).length !== rubric.fields.length ||
      !rubric.fields.every(field => rubricOptions(field, row.outcome?.trim() ?? '').some(value => value === answers[field.name])) ||
      typeof reasoning !== 'string' || reasoning.length > rubric.reasoning.max_length ||
      (rubric.reasoning.required_for.some(value => value === answers.overall_assessment) && !reasoning.trim())) {
    return fail('reviewInvalid', 422);
  }
  const assessment = answers.overall_assessment as Assessment;
  if (row.workflow_type === 'diagnosis_review') {
    const hasSteps = Boolean(row.next_steps?.trim());
    if ((answers.next_step_safety === 'not_applicable') === hasSteps) return fail('reviewInvalid', 422);
    if (answers.next_step_safety === 'unsafe' && (assessment === 'valid' || !reasoning.trim())) {
      return fail('unsafeAssessment', 422);
    }
  }
  const legacyDecision = assessment === 'valid' ? 'approve' : assessment === 'invalid' ? 'reject' : 'uncertain';
  const points = qualifiedReviewPoints(row.workflow_type, row.schema_version, reasoning);
  const submission = row.submission_id;
  await db.batch([
    db.prepare(`INSERT OR IGNORE INTO reviews (id, assignment_id, decision, answers, overall_assessment, rubric_version)
      SELECT ?, id, ?, ?, ?, rubric_version FROM review_assignments WHERE id = ? AND reviewer_id = ? AND status = 'assigned'`)
      .bind(crypto.randomUUID(), legacyDecision, JSON.stringify({ ...answers, reasoning }), assessment, id, user),
    db.prepare(`UPDATE review_assignments SET status = 'completed', updated_at = unixepoch()
      WHERE id = ? AND reviewer_id = ? AND EXISTS (SELECT 1 FROM reviews WHERE assignment_id = ?)`).bind(id, user, id),
    db.prepare(`INSERT OR IGNORE INTO points_ledger (id, user_id, review_id, points)
      SELECT ?, a.reviewer_id, r.id, ? FROM reviews r JOIN review_assignments a ON a.id = r.assignment_id
      WHERE a.id = ? AND a.reviewer_id = ? AND ? > 0
        AND length(trim(json_extract(r.answers, '$.reasoning'))) >= 30`).bind(crypto.randomUUID(), points, id, user, points),
    db.prepare(`
      UPDATE workflow_submissions AS s
      SET review_status = CASE
        WHEN t.unsafe = 1 THEN 'rejected'
        WHEN t.clarification_votes > 0 THEN 'disputed'
        WHEN t.workflow_type = 'repair_case' AND t.valid_votes >= 2 THEN 'approved'
        WHEN t.workflow_type = 'repair_case' AND t.invalid_votes >= 2 THEN 'rejected'
        WHEN t.workflow_type = 'diagnosis_review' AND t.valid_votes + t.invalid_votes >= t.required_reviews
          AND (t.invalid_votes = 0 OR (t.decisive_tie_break = 1 AND t.valid_votes > t.invalid_votes)) THEN 'approved'
        WHEN t.workflow_type = 'diagnosis_review' AND t.valid_votes + t.invalid_votes >= t.required_reviews
          AND (t.valid_votes = 0 OR (t.decisive_tie_break = 1 AND t.invalid_votes > t.valid_votes)) THEN 'rejected'
        ELSE 'disputed' END,
        assessment_override = CASE WHEN t.clarification_votes > 0 AND t.unsafe = 0 THEN 'needs_clarification' ELSE NULL END,
        updated_at = unixepoch()
      FROM workflow_review_round t
      WHERE s.id = ? AND t.id = s.id AND s.assessment_override IS NULL
        AND s.review_status IN ('in_review', 'disputed') AND t.assigned = t.completed
        AND t.completed >= t.required_reviews
    `).bind(submission),
    ...allocation(db, submission),
  ]);
  return { data: { completed: true } };
}

function qualifiedReviewPoints(type: WorkflowType, version: number, reasoning: string) {
  return reasoning.trim().length >= 30 ? workflowFor(type, version)?.points.review ?? 0 : 0;
}

async function activity(db: Database, user: string): Promise<Result> {
  const [total, history, metrics] = await Promise.all([
    db.prepare(`SELECT coalesce(sum(p.points),0) AS points FROM points_ledger p
      LEFT JOIN point_reversals x ON x.entry_id = p.id WHERE p.user_id = ? AND x.entry_id IS NULL`)
      .bind(user).first<{ points: number }>(),
    db.prepare(`SELECT p.submission_id IS NOT NULL AS contribution, p.points, p.created_at,
      x.entry_id IS NOT NULL AS reversed FROM points_ledger p LEFT JOIN point_reversals x ON x.entry_id = p.id
      WHERE p.user_id = ? ORDER BY p.created_at DESC, p.id LIMIT 50`).bind(user).all(),
    db.prepare(`WITH RECURSIVE repair_lineage(id, root_id) AS (
        SELECT id, id FROM workflow_submissions WHERE user_id = ? AND workflow_type = 'repair_case' AND previous_revision_id IS NULL
        UNION ALL
        SELECT child.id, parent.root_id FROM workflow_submissions child
          JOIN repair_lineage parent ON child.previous_revision_id = parent.id
          WHERE child.user_id = ? AND child.workflow_type = 'repair_case'
      ) SELECT
      (SELECT count(*) FROM workflow_submissions WHERE user_id = ? AND workflow_type = 'repair_case') AS reports,
      (SELECT count(DISTINCT l.root_id) FROM repair_lineage l JOIN workflow_submissions reviewed ON reviewed.id = l.id
        WHERE reviewed.review_status = 'approved') AS peer_reviewed_repairs,
      (SELECT count(*) FROM review_assignments WHERE reviewer_id = ? AND status = 'completed') AS completed_reviews,
      (SELECT count(DISTINCT p.review_id) FROM points_ledger p LEFT JOIN point_reversals x ON x.entry_id = p.id
        WHERE p.user_id = ? AND p.review_id IS NOT NULL AND x.entry_id IS NULL) AS qualified_reviews,
      (SELECT count(*) FROM review_assignments WHERE reviewer_id = ? AND status = 'assigned') AS outstanding_reviews,
      (SELECT count(*) FROM workflow_submissions WHERE user_id = ? AND workflow_type = 'repair_case'
        AND assessment_override = 'needs_clarification'
        AND NOT EXISTS (SELECT 1 FROM workflow_submissions next WHERE next.previous_revision_id = workflow_submissions.id)
        AND NOT EXISTS (SELECT 1 FROM repair_drafts next WHERE next.previous_revision_id = workflow_submissions.id)) AS clarifications`)
      .bind(user, user, user, user, user, user, user).first<{
        reports: number; peer_reviewed_repairs: number; completed_reviews: number; qualified_reviews: number;
        outstanding_reviews: number; clarifications: number;
      }>(),
  ]);
  return { data: {
    points: total?.points ?? 0, history: history.results,
    reputation: { peer_reviewed_repairs: metrics?.peer_reviewed_repairs ?? 0 },
    metrics: { reports: metrics?.reports ?? 0, peer_reviewed_repairs: metrics?.peer_reviewed_repairs ?? 0,
      completed_reviews: metrics?.completed_reviews ?? 0,
      qualified_reviews: metrics?.qualified_reviews ?? 0,
      outstanding_reviews: metrics?.outstanding_reviews ?? 0, clarifications: metrics?.clarifications ?? 0 },
  } };
}

async function equipmentSuggestions(db: Database, url: URL, user: string | null): Promise<Result> {
  const kind = url.searchParams.get('kind');
  const query = url.searchParams.get('q') ?? '';
  const manufacturer = url.searchParams.get('manufacturer') ?? '';
  const category = url.searchParams.get('category');
  if ((kind !== 'manufacturer' && kind !== 'model') || query.length > 200 || manufacturer.length > 200 ||
      (category !== null && !categories.some(option => option.value === category))) return fail('formatError', 400);
  if (kind === 'model' && (!category || !manufacturer.trim())) return { data: { items: [] } };

  // Apply access rules in D1 before extracting any suggested values.
  const matchesCategory = kind === 'model' ? category : null;
  const columns = `json_extract(payload, '$.manufacturer') AS manufacturer, json_extract(payload, '$.model') AS model`;
  type Equipment = { manufacturer: string | null; model: string | null };
  const [community, ownHistory, drafts] = await Promise.all([
    db.prepare(`SELECT ${columns} FROM workflow_submissions s WHERE ${publicFilter}
      AND (? IS NULL OR s.equipment_category = ?) ORDER BY s.updated_at DESC, s.id DESC LIMIT 1000`)
      .bind(matchesCategory, matchesCategory).all<Equipment>(),
    user && db.prepare(`SELECT ${columns} FROM workflow_submissions
      WHERE user_id = ? AND workflow_type = 'repair_case' AND (? IS NULL OR equipment_category = ?)
      ORDER BY updated_at DESC, id DESC LIMIT 1000`).bind(user, matchesCategory, matchesCategory).all<Equipment>(),
    user && db.prepare(`SELECT ${columns} FROM repair_drafts WHERE user_id = ?
      AND (? IS NULL OR trim(json_extract(payload, '$.equipment_category')) = ?)
      ORDER BY updated_at DESC, id DESC LIMIT 1000`).bind(user, matchesCategory, matchesCategory).all<Equipment>(),
  ]);
  const searchKey = equipmentKey(query);
  const manufacturerKey = equipmentKey(manufacturer);
  const options = new Map<string, string>();
  for (const row of [
    ...community.results, ...(ownHistory ? ownHistory.results : []), ...(drafts ? drafts.results : []),
  ]) {
    if (kind === 'model' && (typeof row.manufacturer !== 'string' || equipmentKey(row.manufacturer) !== manufacturerKey)) continue;
    const value = row[kind];
    if (typeof value !== 'string' || !value.trim()) continue;
    const key = equipmentKey(value);
    if (key.includes(searchKey) && !options.has(key)) options.set(key, value.trim());
  }
  const entries = [...options].sort(([a], [b]) => Number(b.startsWith(searchKey)) - Number(a.startsWith(searchKey)) ||
    (a < b ? -1 : a > b ? 1 : 0));
  return { data: { items: entries.slice(0, 8).map(([, value]) => value) } };
}

export async function repairRoute(db: Database, url: URL, method: string, user: string | null,
  locale: Locale, input: Record<string, unknown> = {}): Promise<Result> {
  const path = url.pathname;
  if (method === 'GET' && path === '/api/v1/repair-equipment') return equipmentSuggestions(db, url, user);
  if (method === 'GET' && ['/api/v1/repairs', '/api/v1/me/submissions'].includes(path)) return repairLists(db, url, user);
  const community = /^\/api\/v1\/repairs\/([^/]+)$/.exec(path);
  if (method === 'GET' && community) {
    const row = await db.prepare(`SELECT ${repairColumns}, u.nickname AS author_nickname
      FROM workflow_submissions s JOIN users u ON u.id = s.user_id WHERE ${publicFilter} AND s.id = ?`)
      .bind(community[1]).first<Row>();
    if (!row) return fail('notFound', 404);
    delete row.previous_revision_id;
    return { data: serialize(row) };
  }
  if (method === 'GET' && path === '/api/v1/leaderboard') {
    const { results } = await db.prepare(`SELECT u.nickname, sum(p.points) AS points FROM points_ledger p
      JOIN users u ON u.id = p.user_id LEFT JOIN point_reversals x ON x.entry_id = p.id
      WHERE x.entry_id IS NULL GROUP BY u.id ORDER BY points DESC, u.nickname, u.id LIMIT 50`).all();
    return { data: { items: results } };
  }
  if (!user) return fail('needAccount', 401);
  if (method === 'GET' && path === '/api/v1/me/activity') return activity(db, user);
  if (method === 'GET' && path === '/api/v1/me/reviews') return assignments(db, user, url);
  if (method === 'POST' && path === '/api/v1/me/reviews/refresh') {
    const { results } = await db.prepare(`SELECT t.id FROM workflow_review_plan t
      JOIN user_expertise e ON e.category_id = t.equipment_category AND e.user_id = ?
      WHERE t.user_id IS NOT e.user_id
       AND NOT EXISTS (SELECT 1 FROM review_assignments a WHERE a.submission_id = t.id AND a.reviewer_id = e.user_id)
       AND (SELECT count(*) FROM user_expertise eligible WHERE eligible.category_id = t.equipment_category
         AND eligible.user_id IS NOT t.user_id AND NOT EXISTS (
           SELECT 1 FROM review_assignments prior WHERE prior.submission_id = t.id AND prior.reviewer_id = eligible.user_id
         )) >= t.needed
      ORDER BY t.id LIMIT 20`).bind(user).all<{ id: string }>();
    if (results.length) await db.batch(results.flatMap(row => allocation(db, row.id)));
    return { data: { refreshed: true } };
  }
  const assignment = /^\/api\/v1\/me\/reviews\/([0-9a-f]{32})$/.exec(path);
  if (method === 'POST' && assignment) return review(db, user, assignment[1], input);
  const item = /^\/api\/v1\/me\/submissions\/([^/]+)(\/submit|\/revision)?$/.exec(path);
  if (!item || !idPattern.test(item[1])) return fail('notFound', 404);
  if (method === 'PUT' && !item[2]) return saveDraft(db, user, item[1], input, locale);
  if (method === 'POST' && item[2] === '/submit') return submit(db, user, item[1], locale);
  if (method === 'POST' && item[2] === '/revision') return startRevision(db, user, item[1]);
  if (method === 'GET' && !item[2]) return ownerDetail(db, user, item[1]);
  return fail('notFound', 404);
}
