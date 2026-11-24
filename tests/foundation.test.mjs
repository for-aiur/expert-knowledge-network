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
  worker = wrangler(['dev', '--local', '--ip', '127.0.0.1', '--port', port, '--persist-to', directory]);
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

async function call(path, { body, method = body ? 'POST' : 'GET', cookie, origin = base, locale } = {}) {
  const headers = { Origin: origin };
  if (body !== undefined) headers['Content-Type'] = 'application/json';
  if (cookie) headers.Cookie = cookie;
  if (locale) headers['X-EKN-Language'] = locale;
  const response = await fetch(base + '/api' + path, { method, headers, body: JSON.stringify(body) });
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
  assert.equal((await call('/register', { body: { ...alice, password: 'short' } })).status, 400);
  const first = await call('/register', { body: alice });
  assert.equal(first.status, 201, JSON.stringify(first.data));
  assert.match(first.cookie, /^__Host-ekn_session=[a-f0-9]{64}; Path=\/; Max-Age=\d+; HttpOnly; Secure; SameSite=Lax$/);
  const second = await call('/register', { body: bob });
  assert.equal(second.status, 201);
  assert.notEqual(first.data.user.id, second.data.user.id);
  assert.deepEqual(Object.keys(first.data.user).sort(), ['expertise', 'id', 'nickname']);
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
