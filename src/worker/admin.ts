import { categories } from '../workflows';
import type { Database } from './db';

type Result = { data: unknown; status: number; headers?: Record<string, string> };
const fail = (code: string, status: number): Result => ({ data: { code }, status });
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const states = ['draft', 'pending', 'in_review', 'approved', 'peer_reviewed', 'disputed', 'rejected', 'needs_clarification', 'queued', 'completed', 'cancelled'];
const contact = /[\w.+-]+@[\w.-]+\.[a-z]{2,}|https?:\/\/[^\s]+|\bekn_[a-f0-9]{32,}\b/gi;

function safeText(value: unknown) {
  return typeof value === 'string' ? value.replace(contact, '[redacted]') : value;
}

function safePayload(raw: string) {
  const values = JSON.parse(raw) as Record<string, unknown>;
  return Object.fromEntries(Object.entries(values).map(([key, value]) => [key, safeText(value)]));
}

function filters(url: URL) {
  const type = url.searchParams.get('type');
  const status = url.searchParams.get('status');
  const category = url.searchParams.get('category');
  const from = url.searchParams.get('from');
  const to = url.searchParams.get('to');
  const limitText = url.searchParams.get('limit') ?? '20';
  const offsetText = url.searchParams.get('offset') ?? '0';
  if ((type && !['repair_case', 'diagnosis_review'].includes(type)) ||
      (status && !states.includes(status)) ||
      (category && !categories.some(item => item.value === category)) ||
      (from && !/^\d{4}-\d{2}-\d{2}$/.test(from)) ||
      (to && !/^\d{4}-\d{2}-\d{2}$/.test(to)) ||
      !/^\d{1,6}$/.test(limitText) || +limitText < 1 || +limitText > 50 ||
      !/^\d{1,7}$/.test(offsetText)) return null;
  const clauses: string[] = [];
  const values: (string | number)[] = [];
  if (type) { clauses.push('s.workflow_type = ?'); values.push(type); }
  if (status) {
    const normalizedStatus = status === 'peer_reviewed' ? 'approved' : status;
    clauses.push(type === 'diagnosis_review' ? 'x.status = ?' : type === 'repair_case' ? 's.review_status = ?' :
      "((s.workflow_type = 'repair_case' AND s.review_status = ?) OR (s.workflow_type = 'diagnosis_review' AND x.status = ?))");
    if (!type && normalizedStatus === 'pending') values.push('pending', 'queued');
    else if (!type && status === 'peer_reviewed') values.push('approved', 'completed');
    else values.push(normalizedStatus);
  }
  if (category) { clauses.push('s.equipment_category = ?'); values.push(category); }
  if (from) { clauses.push('s.created_at >= ?'); values.push(Math.floor(Date.parse(from + 'T00:00:00Z') / 1000)); }
  if (to) { clauses.push('s.created_at < ?'); values.push(Math.floor(Date.parse(to + 'T00:00:00Z') / 1000) + 86400); }
  return { where: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', values, limit: +limitText, offset: +offsetText };
}

const baseQuery = `FROM workflow_submissions s LEFT JOIN external_tasks x ON x.submission_id = s.id
  LEFT JOIN workflow_review_round t ON t.id = s.id`;

async function overview(db: Database) {
  const row = await db.prepare(`SELECT
    (SELECT count(*) FROM workflow_submissions WHERE workflow_type = 'repair_case') AS repair_count,
    (SELECT count(*) FROM external_tasks WHERE status <> 'cancelled') AS diagnosis_count,
    (SELECT count(*) FROM workflow_submissions WHERE workflow_type = 'repair_case' AND review_status = 'approved') AS peer_reviewed_count,
    (SELECT count(*) FROM workflow_submissions WHERE workflow_type = 'repair_case' AND review_status IN ('pending','in_review','disputed')) AS open_repair_count,
    (SELECT count(*) FROM external_tasks WHERE status IN ('queued','in_review')) AS open_diagnosis_count`).first<Record<string, number>>();
  return { data: row ?? {} };
}

async function list(db: Database, url: URL): Promise<Result> {
  const filter = filters(url);
  if (!filter) return fail('formatError', 400);
  const rows = await db.prepare(`SELECT s.id, s.workflow_type, s.schema_version, s.equipment_category,
      s.source_type, s.review_status, coalesce(x.status, s.review_status) AS task_status,
      s.sharing_permission, s.content_language, s.created_at, s.updated_at, s.payload,
      coalesce(t.assigned,0) AS assigned, coalesce(t.completed,0) AS completed
    ${baseQuery} ${filter.where} ORDER BY s.created_at DESC, s.id DESC LIMIT ? OFFSET ?`)
    .bind(...filter.values, filter.limit + 1, filter.offset).all<Record<string, unknown>>();
  const items = rows.results.slice(0, filter.limit).map(row => {
    const { payload, ...safe } = row;
    const values = safePayload(payload as string);
    return { ...safe, status: row.workflow_type === 'diagnosis_review' ? row.task_status : row.review_status === 'approved' ? 'peer_reviewed' : row.review_status,
      summary: Object.fromEntries(['equipment_category','manufacturer','model','fault_code','outcome','proposed_diagnosis'].flatMap(key =>
        values[key] === undefined ? [] : [[key, values[key]]])) };
  });
  const count = await db.prepare(`SELECT count(*) AS total ${baseQuery} ${filter.where}`)
    .bind(...filter.values).first<{ total: number }>();
  return { data: { items, total: count?.total ?? 0, next_offset: rows.results.length > filter.limit ? filter.offset + filter.limit : null }, status: 200 };
}

async function detail(db: Database, id: string): Promise<Result> {
  const row = await db.prepare(`SELECT s.id, s.workflow_type, s.schema_version, s.equipment_category,
      s.source_type, s.review_status, s.assessment_override, s.sharing_permission, s.review_consented_at,
      s.content_language, s.created_at, s.updated_at, s.payload, x.status AS task_status,
      coalesce(t.assigned,0) AS assigned, coalesce(t.completed,0) AS completed
    ${baseQuery} WHERE s.id = ?`).bind(id).first<Record<string, unknown>>();
  if (!row) return fail('notFound', 404);
  const { results: reviews } = await db.prepare(`SELECT r.overall_assessment, r.rubric_version, r.answers,
      r.created_at, u.nickname AS reviewer, a.purpose
    FROM review_assignments a LEFT JOIN reviews r ON r.assignment_id = a.id
    JOIN users u ON u.id = a.reviewer_id WHERE a.submission_id = ?
    ORDER BY a.created_at, a.id`).bind(id).all<{ overall_assessment: string | null; rubric_version: number | null;
      answers: string | null; created_at: number; reviewer: string; purpose: string }>();
  const values = safePayload(row.payload as string);
  const feedback = reviews.map(review => ({ ...review, answers: review.answers ? safePayload(review.answers) : null }));
  return { data: { ...row, status: row.workflow_type === 'diagnosis_review' ? row.task_status : row.review_status === 'approved' ? 'peer_reviewed' : row.review_status,
    payload: values, reviews: feedback,
    permissions: { review_consent: Boolean(row.review_consented_at), community_sharing: row.sharing_permission === 'community' } }, status: 200 };
}

async function exportRecords(db: Database, url: URL): Promise<Result> {
  const format = url.searchParams.get('format') ?? 'json';
  const scope = url.searchParams.get('scope') ?? 'community';
  if (!['json', 'csv'].includes(format) || !['community', 'internal'].includes(scope)) return fail('formatError', 400);
  const filter = filters(new URL(url));
  if (!filter) return fail('formatError', 400);
  const internal = scope === 'internal';
  const extra = internal ? "s.workflow_type = 'repair_case'" :
    "s.workflow_type = 'repair_case' AND s.review_status = 'approved' AND s.sharing_permission = 'community' AND s.review_consented_at IS NOT NULL";
  const where = filter.where ? filter.where + ' AND ' + extra : 'WHERE ' + extra;
  const rows = await db.prepare(`SELECT s.id, s.workflow_type, s.schema_version, s.equipment_category,
      s.source_type, s.review_status, s.sharing_permission, s.content_language, s.created_at,
      s.payload, coalesce(t.completed,0) AS review_count
    ${baseQuery} ${where} ORDER BY s.created_at DESC, s.id DESC LIMIT 5000`)
    .bind(...filter.values).all<Record<string, unknown>>();
  const records = rows.results.map(row => ({
    id: row.id, workflow_type: row.workflow_type, schema_version: row.schema_version,
    content_language: row.content_language, equipment_category: row.equipment_category,
    source_type: row.source_type, status: row.review_status === 'approved' ? 'peer_reviewed' : row.review_status,
    sharing_permission: row.sharing_permission, review_count: row.review_count, created_at: row.created_at,
    values: safePayload(row.payload as string),
  }));
  if (format === 'json') return { data: { scope, count: records.length, records }, status: 200,
    headers: { 'Content-Disposition': 'attachment; filename="ekn-repairs.json"' } };
  const columns = ['id','workflow_type','schema_version','content_language','equipment_category','manufacturer','model',
    'fault_code','symptoms','diagnostic_steps','root_cause','resolution','outcome','source_type','status',
    'sharing_permission','review_count','created_at'];
  const quote = (value: unknown) => {
    let text = value === undefined || value === null ? '' : typeof value === 'string' ? value : JSON.stringify(value);
    text = text.replace(contact, '[redacted]');
    if (/^[\s\u0000-\u001f]*[=+@\-]/.test(text)) text = "'" + text;
    return '"' + text.replaceAll('"','""') + '"';
  };
  const csv = [columns.join(','), ...records.map(record => {
    const flat = { ...record, ...record.values };
    return columns.map(key => quote(flat[key as keyof typeof flat])).join(',');
  })].join('\r\n');
  return { data: csv, status: 200, headers: { 'Content-Type': 'text/csv; charset=utf-8', 'Content-Disposition': 'attachment; filename="ekn-repairs.csv"' } };
}

export async function adminRoute(db: Database, url: URL): Promise<Result> {
  const path = url.pathname;
  if (path === '/api/v1/admin/overview' && url.search === '') return { ...await overview(db), status: 200 };
  if (path === '/api/v1/admin/submissions' && url.searchParams.get('detail')) {
    const id = url.searchParams.get('detail')!;
    return uuid.test(id) ? detail(db, id) : fail('formatError', 400);
  }
  const detailMatch = /^\/api\/v1\/admin\/submissions\/([a-f0-9-]+)$/i.exec(path);
  if (detailMatch) return uuid.test(detailMatch[1]) ? detail(db, detailMatch[1]) : fail('formatError', 400);
  if (path === '/api/v1/admin/submissions') return list(db, url);
  if (path === '/api/v1/admin/export') return exportRecords(db, url);
  return fail('notFound', 404);
}
