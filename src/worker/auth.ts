import type { Account, Database } from './db';

const iterations = 600_000;
const stageIterations = 100_000;
const currentScheme = 'pbkdf2-sha256-chain-v1';
const lifetime = 60 * 60 * 24 * 7;
const cookieName = '__Host-ekn_session';
const encoder = new TextEncoder();
const dummySalt = '00000000000000000000000000000000';

const hex = (bytes: Uint8Array) => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('');
const random = (length: number) => hex(crypto.getRandomValues(new Uint8Array(length)));
const now = () => Math.floor(Date.now() / 1000);

async function digest(value: string) {
  return hex(new Uint8Array(await crypto.subtle.digest('SHA-256', encoder.encode(value))));
}

async function derive(password: string, salt: string, count: number, scheme = 'pbkdf2-sha256') {
  const saltBytes = Uint8Array.from(salt.match(/../g) ?? [], pair => Number.parseInt(pair, 16));
  if (scheme === 'pbkdf2-sha256') {
    const key = await crypto.subtle.importKey('raw', encoder.encode(password), 'PBKDF2', false, ['deriveBits']);
    return hex(new Uint8Array(await crypto.subtle.deriveBits({
      name: 'PBKDF2', hash: 'SHA-256', iterations: count, salt: saltBytes,
    }, key, 256)));
  }
  if (scheme !== currentScheme) throw new Error('Unsupported password scheme');
  let input = encoder.encode(password);
  let completed = 0;
  let stage = 0;
  while (completed < count) {
    const rounds = Math.min(stageIterations, count - completed);
    const context = encoder.encode('EKN-PBKDF2-chain-v1:' + stage);
    const stagedSalt = new Uint8Array(saltBytes.length + context.length);
    stagedSalt.set(saltBytes);
    stagedSalt.set(context, saltBytes.length);
    const key = await crypto.subtle.importKey('raw', input, 'PBKDF2', false, ['deriveBits']);
    input = new Uint8Array(await crypto.subtle.deriveBits({
      name: 'PBKDF2', hash: 'SHA-256', iterations: rounds, salt: stagedSalt,
    }, key, 256));
    completed += rounds;
    stage++;
  }
  return hex(input);
}

function equalHash(a: string, b: string) {
  let mismatch = a.length ^ b.length;
  for (let index = 0; index < a.length; index++) mismatch |= a.charCodeAt(index) ^ b.charCodeAt(index);
  return mismatch === 0;
}

export async function register(db: Database, email: string, password: string, nickname: string) {
  const id = crypto.randomUUID();
  const salt = random(16);
  const hash = await derive(password, salt, iterations, currentScheme);
  return db.prepare(`
    INSERT INTO users (id, email, nickname, password_salt, password_hash, password_iterations, password_scheme)
    VALUES (?, ?, ?, ?, ?, ?, ?) ON CONFLICT(email) DO NOTHING RETURNING id, nickname, role
  `).bind(id, email, nickname, salt, hash, iterations, currentScheme).first<Account>();
}

type Verifier = Account & { role: 'member' | 'admin'; password_salt: string; password_hash: string; password_iterations: number;
  password_scheme: string };

export async function authenticate(db: Database, email: string, password: string): Promise<Account | null> {
  const row = await db.prepare(
    'SELECT id, nickname, role, password_salt, password_hash, password_iterations, password_scheme FROM users WHERE email = ?'
  ).bind(email).first<Verifier>();
  const candidate = await derive(password, row?.password_salt ?? dummySalt, row?.password_iterations ?? iterations,
    row?.password_scheme ?? currentScheme);
  return row && equalHash(candidate, row.password_hash) ? { id: row.id, nickname: row.nickname, role: row.role } : null;
}

export async function verifyAccountPassword(db: Database, id: string, password: string) {
  const row = await db.prepare(
    'SELECT password_salt, password_hash, password_iterations, password_scheme FROM users WHERE id = ?'
  ).bind(id).first<{ password_salt: string; password_hash: string; password_iterations: number; password_scheme: string }>();
  const candidate = await derive(password, row?.password_salt ?? dummySalt, row?.password_iterations ?? iterations,
    row?.password_scheme ?? currentScheme);
  return Boolean(row && equalHash(candidate, row.password_hash));
}

function cookie(value: string, age: number) {
  return `${cookieName}=${value}; Path=/; Max-Age=${age}; HttpOnly; Secure; SameSite=Lax`;
}

async function requestTokenHash(request: Request) {
  const prefix = cookieName + '=';
  const value = request.headers.get('Cookie')?.split(';').map(part => part.trim())
    .find(part => part.startsWith(prefix))?.slice(prefix.length);
  return value && /^[a-f0-9]{64}$/.test(value) ? digest(value) : null;
}

export async function createSession(db: Database, request: Request, account: Account) {
  const token = random(32);
  const oldHash = await requestTokenHash(request);
  const timestamp = now();
  await db.batch([
    db.prepare('DELETE FROM sessions WHERE expires_at <= ? OR token_hash = ?').bind(timestamp, oldHash),
    db.prepare('INSERT INTO sessions (token_hash, user_id, expires_at) VALUES (?, ?, ?)')
      .bind(await digest(token), account.id, timestamp + lifetime),
  ]);
  return cookie(token, lifetime);
}

export async function sessionAccount(db: Database, request: Request) {
  const hash = await requestTokenHash(request);
  if (!hash) return null;
  return db.prepare(`
    SELECT users.id, users.nickname, users.role FROM sessions JOIN users ON sessions.user_id = users.id
    WHERE sessions.token_hash = ? AND sessions.expires_at > ?
  `).bind(hash, now()).first<Account>();
}

export async function logout(db: Database, request: Request) {
  const hash = await requestTokenHash(request);
  if (hash) await db.prepare('DELETE FROM sessions WHERE token_hash = ?').bind(hash).run();
  return cookie('', 0);
}

export async function rateAllowed(db: Database, action: string, ip: string) {
  const windowStart = Math.floor(now() / 600) * 600;
  const key = await digest(action + ':' + ip);
  await db.prepare('DELETE FROM auth_limits WHERE window_start < ?').bind(windowStart).run();
  const result = await db.prepare(`
    INSERT INTO auth_limits (rate_key, window_start, attempts) VALUES (?, ?, 1)
    ON CONFLICT(rate_key) DO UPDATE SET
      attempts = CASE WHEN window_start = excluded.window_start THEN min(attempts + 1, 21) ELSE 1 END,
      window_start = excluded.window_start
    RETURNING attempts
  `).bind(key, windowStart).first<{ attempts: number }>();
  return (result?.attempts ?? Infinity) <= (action === 'register' ? 10 : 20);
}
