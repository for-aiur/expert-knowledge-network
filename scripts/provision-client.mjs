import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';

const labelArg = process.argv.slice(2).find(value => value.startsWith('--label='));
const label = (labelArg?.slice('--label='.length) ?? '').trim();
if (!label || label.length > 80 || /[\u0000-\u001f]/.test(label)) {
  console.error('Usage: npm run client:provision -- --label="client label"');
  process.exit(2);
}
const key = 'ekn_' + randomBytes(32).toString('hex');
const hash = createHash('sha256').update(key).digest('hex');
const sqlLabel = label.replaceAll("'", "''");
const sql = `INSERT INTO external_api_clients (id, label, api_key_hash) VALUES ('${randomUUID()}', '${sqlLabel}', '${hash}');`;
const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['wrangler', 'd1', 'execute', 'DB', '--remote', '--env', 'production', '--command', sql], { stdio: ['ignore', 'pipe', 'inherit'] });
let output = '';
child.stdout.on('data', data => { output += data; });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => {
  if (code !== 0) { process.exitCode = code ?? 1; return; }
  if (!/executed|success|ok/i.test(output)) { console.error(output); process.exitCode = 1; return; }
  console.log('Store this client key securely. It cannot be displayed again:');
  console.log(key);
});
