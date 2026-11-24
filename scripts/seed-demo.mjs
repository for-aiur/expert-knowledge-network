import { randomUUID } from 'node:crypto';

const base = new URL(process.env.EKN_URL ?? 'http://localhost:8788');
const inviteCode = process.env.EKN_BETA_INVITE_CODE;
const clientKey = process.env.EKN_CLIENT_KEY;
const local = ['localhost','127.0.0.1','[::1]'].includes(base.hostname);
if (!local) throw new Error('Sample fixtures may only be created on localhost.');
if (!inviteCode) throw new Error('Set EKN_BETA_INVITE_CODE to the local invitation value.');
if (!clientKey) throw new Error('Set EKN_CLIENT_KEY using scripts/provision-local-client.mjs first.');

async function api(path, { method = 'GET', body, cookie, headers = {} } = {}) {
  const response = await fetch(new URL('/api' + path, base), { method,
    headers: { Origin: base.origin, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(cookie ? { Cookie: cookie } : {}), ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
  let data;
  const text = await response.text();
  try { data = JSON.parse(text); } catch { throw new Error(`Unexpected response ${response.status}: ${text.slice(0,200)}`); }
  return { status: response.status, data, cookie: response.headers.get('set-cookie')?.split(';')[0] };
}

const people = [
  { name:'author', email:'author@demo.example.invalid', nickname:'Demo Contributor', expertise:[] },
  { name:'reviewer-a', email:'reviewer-a@demo.example.invalid', nickname:'Review Participant A', expertise:['hvac','heating_boilers','industrial_equipment'] },
  { name:'reviewer-b', email:'reviewer-b@demo.example.invalid', nickname:'Review Participant B', expertise:['hvac','heating_boilers','industrial_equipment'] },
  { name:'reviewer-c', email:'reviewer-c@demo.example.invalid', nickname:'Review Participant C', expertise:['hvac','heating_boilers','industrial_equipment'] },
];
const password = 'synthetic-demo-account-password';
const sessions = new Map();
for (const person of people) {
  let result = await api('/register', { method:'POST', body: { email:person.email, nickname:person.nickname,
    password, invite_code:inviteCode, privacy_consent:true } });
  if (result.status === 409) result = await api('/login', { method:'POST', body:{ email:person.email, password } });
  if (![200,201].includes(result.status) || !result.cookie) throw new Error(`Account setup failed: ${person.email}: ${JSON.stringify(result.data)}`);
  sessions.set(person.name, result.cookie);
  if (person.expertise.length) {
    const saved = await api('/profile/expertise', { method:'PUT', cookie:result.cookie, body:{ expertise:person.expertise } });
    if (saved.status !== 200) throw new Error(JSON.stringify(saved.data));
  }
}

const cases = [
  { id:'00000000-0000-4000-8000-000000000101', name:'peer-reviewed HVAC repair', category:'hvac',
    values:{ manufacturer:'Northstar Demo Systems', model:'HV-4 (synthetic)', fault_code:'E-42',
      symptoms:'Synthetic bench: the fan stopped after a simulated controller reset.',
      diagnostic_steps:'Compared the simulator event log with the power-on self-test.', root_cause:'Simulated connector seating fault.',
      outcome:'resolved', resolution:'Reseated the simulated connector; bench test passed.', source_type:'firsthand', sharing_permission:'community' },
    verdicts:['valid','valid'] },
  { id:'00000000-0000-4000-8000-000000000102', name:'clarification request', category:'heating_boilers',
    values:{ manufacturer:'Fictional Boiler Works', model:'BW-20 (synthetic)', symptoms:'Synthetic training rig reports intermittent pressure readings.',
      diagnostic_steps:'Read the simulated sensor log twice.', outcome:'partially_resolved', resolution:'A temporary simulator reset restored readings.',
      source_type:'observed', sharing_permission:'private' }, verdicts:['needs_improvement','valid'] },
  { id:'00000000-0000-4000-8000-000000000103', name:'third-review disagreement', category:'industrial_equipment',
    values:{ manufacturer:'Demo Motion Labs', model:'IM-8 (synthetic)', fault_code:'F-8',
      symptoms:'Synthetic conveyor model stops during a load test.', diagnostic_steps:'Reviewed the simulated motor current trace.',
      outcome:'unresolved', source_type:'secondhand', sharing_permission:'private' }, verdicts:['valid','invalid','valid'] },
  { id:'00000000-0000-4000-8000-000000000104', name:'pending without eligible expertise', category:'plumbing',
    values:{ manufacturer:'Example Flow Equipment', model:'PF-2 (synthetic)', symptoms:'Synthetic training pump cycles without moving water.',
      outcome:'unresolved', source_type:'firsthand', sharing_permission:'private' }, verdicts:[] },
];

async function reviewAssignment(personName, assignment, assessment, type='repair_case') {
  const answers = type === 'repair_case' ? {
    technical_plausibility:'yes', resolution_consistency:assignment.repair.values.outcome === 'unresolved' ? 'not_applicable' : 'yes',
    explanation_sufficient:'yes', overall_assessment:assessment,
  } : { technical_plausibility:'yes', next_step_safety:'safe', explanation_sufficient:'yes', overall_assessment:assessment };
  const result = await api('/v1/me/reviews/' + assignment.id, { method:'POST', cookie:sessions.get(personName),
    body:{ answers, reasoning:'Synthetic demo assessment based only on the fictional record and simulated evidence.' } });
  if (result.status !== 200) throw new Error(`Review failed: ${JSON.stringify(result.data)}`);
}

async function findOpenAssignments(id) {
  const found = [];
  for (const person of people.slice(1)) {
    const queue = await api('/v1/me/reviews?limit=50', { cookie:sessions.get(person.name) });
    if (queue.status !== 200) throw new Error(JSON.stringify(queue.data));
    const item = queue.data.items.find(entry => entry.repair.id === id && !entry.completed);
    if (item) found.push({ person:person.name, assignment:item });
  }
  return found;
}

for (const record of cases) {
  const existing = await api('/v1/me/submissions/' + record.id, { cookie:sessions.get('author') });
  if (existing.status === 404) {
    const draft = await api('/v1/me/submissions/' + record.id, { method:'PUT', cookie:sessions.get('author'), body:{
      schema_version:1, content_language:'en', review_consent:true,
      values:{ equipment_category:record.category, ...record.values },
    } });
    if (draft.status !== 200) throw new Error(`Draft failed: ${JSON.stringify(draft.data)}`);
    const submitted = await api('/v1/me/submissions/' + record.id + '/submit', { method:'POST', cookie:sessions.get('author'), body:{} });
    if (![200,201].includes(submitted.status)) throw new Error(`Submission failed: ${JSON.stringify(submitted.data)}`);
  } else if (existing.status !== 200) throw new Error(JSON.stringify(existing.data));
  if (!record.verdicts.length) continue;
  for (const verdict of record.verdicts.slice(0,2)) {
    const open = await findOpenAssignments(record.id);
    const target = open[0];
    if (!target) break;
    await reviewAssignment(target.person, target.assignment, verdict);
  }
  if (record.verdicts[2]) {
    const tie = (await findOpenAssignments(record.id))[0];
    if (tie) await reviewAssignment(tie.person, tie.assignment, record.verdicts[2]);
  }
  const final = await api('/v1/me/submissions/' + record.id, { cookie:sessions.get('author') });
  console.log(`${record.name}: ${final.data.status}`);
}

async function createTask(reference, category, label, requiredReviews, verdicts) {
  const headers = { Authorization:'Bearer ' + clientKey, 'Idempotency-Key':reference };
  const created = await api('/v1/tasks', { method:'POST', headers, body:{ schema_version:1, content_language:'en',
    required_reviews:requiredReviews, equipment_category:category,
    symptoms:`Synthetic ${label} simulator reports a repeatable test fault.`,
    proposed_diagnosis:`Fictional ${label} controller may have an intermittent input signal.`,
    supporting_evidence:'Synthetic simulator trace only.', recommended_next_steps:'Inspect the saved simulator event log.' } });
  if (![200,201].includes(created.status)) throw new Error(`Task setup failed: ${JSON.stringify(created.data)}`);
  for (const verdict of verdicts) {
    const open = await findOpenAssignments(created.data.id);
    const target = open.find(item => !item.assignment.completed);
    if (!target) break;
    await reviewAssignment(target.person, target.assignment, verdict, 'diagnosis_review');
  }
  const result = await api('/v1/tasks/' + created.data.id, { headers:{ Authorization:'Bearer ' + clientKey } });
  if (result.status !== 200) throw new Error(JSON.stringify(result.data));
  console.log(`${label} diagnosis task: ${result.data.status}`);
}

await createTask('synthetic-demo-final-diagnosis-v1','hvac','HVAC',2,['valid','valid']);
await createTask('synthetic-demo-inconclusive-diagnosis-v1','industrial_equipment','industrial',3,['valid','invalid','cannot_assess']);
console.log('Seeded synthetic closed-beta demo accounts, repair cases and diagnosis tasks.');
for (const person of people) console.log(`${person.email} / ${password}`);
