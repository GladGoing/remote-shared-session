import { randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { Store } from '../src/store.mjs';
import { privateJson, optionalJson } from '../src/profile.mjs';
const root = fileURLToPath(new URL('../', import.meta.url));
const path = join(root, '.local', 'local-accounts.json');
const store = new Store(join(root, 'data', 'shared.sqlite'));
try {
  if (store.db.prepare('SELECT 1 FROM users LIMIT 1').get()) {
    console.log(JSON.stringify({ initialized: false, reason: 'accounts_already_exist', accountsFile: (await optionalJson(path)) ? path : null }));
  } else {
    const accounts = ['owner', 'member'].map(username => ({ username, password: randomBytes(24).toString('base64url') }));
    // Save private recovery details before committing users, so no generated password is lost.
    await privateJson(path, { url: 'http://127.0.0.1:8787', accounts, createdAt: new Date().toISOString(), localOnly: true });
    store.atomic(() => { for (const account of accounts) store.createUser(account.username, account.password); });
    console.log(JSON.stringify({ initialized: true, url: 'http://127.0.0.1:8787', accountsFile: path }));
  }
} finally { store.close(); }
