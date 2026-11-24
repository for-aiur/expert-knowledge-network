import { randomUUID } from 'node:crypto';

const base = process.env.EKN_URL ?? 'http://localhost:8788';
const key = process.env.EKN_CLIENT_KEY;
if (!key) throw new Error('Set EKN_CLIENT_KEY to a local client key.');
const headers = { Authorization: 'Bearer ' + key };

async function api(path, options) {
  const response = await fetch(new URL('/api/v1/tasks' + path, base), {
    ...options, headers: { ...headers, ...options?.headers },
  });
  const body = await response.json();
  if (!response.ok) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body)}`);
  return body;
}

const { id } = await api('', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json', 'Idempotency-Key': randomUUID() },
  body: JSON.stringify({
    schema_version: 1, equipment_category: 'hvac', content_language: 'en',
    symptoms: 'Synthetic simulator: the airflow indicator stays at zero.',
    proposed_diagnosis: 'The simulator may have lost its airflow sensor signal.',
    recommended_next_steps: 'Inspect the saved simulator event log for an input warning.',
  }),
});
console.log(`Task ${id}. Complete independent HVAC assessments in the Review Queue.`);
for (let attempt = 0; attempt < 48; attempt++) {
  const result = await api('/' + id);
  if (['peer_reviewed', 'rejected', 'needs_clarification', 'inconclusive'].includes(result.status)) {
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }
  if (attempt === 47) {
    console.log(JSON.stringify(result, null, 2));
    console.error('Polling ended before a result was available. Retrieve the task again later.');
    process.exitCode = 2;
    break;
  }
  await new Promise(resolve => setTimeout(resolve, 5000));
}
