/**
 * Unsync Drive — First-run setup
 * Generates .env with all required values
 * Run: node setup.js
 */

const readline = require('readline');
const crypto   = require('crypto');
const fs       = require('fs');
const path     = require('path');

const rl  = readline.createInterface({ input: process.stdin, output: process.stdout });
const ask = (q, def) => new Promise(res => {
  rl.question(def ? `${q} [${def}]: ` : `${q}: `, ans => res(ans.trim() || def || ''));
});

async function main() {
  console.log('\n  Unsync Drive — Setup\n  ' + '─'.repeat(32) + '\n');

  const port     = await ask('Port',           '3700');
  const storage  = await ask('Storage path',   path.join(__dirname, 'storage'));
  const username = await ask('Username',        'dexter');
  const password = await ask('Password',        '');

  if (!password) {
    console.error('\n  ❌  Password cannot be empty.\n');
    rl.close();
    process.exit(1);
  }

  const secret = crypto.randomBytes(48).toString('hex');

  const env = [
    `PORT=${port}`,
    `STORAGE_ROOT=${storage}`,
    `JWT_SECRET=${secret}`,
    `DRIVE_USERNAME=${username}`,
    `DRIVE_PASSWORD=${password}`,
  ].join('\n') + '\n';

  fs.writeFileSync(path.join(__dirname, '.env'), env);

  console.log('\n  ✅  .env created');
  console.log(`  Storage: ${storage}`);
  console.log(`  Access:  http://localhost:${port}\n`);
  console.log('  Next: npm install && npm start\n');

  rl.close();
}

main().catch(e => {
  console.error(e);
  rl.close();
  process.exit(1);
});
