import { createHash, randomBytes } from 'node:crypto';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { after, before, test } from 'node:test';

const port = process.env.EKN_TEST_PORT ?? '18787';
const base = 'http://localhost:' + port;
const cli = 'node_modules/wrangler/bin/wrangler.js';
const configuration = JSON.parse(await readFile(new URL('../src/generated/workflows.json', import.meta.url)));
let directory;
let worker;
let workerOutput = '';

function wrangler(args) {
  const command = spawn(process.execPath, [cli, ...args], {
    env: { ...process.env, WRANGLER_LOG_PATH: join(directory, 'wrangler.log') },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return command;
}

async function executeD1(command) {
  const process = wrangler(['d1', 'execute', 'DB', '--local', '--persist-to', directory, '--command', command]);
  let output = '';
  for (const stream of [process.stdout, process.stderr]) stream.on('data', data => { output += data; });
  const code = await new Promise(resolve => process.on('close', resolve));
  assert.equal(code, 0, output);
  return output;
}

before(async () => {
  directory = await mkdtemp(join(tmpdir(), 'ekn-tests-'));
  const migrate = wrangler(['d1', 'migrations', 'apply', 'DB', '--local', '--persist-to', directory]);
  let migrationOutput = '';
  for (const stream of [migrate.stdout, migrate.stderr]) stream.on('data', data => { migrationOutput += data; });
  const code = await new Promise((resolve, reject) => {
    migrate.on('error', reject);
    migrate.on('close', resolve);
  });
  assert.equal(code, 0, migrationOutput);
  worker = wrangler(['dev', '--local', '--ip', '127.0.0.1', '--port', port, '--persist-to', directory,
    '--var', 'BETA_INVITE_CODE:local-test-invite']);
  for (const stream of [worker.stdout, worker.stderr]) stream.on('data', data => { workerOutput += data; });
  for (let count = 0; count < 80; count++) {
    if (worker.exitCode !== null) break;
    try {
      const health = await fetch(base + '/api/health', { signal: AbortSignal.timeout(500) });
      if (health.ok && (await health.json()).database === 'ok') return;
    } catch {
      // Wrangler is still starting.
    }
    await new Promise(resolve => setTimeout(resolve, 250));
  }
  assert.fail('Worker did not become healthy:\n' + workerOutput);
});

after(async () => {
  if (worker && worker.exitCode === null) {
    const stopped = new Promise(resolve => worker.once('close', resolve));
    worker.kill();
    await stopped;
  }
  if (directory) await rm(directory, { recursive: true, force: true });
});

async function call(path, { body, method = body ? 'POST' : 'GET', cookie, origin = base, locale, headers: extra = {},
  signup = true } = {}) {
  const headers = { Origin: origin, ...extra };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (locale) headers['X-EKN-Language'] = locale;
  const requestBody = path === '/register' && signup && body ? { ...body, invite_code: 'local-test-invite', privacy_consent: true } : body;
  const response = await fetch(base + '/api' + path, { method, headers, body: JSON.stringify(requestBody) });
  return { status: response.status, data: await response.json(), cookie: response.headers.get('Set-Cookie') };
}

const alice = { email: 'alice@example.invalid', password: 'synthetic-password-1', nickname: 'Workshop Alpha' };
const bob = { email: 'bob@example.invalid', password: 'synthetic-password-2', nickname: 'Workshop Beta' };
const token = response => response.cookie.split(';')[0];

test('D1 migration and health endpoint work, and assets serve the application', async () => {
  assert.deepEqual((await call('/health')).data, { status: 'ok', database: 'ok' });
  const page = await fetch(base + '/profile', { headers: { Accept: 'text/html', 'Sec-Fetch-Mode': 'navigate' } });
  assert.equal(page.status, 200);
  assert.match(await page.text(), /Expert Knowledge Network/);
});

test('registration, login, session refresh, logout and profile authorization', async () => {
  assert.equal((await call('/register', { body: { ...alice, invite_code: 'wrong', privacy_consent: true }, signup: false })).status, 403);
  assert.equal((await call('/register', { body: { ...alice, invite_code: 'local-test-invite' }, signup: false })).status, 400);
  assert.equal((await call('/register', { body: { ...alice, password: 'short' } })).status, 400);
  const first = await call('/register', { body: alice });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.match(first.cookie, /^__Host-ekn_session=[a-f0-9]{64}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
  const second = await call('/register', { body: bob });
  assert.equal(second.status, 201);
  assert.notEqual(first.data.user.id, second.data.user.id);
  assert.deepEqual(Object.keys(first.data.user).sort(), ['expertise', 'id', 'is_admin', 'nickname']);
  assert.equal((await call('/register', { body: alice })).status, 409);
  assert.equal((await call('/login', { body: { ...alice, password: 'wrong' } })).status, 401);
  const cookie = token(first);
  const edit = expertise => call('/profile/expertise', { method: 'PUT', body: { expertise }, cookie });
  assert.equal((await call('/profile/expertise', { method: 'PUT', body: { expertise: [] } })).status, 401);
  assert.equal((await call('/profile/expertise', { method: 'PUT', body: { expertise: [] }, cookie,
    origin: 'https://other.example' })).status, 403);
  assert.equal((await edit(['invalid'])).status, 400);
  assert.equal((await edit(['hvac', 'hvac'])).status, 400);
  assert.deepEqual((await edit(['hvac', 'plumbing'])).data.user.expertise, ['hvac', 'plumbing']);
  assert.equal((await call('/profile/expertise', { method: 'PUT', cookie: token(second),
    body: { expertise: [], userId: first.data.user.id } })).status, 400);
  assert.deepEqual((await call('/session', { cookie: token(second) })).data.user.expertise, []);
  assert.deepEqual((await call('/session', { cookie })).data.user.expertise, ['hvac', 'plumbing']);

  const login = await call('/login', { body: alice, cookie });
  assert.equal(login.status, 200);
  assert.equal(login.data.user.id, first.data.user.id);
  assert.deepEqual((await call('/session', { cookie })).data, { user: null });
  const loggedIn = token(login);
  assert.deepEqual((await call('/session', { cookie: loggedIn })).data.user.expertise, ['hvac', 'plumbing']);
  assert.deepEqual((await call('/profile/expertise', { method: 'PUT', cookie: loggedIn,
    body: { expertise: [] } })).data.user.expertise, []);
  assert.equal((await call('/logout', { method: 'POST', cookie: loggedIn })).status, 200);
  assert.deepEqual((await call('/session', { cookie: loggedIn })).data, { user: null });
});

test('YAML generates both forms and the server enforces conditional fields and select values', async () => {
  const repair = configuration.workflows.find(workflow => workflow.type === 'repair_case');
  assert.deepEqual(repair.fields.find(field => field.name === 'equipment_category').options, configuration.categories);
  const login = await call('/login', { body: bob });
  const cookie = token(login);
  const values = {
    equipment_category: 'hvac', symptoms: 'Synthetic example', outcome: 'unresolved',
    source_type: 'firsthand', sharing_permission: 'private',
  };
  const path = '/workflows/repair_case/1/validate';
  const validate = body => call(path, { cookie, body });
  assert.equal((await call(path, { body: values })).status, 401);
  assert.deepEqual((await validate(values)).data, { valid: true, errors: {}, schema_version: 1 });
  for (const outcome of ['resolved', 'partially_resolved']) {
    const invalid = await validate({ ...values, outcome, resolution: '   ' });
    assert.equal(invalid.status, 422);
    assert.equal(invalid.data.errors.resolution, 'This field is required.');
    assert.equal((await validate({ ...values, outcome, resolution: 'Synthetic repair' })).status, 200);
  }
  for (const locale of ['en', 'de', 'tr', 'pl', 'ru', 'ar', 'unsupported']) {
    const result = await call(path, { cookie, locale, body: { ...values, outcome: 'resolved' } });
    assert.equal(result.data.errors.resolution, configuration.validation.required[locale] ?? configuration.validation.required.en);
  }
  assert.equal((await validate({ ...values, review_status: 'approved' })).status, 422);
  assert.equal((await validate({ ...values, equipment_category: 'unknown' })).status, 422);
  assert.equal((await validate({ ...values, source_type: 123 })).status, 422);
  assert.equal((await validate({ ...values, sharing_permission: '' })).status, 422);
  assert.equal((await call('/workflows/repair_case/2/validate', { cookie, body: values })).status, 404);
  assert.equal((await call('/workflows/diagnosis_review/1/validate', { cookie, body: {
    equipment_category: 'hvac', symptoms: 'Synthetic symptom', proposed_diagnosis: 'Synthetic hypothesis',
  } })).status, 200);
});

test('sign-in attempts are rate limited', async () => {
  for (let attempt = 0; attempt < 22; attempt++) {
    const result = await call('/login', { body: { ...bob, password: 'incorrect' } });
    if (result.status === 429) return;
    assert.equal(result.status, 401);
  }
  assert.fail('No rate limit was applied.');
});


test('all six message dictionaries and YAML resources contain complete translations', async () => {
  const locales = ['en', 'de', 'tr', 'pl', 'ru', 'ar'];
  const dictionaries = await Promise.all(locales.map(async locale =>
    JSON.parse(await readFile(new URL('../src/i18n/' + locale + '.json', import.meta.url)))));
  for (const dictionary of dictionaries) {
    assert.deepEqual(Object.keys(dictionary).sort(), Object.keys(dictionaries[0]).sort());
    assert.ok(Object.values(dictionary).every(message => typeof message === 'string' && message.trim()));
  }
  const localized = [
    ...configuration.categories.map(category => category.label),
    ...Object.values(configuration.validation),
    ...configuration.rubrics.flatMap(rubric =>
      [rubric.reasoning.label, ...Object.values(rubric.options), ...rubric.fields.map(field => field.label)]),
    ...configuration.workflows.flatMap(workflow => [
      workflow.title, workflow.description, ...workflow.review_questions,
      ...workflow.fields.flatMap(field => [field.label, ...(field.description ? [field.description] : []),
        ...(field.options ?? []).map(option => option.label)]),
    ]),
  ];
  for (const text of localized) {
    for (const locale of locales) assert.ok(text[locale]?.trim(), JSON.stringify(text));
  }
});

test('repair drafts, blind randomized review, concurrent retries, privacy and points', async () => {
  const users = [];
  for (let index = 0; index < 4; index++) {
    const result = await call('/register', { body: {
      email: 'm2-' + index + '@example.invalid', password: 'synthetic-m2-password', nickname: 'M2 tester ' + index,
    } });
    assert.equal(result.status, 201, JSON.stringify(result.data));
    users.push(token(result));
  }
  const [author, first, second, third] = users;
  const api = (path, cookie, options = {}) => call('/v1' + path, { cookie, ...options });
  const assertStatus = (result, status) => assert.equal(result.status, status, JSON.stringify(result.data));
  const expertise = async (cookie, category) => assertStatus(await call('/profile/expertise', {
    cookie, method: 'PUT', body: { expertise: [category] },
  }), 200);
  await expertise(author, 'hvac');
  await expertise(first, 'hvac');
  await expertise(second, 'plumbing');
  const id = crypto.randomUUID();
  const ownPath = '/me/submissions/' + id;
  const read = async (cookie = author) => api(ownPath, cookie);
  const values = {
    equipment_category: 'hvac', symptoms: '  عرض تجريبي E-42/A\nاستمر العطل  ',
    source_type: 'firsthand', sharing_permission: 'community', outcome: 'unresolved',
  };
  const write = (fields, reviewConsent = false, cookie = author) => api(ownPath, cookie, {
    method: 'PUT', body: { values: fields, review_consent: reviewConsent, schema_version: 1, content_language: 'ar' },
  });
  const submit = () => api(ownPath + '/submit', author, { body: {} });
  const queue = async cookie => (await api('/me/reviews', cookie)).data.items;
  const refresh = cookie => api('/me/reviews/refresh', cookie, { body: {} });
  const originalReasoning = '  Synthetic bench evidence supports this independent assessment.\n  ';
  const decision = (cookie, assignment, assessment, reasoning = originalReasoning, consistency = 'not_applicable') =>
    api('/me/reviews/' + assignment, cookie, { body: {
      answers: {
        technical_plausibility: 'yes', explanation_sufficient: 'yes',
        resolution_consistency: consistency, overall_assessment: assessment,
      },
      reasoning,
    } });

  assertStatus(await api('/me/submissions'), 401);
  assertStatus(await write({ invalid: 'extra field' }), 422);
  assert.equal((await write({ symptoms: 'Synthetic draft' })).data.status, 'draft');
  assert.equal((await api('/me/submissions?status=draft', author)).data.items[0].id, id);
  assertStatus(await read(first), 404);
  assertStatus(await write(values, true, first), 409);
  assertStatus(await api('/repairs/' + id), 404);
  assertStatus(await write(values), 200);
  assert.equal((await submit()).data.code, 'consentNeeded');
  assertStatus(await write({ ...values, outcome: 'resolved' }, true), 200);
  assert.ok((await submit()).data.errors.resolution);
  assertStatus(await write(values, true), 200);
  const concurrent = await Promise.all([submit(), submit(), submit()]);
  concurrent.forEach(result => {
    assertStatus(result, 200);
    assert.equal(result.data.status, 'pending');
  });
  assert.equal((await read()).data.values.symptoms, values.symptoms);
  assert.equal((await read()).data.content_language, 'ar');
  assert.deepEqual(await queue(first), []);
  assert.deepEqual(await queue(author), []);
  assertStatus(await write(values, true), 409);

  await expertise(second, 'hvac');
  await Promise.all([refresh(first), refresh(second), refresh(first), refresh(second)]).then(results =>
    results.forEach(result => assertStatus(result, 200)));
  assert.equal((await read()).data.status, 'in_review');
  const [firstQueue, secondQueue] = await Promise.all([queue(first), queue(second)]);
  assert.equal(firstQueue.length, 1);
  assert.equal(secondQueue.length, 1);
  assert.notEqual(firstQueue[0].id, secondQueue[0].id);
  assert.equal(firstQueue[0].feedback, null);
  assert.equal(firstQueue[0].repair.values.sharing_permission, undefined);
  assert.equal(firstQueue[0].repair.status, undefined);
  assert.equal(firstQueue[0].repair.author_nickname, undefined);
  assertStatus(await decision(author, firstQueue[0].id, 'valid'), 404);
  assertStatus(await decision(second, firstQueue[0].id, 'valid'), 404);
  assertStatus(await api('/me/reviews/' + firstQueue[0].id, first, { body: { decision: 'approve' } }), 422);
  await Promise.all([decision(first, firstQueue[0].id, 'valid'), decision(first, firstQueue[0].id, 'valid')])
    .then(results => results.forEach(result => assertStatus(result, 200)));
  assert.equal((await queue(second))[0].feedback, null);
  assert.equal((await read()).data.status, 'in_review');
  assertStatus(await decision(second, secondQueue[0].id, 'invalid'), 200);
  assert.equal((await read()).data.status, 'disputed');
  assertStatus(await api('/repairs/' + id), 404);
  assert.deepEqual(await queue(third), []);

  await expertise(third, 'hvac');
  await Promise.all([refresh(third), refresh(third)]);
  const thirdQueue = await queue(third);
  assert.equal(thirdQueue.length, 1);
  assert.equal(thirdQueue[0].feedback, null);
  assertStatus(await decision(third, thirdQueue[0].id, 'valid'), 200);
  assert.equal((await read()).data.status, 'peer_reviewed');
  const publicCase = await api('/repairs/' + id);
  assertStatus(publicCase, 200);
  assert.equal(publicCase.data.values.symptoms, values.symptoms);
  assert.equal(publicCase.data.author_nickname, 'M2 tester 0');
  assert.equal(publicCase.data.dissent, true);
  assert.equal(publicCase.data.feedback, undefined);
  assert.equal((await read()).data.feedback.length, 3);
  assert.ok((await read()).data.feedback.every(entry =>
    entry.rubric_version === 1 && entry.answers.reasoning === originalReasoning));
  for (const forbidden of ['user_id', 'email', 'password_hash', 'review_consent']) {
    assert.equal(publicCase.data[forbidden], undefined);
  }
  assert.equal((await api('/repairs?category=hvac&source_type=firsthand&limit=1')).data.items[0].id, id);
  assert.deepEqual((await api('/repairs?category=plumbing')).data.items, []);
  assert.deepEqual((await api('/repairs?offset=1&limit=1')).data.items, []);
  assertStatus(await api('/repairs?limit=51'), 400);
  assert.equal((await api('/me/submissions?status=peer_reviewed', author)).data.items[0].id, id);
  assert.deepEqual((await api('/me/submissions', first)).data.items, []);
  for (const cookie of users) {
    const data = (await api('/me/activity', cookie)).data;
    assert.equal(data.points, 1);
    assert.equal(data.history.length, 1);
  }
  assert.equal((await api('/me/activity', author)).data.reputation.peer_reviewed_repairs, 1);
  assert.ok((await api('/leaderboard')).data.items.every(item =>
    Object.keys(item).sort().join(',') === 'nickname,points'));

  // A consenting author can still keep the reviewed case private. Initial selection
  // is randomized, so locate the two assignments by case rather than by account.
  const privateId = crypto.randomUUID();
  const privatePath = '/me/submissions/' + privateId;
  assertStatus(await api(privatePath, author, { method: 'PUT', body: {
    values: { ...values, sharing_permission: 'private' }, review_consent: true, schema_version: 1, content_language: 'ar',
  } }), 200);
  assertStatus(await api(privatePath + '/submit', author, { body: {} }), 200);
  const selected = [];
  for (const cookie of [first, second, third]) {
    const match = (await queue(cookie)).find(item => item.repair.id === privateId);
    if (match) selected.push([cookie, match.id]);
  }
  assert.equal(selected.length, 2);
  const outcomes = await Promise.all(selected.map(([cookie, assignment]) => decision(cookie, assignment, 'valid')));
  outcomes.forEach(result => assertStatus(result, 200));
  assert.equal((await api(privatePath, author)).data.status, 'peer_reviewed');
  assertStatus(await api('/repairs/' + privateId), 404);
  assert.deepEqual((await api('/repairs')).data.items.map(item => item.id), [id]);

  async function makeCase(extra = {}) {
    const caseId = crypto.randomUUID();
    const path = '/me/submissions/' + caseId;
    assertStatus(await api(path, author, { method: 'PUT', body: {
      values: { ...values, ...extra }, review_consent: true, schema_version: 1, content_language: 'ar',
    } }), 200);
    assertStatus(await api(path + '/submit', author, { body: {} }), 200);
    return { caseId, path };
  }

  async function assignedTo(caseId) {
    const matches = await Promise.all([first, second, third].map(async cookie => [cookie,
      (await api('/me/reviews?limit=50', cookie)).data.items.find(item => item.repair.id === caseId),
    ]));
    return matches.filter(([, item]) => item);
  }

  const verdicts = ['valid', 'needs_improvement', 'invalid', 'cannot_assess'];
  let clarificationPath;
  for (const left of verdicts) {
    for (const right of verdicts) {
      const { caseId, path } = await makeCase();
      const pair = await assignedTo(caseId);
      assert.equal(pair.length, 2);
      for (const [[cookie, assignment], assessment] of [[pair[0], left], [pair[1], right]]) {
        assertStatus(await decision(cookie, assignment.id, assessment), 200);
      }
      const outcome = left === 'needs_improvement' || right === 'needs_improvement' ? 'needs_clarification' :
        left === 'valid' && right === 'valid' ? 'peer_reviewed' :
        left === 'invalid' && right === 'invalid' ? 'rejected' : 'disputed';
      assert.equal((await api(path, author)).data.status, outcome, left + ' + ' + right);
      assert.equal((await assignedTo(caseId)).length, outcome === 'disputed' ? 3 : 2);
      if (left === 'valid' && right === 'needs_improvement') clarificationPath = path;
    }
  }
  for (const [thirdVerdict, expected] of [
    ['valid', 'peer_reviewed'], ['invalid', 'rejected'], ['cannot_assess', 'disputed'],
    ['needs_improvement', 'needs_clarification'],
  ]) {
    const { caseId, path } = await makeCase();
    const [a, b] = await assignedTo(caseId);
    await decision(a[0], a[1].id, 'valid');
    await decision(b[0], b[1].id, 'invalid');
    const [cookie, tie] = (await assignedTo(caseId)).find(([, item]) => !item.completed);
    assertStatus(await decision(cookie, tie.id, thirdVerdict), 200);
    assert.equal((await api(path, author)).data.status, expected);
  }

  await expertise(third, 'plumbing');
  const abstentions = await makeCase();
  const [a, b] = await assignedTo(abstentions.caseId);
  assertStatus(await decision(a[0], a[1].id, 'cannot_assess', ''), 422);
  await decision(a[0], a[1].id, 'cannot_assess');
  await decision(b[0], b[1].id, 'valid', '');
  assert.equal((await api(abstentions.path, author)).data.status, 'disputed');
  assert.equal((await assignedTo(abstentions.caseId)).length, 2);
  await expertise(third, 'hvac');
  await refresh(third);
  const [replacementCookie, replacement] = (await assignedTo(abstentions.caseId)).find(([, item]) => !item.completed);
  await decision(replacementCookie, replacement.id, 'valid', '');
  assert.equal((await api(abstentions.path, author)).data.status, 'peer_reviewed');

  const resolvedReport = await makeCase({ outcome: 'resolved', resolution: 'Synthetic simulator reset.' });
  const [[resolvedReviewer, resolvedAssignment]] = await assignedTo(resolvedReport.caseId);
  assertStatus(await decision(resolvedReviewer, resolvedAssignment.id, 'valid'), 422);
  assertStatus(await decision(resolvedReviewer, resolvedAssignment.id, 'valid', '', 'yes'), 200);

  const previous = (await api(clarificationPath, author)).data;
  assert.equal(previous.feedback.length, 2);
  assert.ok(previous.feedback.some(entry => entry.assessment === 'needs_improvement' && entry.answers.reasoning === originalReasoning));
  assertStatus(await api(clarificationPath + '/revision', first, { body: {} }), 404);
  const revisions = await Promise.all([api(clarificationPath + '/revision', author, { body: {} }),
    api(clarificationPath + '/revision', author, { body: {} })]);
  revisions.forEach(result => assertStatus(result, 200));
  assert.equal(revisions[0].data.id, revisions[1].data.id);
  const revisionPath = '/me/submissions/' + revisions[0].data.id;
  const revision = await api(revisionPath, author);
  assert.equal(revision.data.previous_revision_id, previous.id);
  assert.equal(revision.data.review_consent, false);
  assertStatus(await api(revisionPath, author, { method: 'PUT', body: {
    values: { ...revision.data.values, symptoms: 'Revised synthetic description' },
    review_consent: true, schema_version: 1, content_language: 'ar',
  } }), 200);
  const priorPoints = (await api('/me/activity', author)).data.points;
  assertStatus(await api(revisionPath + '/submit', author, { body: {} }), 200);
  assert.equal((await api(revisionPath, author)).data.status, 'in_review');
  assert.equal((await api('/me/activity', author)).data.points, priorPoints);
  const retained = (await api(clarificationPath, author)).data;
  assert.equal(retained.values.symptoms, values.symptoms);
  assert.deepEqual(retained.feedback, previous.feedback);
  assert.equal(retained.next_revision_id, revision.data.id);
  assert.equal((await assignedTo(revision.data.id)).filter(([, item]) => item.feedback === null).length, 2);

});

test('private client diagnosis creation, shared blind review, safety and structured results', async () => {
  const keys = Array.from({ length: 3 }, () => 'ekn_' + randomBytes(32).toString('hex'));
  const values = keys.map((key, index) =>
    `('test-client-${index}', 'Private client ${index}', '${createHash('sha256').update(key).digest('hex')}', ${index === 2 ? 1 : 'NULL'})`);
  const seeded = wrangler(['d1', 'execute', 'DB', '--local', '--persist-to', directory, '--command',
    'INSERT INTO external_api_clients (id, label, api_key_hash, revoked_at) VALUES ' + values.join(',')]);
  let output = '';
  for (const stream of [seeded.stdout, seeded.stderr]) stream.on('data', data => { output += data; });
  assert.equal(await new Promise(resolve => seeded.on('close', resolve)), 0, output);
  const context = {
    schema_version: 1, content_language: 'ar', equipment_category: 'electrical_controls',
    symptoms: 'إشارة الاختبار D-17 لا تظهر.',
    proposed_diagnosis: 'Synthetic control simulator may have an unrecognized input.',
    recommended_next_steps: 'Review the synthetic event log.',
  };
  const create = (reference, body = context, key = keys[0]) => call('/v1/tasks', {
    body, headers: { Authorization: 'Bearer ' + key, ...(reference ? { 'Idempotency-Key': reference } : {}) },
  });
  const get = (id, key = keys[0]) => call('/v1/tasks/' + id, { headers: { Authorization: 'Bearer ' + key } });
  const check = (response, status) => assert.equal(response.status, status, JSON.stringify(response.data));
  const assertState = async (id, state) => {
    const response = await get(id);
    check(response, 200);
    assert.equal(response.data.status, state, JSON.stringify(response.data));
    return response.data;
  };
  check(await call('/v1/tasks', { body: context }), 401);
  check(await create('bad', context, 'bad-key'), 401);
  check(await create('revoked', context, keys[2]), 401);
  check(await create(null), 400);
  check(await create('oversized', { ...context, symptoms: 'x'.repeat(81_000) }), 400);
  check(await create('unknown', { ...context, media: 'example' }), 422);
  check(await create('bad-language', { ...context, content_language: 'not_a_language' }), 422);
  check(await create('private-contact', { ...context, symptoms: 'Synthetic owner buyer@example.invalid' }), 422);

  const initial = await Promise.all(Array.from({ length: 4 }, () => create('stable')));
  assert.equal(initial.filter(response => response.status === 201).length, 1);
  assert.ok(initial.every(response => [200, 201].includes(response.status)));
  const id = initial[0].data.id;
  assert.ok(initial.every(response => response.data.id === id && response.data.status === 'pending'));
  check(await create('stable', { ...context, symptoms: 'Changed' }), 409);
  const other = await create('stable', { ...context, equipment_category: 'heating_boilers' }, keys[1]);
  check(other, 201);
  assert.notEqual(other.data.id, id);
  check(await get(id, keys[1]), 404);
  assert.deepEqual((await get(crypto.randomUUID(), keys[1])).data, (await get(id, keys[1])).data);
  assert.equal((await assertState(id, 'pending')).review_counts.assigned, 0);

  const reviewers = [];
  async function expertise(cookie, categories) {
    check(await call('/profile/expertise', { cookie, method: 'PUT', body: { expertise: categories } }), 200);
  }
  for (let index = 0; index < 3; index++) {
    const result = await call('/register', { body: {
      email: 'diagnosis-reviewer-' + index + '@example.invalid',
      password: 'synthetic-diagnosis-password',
      nickname: 'Diagnosis reviewer ' + index,
    } });
    check(result, 201);
    reviewers.push(token(result));
    if (index < 2) await expertise(reviewers[index], ['electrical_controls']);
  }
  const queue = async cookie => (await call('/v1/me/reviews', { cookie })).data.items;
  const refresh = cookie => call('/v1/me/reviews/refresh', { cookie, body: {} });
  async function assignments(task) {
    const entries = await Promise.all(reviewers.map(async cookie => [cookie,
      (await queue(cookie)).find(item => item.repair.id === task)]));
    return entries.filter(([, item]) => item);
  }
  const submit = (entry, assessment, safety = 'safe',
    reasoning = 'The simulator event log supports this independent assessment.') => call('/v1/me/reviews/' + entry[1].id, {
    cookie: entry[0], body: {
      answers: { technical_plausibility: 'yes', next_step_safety: safety, explanation_sufficient: 'yes', overall_assessment: assessment },
      reasoning,
    },
  });
  const newTask = async (reference, body = context) => {
    const response = await create(reference, body);
    check(response, 201);
    return response.data.id;
  };

  await Promise.all([refresh(reviewers[0]), refresh(reviewers[1]), refresh(reviewers[0])]);
  assert.equal((await assertState(id, 'in_review')).review_counts.assigned, 2);
  const pair = await assignments(id);
  assert.equal(pair.length, 2);
  assert.equal(pair[0][1].workflow_type, 'diagnosis_review');
  assert.equal(pair[0][1].repair.values.symptoms, context.symptoms);
  assert.equal(pair[0][1].feedback, null);
  assert.ok(!JSON.stringify(pair).includes('Private client'));
  check(await submit([reviewers[2], pair[0][1]], 'valid'), 404);
  const original = 'Diagnosis reviewer ' + reviewers.indexOf(pair[0][0]) +
    ' observed an event log warning. Contact reviewer@example.invalid.';
  await Promise.all([submit(pair[0], 'valid', 'safe', original), submit(pair[0], 'valid', 'safe', original)])
    .then(results => results.forEach(result => check(result, 200)));
  const waiting = (await assignments(id)).find(([cookie]) => cookie === pair[1][0]);
  assert.equal(waiting[1].feedback, null);
  check(await submit(pair[1], 'valid'), 200);
  const approved = await assertState(id, 'peer_reviewed');
  assert.deepEqual(approved.review_counts, { required: 2, assigned: 2, completed: 2 });
  assert.equal(approved.aggregate.assessment, 'valid');
  assert.equal(approved.reviews.length, 2);
  assert.ok(approved.reviews.some(item => item.reasoning.includes('[redacted] observed')));
  assert.ok(!JSON.stringify(approved).includes('reviewer@example.invalid'));
  assert.ok(!JSON.stringify(approved).includes('Diagnosis reviewer'));
  assert.ok((await queue(pair[0][0])).find(item => item.repair.id === id).feedback.answers.reasoning === original);
  assert.equal((await call('/v1/me/activity', { cookie: pair[0][0] })).data.points, 1);
  assert.equal((await call('/v1/me/activity', { cookie: pair[1][0] })).data.points, 1);
  check(await call('/v1/repairs/' + id), 404);
  check(await call('/v1/me/submissions/' + id, { cookie: reviewers[0] }), 404);
  assert.ok(!(await call('/v1/repairs', {})).data.items.some(item => item.id === id));

  const conflict = await newTask('conflict');
  const split = await assignments(conflict);
  await Promise.all([submit(split[0], 'valid'), submit(split[1], 'invalid')]);
  const missing = await assertState(conflict, 'inconclusive');
  assert.equal(missing.aggregate.disagreement, true);
  await expertise(reviewers[2], ['electrical_controls']);
  await refresh(reviewers[2]);
  await assertState(conflict, 'disputed');
  const tie = (await assignments(conflict)).find(([, item]) => !item.completed);
  check(await submit(tie, 'valid'), 200);
  assert.equal((await assertState(conflict, 'peer_reviewed')).reviews.length, 3);

  const unsafe = await newTask('unsafe');
  const safetyPair = await assignments(unsafe);
  const contradictory = await submit(safetyPair[0], 'valid', 'unsafe');
  check(contradictory, 422);
  assert.equal(contradictory.data.code, 'unsafeAssessment');
  check(await submit(safetyPair[0], 'cannot_assess', 'unsafe'), 200);
  check(await submit(safetyPair[1], 'valid'), 200);
  const rejected = await assertState(unsafe, 'rejected');
  assert.equal(rejected.aggregate.unsafe_next_step, true);

  const clarification = await newTask('clarify', { ...context, required_reviews: 3, recommended_next_steps: '' });
  const three = await assignments(clarification);
  assert.equal(three.length, 3);
  check(await submit(three[0], 'needs_improvement', 'not_applicable', ' '), 422);
  check(await submit(three[0], 'needs_improvement', 'not_applicable'), 200);
  check(await submit(three[1], 'valid', 'not_applicable'), 200);
  await assertState(clarification, 'in_review');
  check(await submit(three[2], 'valid', 'not_applicable'), 200);
  assert.equal((await assertState(clarification, 'needs_clarification')).aggregate.clarification_requested, true);

  const abstention = await newTask('abstention');
  const abstaining = await assignments(abstention);
  await Promise.all([submit(abstaining[0], 'valid'), submit(abstaining[1], 'cannot_assess')]);
  const replacement = (await assignments(abstention)).find(([, item]) => !item.completed);
  check(await submit(replacement, 'cannot_assess'), 200);
  assert.equal((await assertState(abstention, 'inconclusive')).review_counts.completed, 3);

  for (let attempt = 0; attempt < 125; attempt++) {
    const response = await get(id);
    if (response.status === 429) {
      check(await get(other.data.id, keys[1]), 200);
      return;
    }
    check(response, 200);
  }
  assert.fail('Client rate limit was not reached');
});

test('admin access is role-gated and exports protect private tasks and CSV formulas', async () => {
  const api = path => call('/v1/admin/' + path);
  assert.equal((await api('overview')).status, 401);
  assert.equal((await call('/v1/admin/overview', { headers: { Authorization: 'Bearer synthetic-key' } })).status, 401);
  await executeD1('DELETE FROM auth_limits');
  const ordinary = await call('/login', { body: alice });
  assert.equal((await call('/v1/admin/overview', { cookie: token(ordinary) })).status, 403);
  await executeD1("UPDATE users SET role = 'admin' WHERE email = 'm2-0@example.invalid'");
  const adminLogin = await call('/login', { body: {
    email: 'm2-0@example.invalid', password: 'synthetic-m2-password',
  } });
  assert.equal(adminLogin.status, 200);
  assert.equal(adminLogin.data.user.is_admin, true);
  const admin = token(adminLogin);
  const authorized = (path, options = {}) => call('/v1/admin/' + path, { cookie: admin, ...options });
  const overview = await authorized('overview');
  assert.equal(overview.status, 200);
  assert.ok(overview.data.repair_count > 0);
  assert.ok(overview.data.diagnosis_count > 0);
  const records = await authorized('submissions?type=diagnosis_review&limit=5');
  assert.equal(records.status, 200);
  const detail = await authorized('submissions/' + records.data.items[0].id);
  assert.equal(detail.status, 200);
  assert.ok(Array.isArray(detail.data.reviews));
  assert.equal(detail.data.email, undefined);
  const exported = await authorized('export?format=json');
  assert.equal(exported.status, 200);
  assert.ok(exported.data.records.length > 0);
  assert.ok(exported.data.records.every(row => row.workflow_type === 'repair_case' &&
    row.status === 'peer_reviewed' && row.sharing_permission === 'community'));
  assert.ok(!JSON.stringify(exported.data).includes('diagnosis_review'));
  assert.ok(!JSON.stringify(exported.data).includes('@example.invalid'));
  const privateScope = await authorized('export?format=json&scope=internal');
  assert.ok(privateScope.data.records.some(row => row.sharing_permission === 'private'));
  assert.ok(privateScope.data.records.every(row => row.workflow_type === 'repair_case'));

  const publicId = exported.data.records[0].id;
  await executeD1(`UPDATE workflow_submissions SET payload = json_set(payload, '$.symptoms', '=1+1') WHERE id = '${publicId}'`);
  const csvResponse = await fetch(base + '/api/v1/admin/export?format=csv', {
    headers: { Cookie: adminLogin.cookie.split(';')[0] },
  });
  assert.equal(csvResponse.status, 200);
  assert.match(csvResponse.headers.get('content-type'), /text\/csv/);
  assert.match(await csvResponse.text(), /'=1\+1/);
  assert.equal((await authorized('submissions?type=unknown')).status, 400);

  const deletionLogin = await call('/login', { body: bob });
  assert.equal((await call('/account/delete', { cookie: token(deletionLogin), body: { password: 'wrong-password' } })).status, 403);
  assert.equal((await call('/account/delete', { cookie: token(deletionLogin), body: { password: bob.password } })).status, 200);
  assert.deepEqual((await call('/session', { cookie: token(deletionLogin) })).data, { user: null });
  assert.equal((await call('/login', { body: bob })).status, 401);
});
