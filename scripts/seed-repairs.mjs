import { createHash } from 'node:crypto';

const base = new URL(process.env.EKN_URL ?? 'http://localhost:8787');
if (!['localhost', '127.0.0.1', '[::1]'].includes(base.hostname)) {
  throw new Error('The synthetic seed only supports localhost.');
}
const password = 'synthetic-repair-demo';
const accounts = [
  ['author', 'Bench Author'],
  ['reviewer-a', 'Bench Reviewer A'],
  ['reviewer-b', 'Bench Reviewer B'],
  ['reviewer-c', 'Bench Reviewer C'],
];

async function api(path, method, body, cookie) {
  const response = await fetch(new URL('/api' + path, base), {
    method, body: JSON.stringify(body),
    headers: { Origin: base.origin, 'Content-Type': 'application/json', ...(cookie ? { Cookie: cookie } : {}) },
  });
  return { response, data: await response.json() };
}

let authorCookie;
for (const [name, nickname] of accounts) {
  const email = name + '@repair.example.invalid';
  let result = await api('/register', 'POST', { email, password, nickname });
  const isNew = result.response.status === 201;
  if (result.response.status === 409) result = await api('/login', 'POST', { email, password });
  if (!result.response.ok) throw new Error(JSON.stringify(result.data));
  const cookie = result.response.headers.get('set-cookie').split(';')[0];
  if (name === 'author') authorCookie = cookie;
  if (isNew && name !== 'reviewer-c') {
    const saved = await api('/profile/expertise', 'PUT', { expertise: ['hvac'] }, cookie);
    if (!saved.response.ok) throw new Error(JSON.stringify(saved.data));
  }
  console.log(email + ' / ' + password);
}

const digest = createHash('sha256').update('ekn-local-seed-v1').digest('hex');
const id = [digest.slice(0, 8), digest.slice(8, 12), digest.slice(12, 16), digest.slice(16, 20), digest.slice(20, 32)].join('-');
const path = '/v1/me/submissions/' + id;
const existing = await api(path, 'GET', undefined, authorCookie);
if (existing.response.status === 404) {
  const saved = await api(path, 'PUT', {
    schema_version: 1, content_language: 'en', review_consent: false,
    values: {
      equipment_category: 'hvac', manufacturer: 'Fictional Bench Lab', model: 'SIM-04',
      fault_code: 'E-42/A', symptoms: 'Synthetic bench: the simulated fan stops after a reset.',
      diagnostic_steps: 'Compared the simulator event log with the power-on self-test.',
      outcome: 'unresolved', source_type: 'firsthand', sharing_permission: 'community',
    },
  }, authorCookie);
  if (!saved.response.ok) throw new Error(JSON.stringify(saved.data));
}
console.log('Author draft or case: ' + new URL('/cases/' + id, base));
