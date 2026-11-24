import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';

const state = process.env.EKN_D1_STATE;
const key = 'ekn_' + randomBytes(32).toString('hex');
const digest = createHash('sha256').update(key).digest('hex');
execFileSync(process.execPath, ['node_modules/wrangler/bin/wrangler.js', 'd1', 'execute', 'DB',
  '--local', ...(state ? ['--persist-to', state] : []), '--command', `INSERT INTO external_api_clients (id, label, api_key_hash)
  VALUES ('${randomUUID()}', 'Local synthetic client', '${digest}')`], { stdio: ['ignore', 'ignore', 'inherit'] });
// The key is printed once for the caller. Only its digest enters D1.
process.stdout.write(key + '\n');
