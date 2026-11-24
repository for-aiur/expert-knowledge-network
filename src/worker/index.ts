import { taskRoute } from './tasks';
import { adminRoute } from './admin';
import { repairRoute } from './repair';
import { isLocale, type Locale, type Message } from '../i18n/messages';
import { expertiseValues, isRecord, validateFields, workflowFor } from '../workflows';
import { authenticate, createSession, logout, rateAllowed, register, sessionAccount } from './auth';
import { profile, setExpertise, type Database } from './db';
import { allocation } from './review-allocation';
import { verifyAccountPassword } from './auth';

interface Env {
  DB: Database;
  ASSETS: { fetch(request: Request): Promise<Response> };
  BETA_INVITE_CODE?: string;
}

function json(data: unknown, status = 200, headers: Record<string, string> = {}) {
  return Response.json(data, {
    status,
    headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...headers },
  });
}

const error = (code: Message, status: number) => json({ code }, status);

async function readJson(request: Request, maxBytes = 128_000) {
  const reader = request.body?.getReader();
  if (!reader) return null;
  const decoder = new TextDecoder();
  let length = 0;
  let body = '';
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return JSON.parse(body + decoder.decode()) as unknown;
      length += value.byteLength;
      if (length > maxBytes) {
        await reader.cancel();
        return null;
      }
      body += decoder.decode(value, { stream: true });
    }
  } catch {
    return null;
  }
}

async function api(request: Request, env: Env, url: URL) {
  const { method } = request;
  const path = url.pathname;
  if (path === '/api/v1/tasks' || path.startsWith('/api/v1/tasks/')) {
    const result = await taskRoute(env.DB, request, path, readJson);
    return json(result.data, result.status, result.headers);
  }
  if (method === 'GET' && path === '/api/health') {
    await env.DB.prepare('SELECT id FROM users LIMIT 1').first();
    return json({ status: 'ok', database: 'ok' });
  }
  if (method === 'GET' && path === '/api/session') {
    const account = await sessionAccount(env.DB, request);
    return json({ user: account ? await profile(env.DB, account) : null });
  }
  const versioned = path.startsWith('/api/v1/');
  if (path.startsWith('/api/v1/admin/')) {
    const account = await sessionAccount(env.DB, request);
    if (!account || account.role !== 'admin') return error('adminForbidden', account ? 403 : 401);
    if (method !== 'GET') return error('notFound', 404);
    const result = await adminRoute(env.DB, url);
    if (typeof result.data === 'string' && result.headers?.['Content-Type']?.startsWith('text/csv')) {
      return new Response(result.data, { status: result.status,
        headers: { 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', ...result.headers } });
    }
    return json(result.data, result.status, result.headers);
  }
  const requestedLanguage = request.headers.get('X-EKN-Language');
  const locale: Locale = isLocale(requestedLanguage) ? requestedLanguage : 'en';
  if (versioned && method === 'GET') {
    const result = await repairRoute(env.DB, url, method, (await sessionAccount(env.DB, request))?.id ?? null, locale);
    return json(result.data, result.status);
  }
  if (method !== 'POST' && method !== 'PUT') return error('notFound', 404);
  if (request.headers.get('Origin') !== url.origin || request.headers.get('Sec-Fetch-Site') === 'cross-site') {
    return error('originError', 403);
  }
  if (method === 'POST' && path === '/api/logout') {
    return json({ user: null }, 200, { 'Set-Cookie': await logout(env.DB, request) });
  }
  if (request.headers.get('Content-Type')?.split(';')[0].trim().toLowerCase() !== 'application/json') {
    return error('formatError', 415);
  }
  const input = await readJson(request);
  if (!isRecord(input)) return error('formatError', 400);
  if (versioned) {
    const result = await repairRoute(env.DB, url, method, (await sessionAccount(env.DB, request))?.id ?? null, locale, input);
    return json(result.data, result.status);
  }

  if (method === 'POST' && (path === '/api/register' || path === '/api/login')) {
    const signingUp = path === '/api/register';
    const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
    const password = typeof input.password === 'string' ? input.password : '';
    const nickname = typeof input.nickname === 'string' ? input.nickname.trim() : '';
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254 ||
        password.length < (signingUp ? 12 : 1) || password.length > 128 ||
        (signingUp && (!nickname || nickname.length > 40 || /[\u0000-\u001f]/.test(nickname)))) {
      return error('credentials', 400);
    }
    if (signingUp && (!env.BETA_INVITE_CODE || typeof input.invite_code !== 'string' ||
        input.invite_code.length > 128 || input.invite_code !== env.BETA_INVITE_CODE)) {
      return error('betaInviteRequired', 403);
    }
    if (signingUp && input.privacy_consent !== true) return error('privacyConsentRequired', 400);
    if (!await rateAllowed(env.DB, signingUp ? 'register' : 'login', request.headers.get('CF-Connecting-IP') ?? 'local')) {
      return json({ code: 'limited' }, 429, { 'Retry-After': '600' });
    }
    const account = signingUp
      ? await register(env.DB, email, password, nickname)
      : await authenticate(env.DB, email, password);
    if (!account) return error(signingUp ? 'registerError' : 'loginError',
      signingUp ? 409 : 401);
    return json({ user: await profile(env.DB, account) }, signingUp ? 201 : 200,
      { 'Set-Cookie': await createSession(env.DB, request, account) });
  }

  if (method === 'PUT' && path === '/api/profile/expertise') {
    const account = await sessionAccount(env.DB, request);
    if (!account) return error('signInEdit', 401);
    const ids = expertiseValues(input.expertise);
    if (Object.keys(input).length !== 1 || ids === null) return error('categoryError', 400);
    await setExpertise(env.DB, account, ids);
    return json({ user: await profile(env.DB, account) });
  }

  if (method === 'POST' && path === '/api/account/delete') {
    const account = await sessionAccount(env.DB, request);
    if (!account) return error('signInEdit', 401);
    if (typeof input.password !== 'string' || !await verifyAccountPassword(env.DB, account.id, input.password)) {
      return error('deleteError', 403);
    }
    const affected = await env.DB.prepare(`SELECT DISTINCT a.submission_id AS id FROM review_assignments a
      JOIN workflow_submissions s ON s.id = a.submission_id
      WHERE a.reviewer_id = ? AND s.user_id IS NOT ?`).bind(account.id, account.id).all<{ id: string }>();
    const batch = [
      env.DB.prepare(`DELETE FROM point_reversals WHERE entry_id IN (SELECT id FROM points_ledger WHERE user_id = ?
        OR review_id IN (SELECT r.id FROM reviews r JOIN review_assignments a ON a.id = r.assignment_id
          WHERE a.reviewer_id = ? OR a.submission_id IN (SELECT id FROM workflow_submissions WHERE user_id = ?)))`)
        .bind(account.id, account.id, account.id),
      env.DB.prepare(`DELETE FROM points_ledger WHERE user_id = ? OR submission_id IN
        (SELECT id FROM workflow_submissions WHERE user_id = ?) OR review_id IN
        (SELECT r.id FROM reviews r JOIN review_assignments a ON a.id = r.assignment_id
          WHERE a.reviewer_id = ? OR a.submission_id IN (SELECT id FROM workflow_submissions WHERE user_id = ?))`)
        .bind(account.id, account.id, account.id, account.id),
      env.DB.prepare(`DELETE FROM reviews WHERE assignment_id IN (SELECT id FROM review_assignments
        WHERE reviewer_id = ? OR submission_id IN (SELECT id FROM workflow_submissions WHERE user_id = ?))`)
        .bind(account.id, account.id),
      env.DB.prepare(`DELETE FROM review_assignments WHERE reviewer_id = ? OR submission_id IN
        (SELECT id FROM workflow_submissions WHERE user_id = ?)`).bind(account.id, account.id),
      env.DB.prepare('DELETE FROM repair_drafts WHERE user_id = ?').bind(account.id),
      env.DB.prepare('DELETE FROM workflow_submissions WHERE user_id = ?').bind(account.id),
      ...affected.results.map(row => env.DB.prepare(`UPDATE workflow_submissions SET review_status = 'pending',
        assessment_override = NULL, updated_at = unixepoch() WHERE id = ?`).bind(row.id)),
      env.DB.prepare('DELETE FROM sessions WHERE user_id = ?').bind(account.id),
      env.DB.prepare('DELETE FROM user_expertise WHERE user_id = ?').bind(account.id),
      env.DB.prepare('DELETE FROM users WHERE id = ?').bind(account.id),
      ...affected.results.flatMap(row => allocation(env.DB, row.id)),
    ];
    await env.DB.batch(batch);
    return json({ deleted: true }, 200, { 'Set-Cookie': '__Host-ekn_session=; Path=/; Max-Age=0; HttpOnly; Secure; SameSite=Lax' });
  }

  const match = /^\/api\/workflows\/([a-z_]+)\/(\d+)\/validate$/.exec(path);
  if (method === 'POST' && match) {
    if (!await sessionAccount(env.DB, request)) return error('signInCheck', 401);
    const workflow = workflowFor(match[1], Number(match[2]));
    if (!workflow) return error('formMissing', 404);
    const requestedLocale = request.headers.get('X-EKN-Language');
    const locale: Locale = isLocale(requestedLocale) ? requestedLocale : 'en';
    const { errors } = validateFields(workflow, input, locale);
    const valid = Object.keys(errors).length === 0;
    return json({ valid, errors, schema_version: workflow.version }, valid ? 200 : 422);
  }
  return error('notFound', 404);
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname !== '/api' && !url.pathname.startsWith('/api/')) return env.ASSETS.fetch(request);
    try {
      return await api(request, env, url);
    } catch (cause) {
      console.error('Worker request failed', url.pathname, cause instanceof Error ? cause.message : 'unknown error');
      return error('failure', 500);
    }
  },
};
