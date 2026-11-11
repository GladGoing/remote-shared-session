import { parseArgs } from 'node:util';
import { resolve, dirname, isAbsolute } from 'node:path';
import { mkdir, open, rename, lstat, readFile } from 'node:fs/promises';
import { Store } from './store.mjs';
import { createService } from './server.mjs';
import { Client, serverUrl, clientFromProfile } from './client.mjs';
import { CodexReader, exportThread, explicitFile, publishSnapshot } from './codex.mjs';
import { requireThat } from './errors.mjs';

const { values: args, positionals } = parseArgs({ allowPositionals: true, options: {
  db: { type: 'string', default: 'data/shared.sqlite' }, host: { type: 'string', default: '127.0.0.1' }, port: { type: 'string', default: '8787' },
  username: { type: 'string' }, 'password-stdin': { type: 'boolean' }, server: { type: 'string' },
  profile: { type: 'string', default: '.local/client.json' }, thread: { type: 'string' }, share: { type: 'string' },
  to: { type: 'string', multiple: true }, file: { type: 'string', multiple: true }, title: { type: 'string' },
  'request-id': { type: 'string' }, out: { type: 'string' }, interval: { type: 'string', default: '10' },
  'public-url': { type: 'string' },
  'lan-url': { type: 'string', multiple: true },
} });
const command = positionals[0];
const print = value => console.log(JSON.stringify(value, null, 2));

async function password() {
  if (args['password-stdin']) {
    let input = '';
    for await (const chunk of process.stdin) { input += chunk; requireThat(input.length <= 2048, 400, 'password_too_long'); }
    return input.replace(/\r?\n$/, '');
  }
  requireThat(process.stdin.isTTY, 400, 'interactive_password_or_password_stdin_required');
  process.stderr.write('Password (hidden): ');
  return new Promise((resolvePassword, reject) => {
    let value = '';
    process.stdin.setRawMode(true); process.stdin.setEncoding('utf8'); process.stdin.resume();
    const done = () => { process.stdin.setRawMode(false); process.stdin.off('data', input); process.stdin.pause(); process.stderr.write('\n'); };
    const input = chunk => {
      for (const char of chunk) {
        if (char === '\u0003') { done(); reject(new Error('cancelled')); return; }
        if (char === '\r' || char === '\n') { done(); resolvePassword(value); return; }
        if (char === '\u007f' || char === '\b') value = [...value].slice(0, -1).join('');
        else if (char >= ' ') value += char;
        if (value.length > 1024) { done(); reject(new Error('password_too_long')); return; }
      }
    };
    process.stdin.on('data', input);
  });
}
async function saveProfile(profile) {
  const path = resolve(args.profile);
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { const info = await lstat(path); requireThat(info.isFile() && !info.isSymbolicLink(), 400, 'unsafe_profile_path'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = path + `.${process.pid}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(profile)); await handle.sync(); } finally { await handle.close(); }
  await rename(temporary, path);
}
async function snapshot() {
  requireThat(args.thread, 400, 'thread_id_required');
  const reader = new CodexReader();
  try { return await exportThread(reader, args.thread); } finally { reader.close(); }
}
async function publish(shareId, source) {
  const client = await clientFromProfile(args.profile);
  const files = [];
  for (const path of args.file || []) files.push(await explicitFile(path));
  if (!shareId) {
    requireThat(args['request-id'] && args.to?.length, 400, 'request_id_and_recipients_required');
    const share = await client.request('/api/shares', 'POST', { requestId: args['request-id'], title: args.title || source.title,
      sourceThreadId: source.sourceThreadId, recipients: args.to });
    shareId = share.id;
  }
  return publishSnapshot(client, shareId, source, files);
}
async function main() {
  requireThat(positionals.length <= 1, 400, 'unexpected_positional_argument');
  if (command === 'serve') {
    const port = Number(args.port); requireThat(Number.isInteger(port) && port > 0 && port <= 65535);
    const store = new Store(resolve(args.db));
    const server = createService(store, { publicUrl: args['public-url'] || process.env.SHARED_PUBLIC_URL, lanUrls: args['lan-url'] || [] });
    server.on('error', () => { store.close(); console.error('listen_failed'); process.exitCode = 1; });
    server.listen(port, args.host, () => print({ listening: { host: args.host, port } }));
    for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => server.close(() => store.close()));
    return;
  }
  if (command === 'user-add') {
    const secret = await password(); const store = new Store(resolve(args.db));
    try { print(store.createUser(args.username, secret)); } finally { store.close(); } return;
  }
  if (command === 'login') {
    const server = serverUrl(args.server);
    const session = await new Client(server).request('/api/login', 'POST', { username: args.username, password: await password() });
    await saveProfile({ server, ...session }); print({ username: session.username, expiresAt: session.expiresAt, profile: resolve(args.profile) }); return;
  }
  if (command === 'logout') {
    const client = await clientFromProfile(args.profile); await client.request('/api/logout', 'POST'); print({ loggedOut: true }); return;
  }
  if (command === 'grant' || command === 'revoke') {
    requireThat(args.share && args.username, 400, 'share_and_username_required');
    const client = await clientFromProfile(args.profile);
    print(command === 'grant'
      ? await client.request(`/api/shares/${encodeURIComponent(args.share)}/members`, 'POST', { username: args.username })
      : await client.request(`/api/shares/${encodeURIComponent(args.share)}/members/${encodeURIComponent(args.username)}`, 'DELETE'));
    return;
  }
  if (command === 'export') {
    requireThat(args.out && isAbsolute(args.out), 400, 'absolute_preview_path_required');
    const source = await snapshot(); const handle = await open(args.out, 'wx', 0o600);
    try { await handle.writeFile(JSON.stringify(source, null, 2)); } finally { await handle.close(); }
    print({ preview: args.out, messages: source.entries.length, omittedItems: source.omittedItems, pendingTurns: source.pendingTurns }); return;
  }
  if (command === 'publish') {
    // A reviewed export can be used instead of reading a live conversation again.
    const source = args.out ? JSON.parse(await readFile(args.out, 'utf8')) : await snapshot();
    print(await publish(args.share, source)); return;
  }
  if (command === 'sync') {
    requireThat(args.share && !args.to && !args['request-id'], 400, 'existing_share_required');
    const interval = Number(args.interval); requireThat(Number.isFinite(interval) && interval >= 5 && interval <= 3600);
    for (;;) { print(await publish(args.share, await snapshot())); await new Promise(resolveWait => setTimeout(resolveWait, interval * 1000)); }
  }
  console.log('Commands: serve, user-add, login, logout, export, publish, sync, grant, revoke. See README.md.');
  if (command) process.exitCode = 1;
}
main().catch(error => { console.error(error.code || 'operation_failed'); process.exitCode = 1; });
