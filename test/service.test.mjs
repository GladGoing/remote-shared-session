import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm, readFile, writeFile } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { tmpdir } from 'node:os';
import { resolve, join, dirname, basename } from 'node:path';
import { Store, sha256 } from '../src/store.mjs';
import { createService } from '../src/server.mjs';
import { Client } from '../src/client.mjs';
import { publishSnapshot } from '../src/codex.mjs';

const secret = 'fixture-password-only-2026';
async function fixture(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shared-session-test-'));
  const db = join(directory, 'test.sqlite');
  const store = new Store(db, options);
  for (const name of ['alice', 'bob', 'charlie']) store.createUser(name, secret);
  const server = createService(store, options);
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const url = `http://127.0.0.1:${server.address().port}`;
  const clients = {};
  for (const name of ['alice', 'bob', 'charlie']) clients[name] = new Client(url, store.login(name, secret).token);
  t.after(async () => {
    server.closeAllConnections(); await new Promise(ok => server.close(ok)); store.close();
    assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('shared-session-test-'));
    await rm(directory, { recursive: true, force: true });
  });
  return { directory, db, store, server, url, ...clients };
}
const makeShare = (client, extra = {}) => client.request('/api/shares', 'POST', {
  requestId: 'share-request-1', sourceThreadId: 'thread-1', title: '接口设计', recipients: ['bob'], ...extra,
});
const message = (eventId, text = '需要实现登录接口。') => ({ eventId, kind: 'message', role: 'user', text });
const append = (client, id, entries) => client.request(`/api/shares/${id}/events`, 'POST', { entries });

test('完整闭环：文本、二进制文件、增量、下载校验、成员隔离与撤权', async t => {
  const f = await fixture(t);
  const share = await makeShare(f.alice);
  const bytes = Buffer.from([0, 1, 255, 12, 88]);
  await append(f.alice, share.id, [message('m1'), { eventId: 'f1', kind: 'file', name: '接口.bin', base64: bytes.toString('base64') }]);
  assert.equal((await f.bob.request('/api/shares')).shares.length, 1);
  assert.deepEqual((await f.charlie.request('/api/shares')).shares, []);
  await assert.rejects(f.charlie.request(`/api/shares/${share.id}/events`), { status: 404 });
  const page = await f.bob.request(`/api/shares/${share.id}/events?limit=1`);
  assert.equal(page.events[0].text, '需要实现登录接口。');
  assert.equal(page.hasMore, true);
  const next = await f.bob.request(`/api/shares/${share.id}/events?after=${page.nextCursor}`);
  const fileId = next.events[0].fileId;
  const download = await f.bob.download(share.id, fileId, join(f.directory, 'downloads'));
  assert.deepEqual(await readFile(download.path), bytes);
  assert.equal(download.sha256, sha256(bytes));
  assert.equal((await f.bob.download(share.id, fileId, join(f.directory, 'downloads'))).reused, true);
  await writeFile(download.path, 'locally changed');
  await assert.rejects(f.bob.download(share.id, fileId, join(f.directory, 'downloads')), { code: 'download_destination_exists' });
  await append(f.alice, share.id, [message('m2', '新增第二轮内容')]);
  const delta = await f.bob.request(`/api/shares/${share.id}/events?after=${next.nextCursor}`);
  assert.equal(delta.events.length, 1); assert.equal(delta.events[0].text, '新增第二轮内容');
  await assert.rejects(append(f.bob, share.id, [message('foreign')]), { status: 404 });
  await assert.rejects(f.bob.request(`/api/shares/${share.id}/members`, 'POST', { username: 'charlie' }), { status: 404 });
  await f.alice.request(`/api/shares/${share.id}/members/bob`, 'DELETE');
  await assert.rejects(f.bob.request(`/api/shares/${share.id}/events?after=2`), { status: 404 });
  await assert.rejects(f.bob.request(`/api/shares/${share.id}/files/${fileId}`), { status: 404 });
  assert.deepEqual((await f.bob.request('/api/shares')).shares, []);
});

test('创建与追加可安全重试；编号冲突整批回滚', async t => {
  const f = await fixture(t); const share = await makeShare(f.alice);
  assert.equal((await makeShare(f.alice)).id, share.id);
  await assert.rejects(makeShare(f.alice, { recipients: ['charlie'] }), { status: 409 });
  const first = await append(f.alice, share.id, [message('m1')]);
  assert.deepEqual(await append(f.alice, share.id, [message('m1')]), first);
  await assert.rejects(append(f.alice, share.id, [message('m2'), message('m1', 'changed')]), { status: 409 });
  const result = await f.bob.request(`/api/shares/${share.id}/events`);
  assert.equal(result.events.length, 1); assert.equal(result.share.version, 1);
});

test('并发追加得到连续版本，重复提交不增加版本', async t => {
  const f = await fixture(t); const share = await makeShare(f.alice);
  await Promise.all(Array.from({ length: 10 }, (_, index) => append(f.alice, share.id, [message(`m${index}`)])));
  await Promise.all(Array.from({ length: 5 }, () => append(f.alice, share.id, [message('m0')])));
  const result = await f.bob.request(`/api/shares/${share.id}/events`);
  assert.deepEqual(result.events.map(event => event.seq), Array.from({ length: 10 }, (_, i) => i + 1));
});

test('非法角色、文件名、编码和游标被拒绝；不能跨共享读取文件', async t => {
  const f = await fixture(t); const share = await makeShare(f.alice);
  for (const entry of [
    { ...message('bad-role'), role: 'system' },
    { eventId: 'bad-name', kind: 'file', name: '../secret.txt', base64: 'YQ==' },
    { eventId: 'bad-base64', kind: 'file', name: 'ok.txt', base64: 'not-base64' },
    { ...message('unknown-field'), privateData: true },
  ]) await assert.rejects(append(f.alice, share.id, [entry]), { status: 400 });
  await assert.rejects(f.bob.request(`/api/shares/${share.id}/events?after=-1`), { status: 400 });
  await assert.rejects(f.bob.request(`/api/shares/${share.id}/events?after=0.5`), { status: 400 });
  await append(f.alice, share.id, [{ eventId: 'file', kind: 'file', name: 'a.txt', base64: 'YQ==' }]);
  const fileId = (await f.bob.request(`/api/shares/${share.id}/events`)).events[0].fileId;
  const other = await makeShare(f.alice, { requestId: 'other' });
  await assert.rejects(f.bob.request(`/api/shares/${other.id}/files/${fileId}`), { status: 404 });
});

test('登录错误、退出、浏览器来源及限流', async t => {
  const f = await fixture(t, { loginLimit: 2 });
  const anonymous = new Client(f.url);
  await assert.rejects(anonymous.request('/api/shares'), { status: 401 });
  await assert.rejects(anonymous.request('/api/login', 'POST', { username: 'alice', password: 'incorrect' }), { status: 401 });
  await assert.rejects(anonymous.request('/api/login', 'POST', { username: 'nobody', password: secret }), { status: 401 });
  await assert.rejects(anonymous.request('/api/login', 'POST', { username: 'alice', password: 'incorrect-again' }), { status: 401 });
  await assert.rejects(anonymous.request('/api/login', 'POST', { username: 'alice', password: secret }), { status: 429 });
  const origin = await fetch(f.url + '/healthz', { headers: { Origin: 'https://untrusted.example' } });
  assert.equal(origin.status, 403);
  await f.alice.request('/api/logout', 'POST');
  await assert.rejects(f.alice.request('/api/shares'), { status: 401 });
});

test('真实 CLI 密码经 stdin 登录，令牌文件可供 MCP 使用且输出不泄露凭据', async t => {
  const f = await fixture(t); const profile = join(f.directory, 'cli-profile.json');
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/cli.mjs', import.meta.url)),
    'login', '--server', f.url, '--username', 'alice', '--profile', profile, '--password-stdin'],
  { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
  let output = ''; let errors = '';
  child.stdout.setEncoding('utf8'); child.stderr.setEncoding('utf8');
  child.stdout.on('data', data => { output += data; }); child.stderr.on('data', data => { errors += data; });
  child.stdin.end(secret + '\n');
  const code = await new Promise((ok, fail) => { child.once('error', fail); child.once('close', ok); });
  assert.equal(code, 0, errors);
  const saved = JSON.parse(await readFile(profile, 'utf8'));
  assert.equal(saved.username, 'alice'); assert.ok(saved.token);
  assert.equal((await new Client(f.url, saved.token).request('/api/shares')).shares.length, 0);
  assert.equal(output.includes(secret), false); assert.equal(output.includes(saved.token), false);
  assert.equal(JSON.stringify(saved).includes(secret), false);
});

test('独立存储连接保留共享与授权；到期登录失效', async t => {
  let now = 1000000;
  const f = await fixture(t, { now: () => now, tokenTtlMs: 1000 });
  const share = await makeShare(f.alice);
  await append(f.alice, share.id, [message('persisted')]);
  const second = new Store(f.db, { now: () => now });
  try {
    const bob = second.authenticate(f.bob.token);
    assert.equal(second.read(bob, share.id).events[0].text, '需要实现登录接口。');
    now += 1001;
    assert.throws(() => second.authenticate(f.bob.token), { status: 401 });
  } finally { second.close(); }
});

test('真实关闭并重开 SQLite 后，文本和文件仍可读取', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'shared-session-test-'));
  let store = new Store(join(directory, 'persist.sqlite'));
  try {
    store.createUser('alice', secret); store.createUser('bob', secret);
    const aliceToken = store.login('alice', secret).token;
    const bobToken = store.login('bob', secret).token;
    const alice = store.authenticate(aliceToken);
    const share = store.createShare(alice, { requestId: 'persist', title: 'persist', sourceThreadId: 't', recipients: ['bob'] });
    store.append(alice, share.id, { entries: [message('m1'), { eventId: 'f1', kind: 'file', name: 'a.txt', base64: 'YQ==' }] });
    store.close(); store = new Store(join(directory, 'persist.sqlite'));
    const bob = store.authenticate(bobToken);
    const events = store.read(bob, share.id).events;
    assert.equal(events.length, 2);
    assert.equal(store.file(bob, share.id, events[1].fileId).base64, 'YQ==');
  } finally {
    store.close(); assert.equal(resolve(dirname(directory)), resolve(tmpdir()));
    assert.ok(basename(directory).startsWith('shared-session-test-'));
    await rm(directory, { recursive: true, force: true });
  }
});

test('发布与后续同步复用原会话，拒绝切换来源', async t => {
  const f = await fixture(t); const share = await makeShare(f.alice);
  const snapshot = { sourceThreadId: 'thread-1', entries: [message('m1')], omittedItems: 2, pendingTurns: 1 };
  assert.equal((await publishSnapshot(f.alice, share.id, snapshot)).version, 1);
  assert.equal((await publishSnapshot(f.alice, share.id, snapshot)).version, 1);
  snapshot.entries.push(message('m2', '后续内容'));
  assert.equal((await publishSnapshot(f.alice, share.id, snapshot)).version, 2);
  await assert.rejects(publishSnapshot(f.alice, share.id, { ...snapshot, sourceThreadId: 'other' }), { code: 'source_thread_mismatch' });
});

test('真实 MCP 子进程：发现工具、读取增量、下载文件并拒绝撤权后的访问', async t => {
  const f = await fixture(t); const share = await makeShare(f.alice);
  await append(f.alice, share.id, [message('m1'), { eventId: 'f1', kind: 'file', name: 'a.txt', base64: 'YQ==' }]);
  const profile = join(f.directory, 'bob.json');
  await writeFile(profile, JSON.stringify({ server: f.url, token: f.bob.token, expiresAt: Date.now() + 60000 }), { mode: 0o600 });
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.mjs', import.meta.url))], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'],
    env: { ...process.env, SHARED_SESSION_PROFILE: profile, SHARED_SESSION_DOWNLOAD_DIR: join(f.directory, 'mcp-downloads') },
  });
  const waiting = new Map(); let id = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { const response = JSON.parse(line); waiting.get(response.id)?.(response); });
  child.stderr.on('data', () => {});
  t.after(() => { child.kill(); lines.close(); });
  const rpc = (method, params = {}) => new Promise((ok, fail) => {
    const current = ++id; const timeout = setTimeout(() => fail(new Error('MCP timeout')), 10000);
    waiting.set(current, response => { clearTimeout(timeout); waiting.delete(current); ok(response); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method, params }) + '\n');
  });
  assert.equal((await rpc('initialize', { protocolVersion: '2025-06-18' })).result.protocolVersion, '2025-06-18');
  assert.equal((await rpc('tools/list')).result.tools.length, 10);
  const call = (name, args = {}) => rpc('tools/call', { name, arguments: args });
  const list = await call('shared_sessions');
  assert.equal(JSON.parse(list.result.content[0].text).shares[0].id, share.id);
  const page = JSON.parse((await call('shared_session_read', { shareId: share.id, after: 0 })).result.content[0].text);
  const fileId = page.events[1].fileId;
  const download = JSON.parse((await call('shared_file_download', { shareId: share.id, fileId })).result.content[0].text);
  assert.equal(await readFile(download.path, 'utf8'), 'a');
  await append(f.alice, share.id, [message('m2', 'MCP 后续更新')]);
  const delta = JSON.parse((await call('shared_session_read', { shareId: share.id, after: page.nextCursor })).result.content[0].text);
  assert.equal(delta.events[0].text, 'MCP 后续更新');
  await f.alice.request(`/api/shares/${share.id}/members/bob`, 'DELETE');
  assert.equal((await call('shared_session_read', { shareId: share.id })).result.isError, true);
  assert.equal((await call('shared_file_download', { shareId: share.id, fileId })).result.isError, true);
});

test('客户端拒绝向公网明文 HTTP 或带内嵌口令的地址发送认证', () => {
  assert.throws(() => new Client('http://example.com'), { code: 'https_required' });
  assert.throws(() => new Client('https://user:password@example.com'), { code: 'invalid_server_url' });
});
