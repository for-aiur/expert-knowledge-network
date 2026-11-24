import { createInterface } from 'node:readline/promises';
import { stdin, stdout } from 'node:process';
import { spawn } from 'node:child_process';

const arg = process.argv.slice(2).find(value => value.startsWith('--email='));
const index = process.argv.indexOf('--email');
const email = arg?.slice('--email='.length) ?? (index >= 0 ? process.argv[index + 1] : '');
if (!email || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || email.length > 254) {
  console.error('Usage: npm run admin:grant -- --email="existing-account@example.com"');
  process.exit(2);
}

const io = createInterface({ input: stdin, output: stdout });
const confirm = await io.question(`Promote the existing account ${email} to admin? Type the exact email to continue: `);
io.close();
if (confirm.trim().toLowerCase() !== email.toLowerCase()) {
  console.error('No changes made.');
  process.exit(1);
}

// Wrangler binds this value as a SQL string literal; double embedded quotes.
const sqlEmail = email.replaceAll("'", "''");
const sql = `UPDATE users SET role = 'admin' WHERE email = '${sqlEmail}' COLLATE NOCASE RETURNING id, email, role;`;
const child = spawn(process.platform === 'win32' ? 'npx.cmd' : 'npx',
  ['wrangler', 'd1', 'execute', 'DB', '--remote', '--env', 'production', '--command', sql, '--json'], { stdio: 'inherit' });
child.on('error', error => { console.error(error.message); process.exitCode = 1; });
child.on('close', code => {
  if (code === 0) console.log('If Wrangler returned one matching row, the account is now an admin.');
  else process.exitCode = code ?? 1;
});
