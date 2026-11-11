import test from 'node:test';
import assert from 'node:assert/strict';
import { DatabaseSync } from 'node:sqlite';
import { scryptSync } from 'node:crypto';
import { get, request as httpRequest } from 'node:http';
import { join } from 'node:path';
import { setup, browser, password } from '../test-support/helpers.mjs';
import { Store, sha256 } from '../src/store.mjs';
import { Client } from '../src/client.mjs';
import { createService } from '../src/server.mjs';

test('网页登录使用 HttpOnly 会话；写操作校验 CSRF、Origin 与 Host；会话类型不互通', async t => {
  const f = await setup(t); const web = await browser(f.origin);
  assert.match(web.cookie, /HttpOnly/); assert.match(web.cookie, /SameSite=Strict/);
  assert.equal(web.result.token, undefined); assert.equal(web.result.user.role, 'admin');
  const asset = await fetch(f.origin + '/'); assert.equal(asset.status, 200); assert.match(await asset.text(), /登录共享空间/);
  assert.match(asset.headers.get('content-security-policy'), /script-src 'self'/);
  await assert.rejects(web.request('/api/users', 'POST', { username: 'new', password }, { 'X-CSRF-Token': '' }), { status: 403, code: 'csrf_required' });
  await assert.rejects(web.request('/api/users', 'POST', { username: 'new', password }, { Origin: 'https://evil.example' }), { status: 403, code: 'invalid_origin' });
  const invalidHost = await new Promise((ok, fail) => {
    get(f.origin + '/healthz', { headers: { Host: 'rebinding.example' } }, response => { response.resume(); ok(response.statusCode); }).once('error', fail);
  });
  assert.equal(invalidHost, 403);
  const apiToken = f.store.login('alice', password).token;
  const asCookie = await fetch(f.origin + '/api/me', { headers: { Cookie: `shared_session=${apiToken}` } }); assert.equal(asCookie.status, 401);
  const webToken = web.cookie.split(';')[0].split('=')[1];
  const asBearer = await fetch(f.origin + '/api/me', { headers: { Authorization: `Bearer ${webToken}` } }); assert.equal(asBearer.status, 401);
  const members = await web.request('/api/users'); assert.equal(members.members.length, 3);
  assert.equal(JSON.stringify(members).includes('hash'), false);
  await web.request('/api/web/logout', 'POST'); await assert.rejects(web.request('/api/me'), { status: 401 });
});

test('显式配置的局域网入口支持登录和插件授权，保留本机入口并拒绝其他 Host 和跨域请求', async t => {
  const lan = 'http://192.168.1.10:8787'; const host = new URL(lan).host;
  const f = await setup(t, { lanUrls: [lan] });
  const request = (path, { method = 'GET', body, headers = {} } = {}) => new Promise((ok, fail) => {
    const req = httpRequest(f.origin + path, { method, headers: { Host: host, Origin: lan, ...(body ? { 'Content-Type': 'application/json' } : {}), ...headers } }, response => {
      let text = ''; response.setEncoding('utf8'); response.on('data', chunk => { text += chunk; });
      response.on('end', () => ok({ status: response.statusCode, headers: response.headers, body: JSON.parse(text) }));
    });
    req.once('error', fail); req.end(body ? JSON.stringify(body) : undefined);
  });
  assert.equal((await request('/healthz')).status, 200);
  assert.equal((await fetch(f.origin + '/healthz')).status, 200);
  assert.equal((await request('/healthz', { headers: { Host: '192.168.1.11:8787' } })).status, 403);
  assert.equal((await request('/api/web/session', { headers: { Origin: 'http://untrusted.example' } })).status, 403);
  const login = await request('/api/web/login', { method: 'POST', body: { username: 'alice', password } });
  assert.equal(login.status, 200); assert.equal(login.body.user.username, 'alice');
  const cookie = login.headers['set-cookie'][0]; assert.doesNotMatch(cookie, /; Secure/);
  const device = await request('/api/device', { method: 'POST', body: {} });
  assert.equal(device.status, 201); assert.ok(device.body.verificationUri.startsWith(lan + '/connect?code='));
  const headers = { Cookie: cookie.split(';')[0], 'X-CSRF-Token': login.body.csrfToken };
  assert.equal((await request(`/api/device/${device.body.userCode}`, { method: 'POST', headers, body: { approved: true } })).status, 200);
  assert.equal((await request('/api/device/poll', { method: 'POST', body: { deviceCode: device.body.deviceCode } })).body.username, 'alice');
  assert.throws(() => createService(f.store, { lanUrls: ['http://203.0.113.10:8787'] }), { code: 'https_required' });
});

test('客户端仅接受显式的私有局域网 IP 明文地址，公网和域名仍要求 HTTPS', () => {
  for (const ip of ['192.168.1.10', '10.0.0.2', '172.16.0.2', '172.31.255.254']) assert.equal(new Client(`http://${ip}:8787`).url, `http://${ip}:8787`);
  for (const host of ['172.32.0.2', '203.0.113.10', '198.18.0.1', '0.0.0.0', '192.168.1.10.example.com']) assert.throws(() => new Client(`http://${host}:8787`), { code: 'https_required' });
});

test('成员管理限制管理员；停用、重置密码立即撤销旧登录；最后一个管理员受到保护', async t => {
  const f = await setup(t); const admin = await browser(f.origin); const bob = await browser(f.origin, 'bob'); const bobApi = f.api('bob');
  await assert.rejects(bob.request('/api/users'), { status: 403 });
  await assert.rejects(bob.request('/api/users', 'POST', { username: 'hacker', password, role: 'admin' }), { status: 403 });
  await assert.rejects(admin.request('/api/users/alice', 'PATCH', { role: 'member' }), { status: 409, code: 'last_admin_required' });
  const created = await admin.request('/api/users', 'POST', { username: 'dave', password, role: 'member' }); assert.equal(created.role, 'member');
  await admin.request('/api/users/bob', 'PATCH', { enabled: false });
  await assert.rejects(bob.request('/api/me'), { status: 401 }); await assert.rejects(bobApi.request('/api/shares'), { status: 401 });
  await assert.rejects(browser(f.origin, 'bob'), { status: 401 });
  await admin.request('/api/users/bob', 'PATCH', { enabled: true });
  const newBob = await browser(f.origin, 'bob');
  await admin.request('/api/users/bob/password', 'POST', { password: 'a-new-fixture-password' });
  await assert.rejects(newBob.request('/api/me'), { status: 401 }); await assert.rejects(browser(f.origin, 'bob'), { status: 401 });
  assert.equal((await browser(f.origin, 'bob', 'a-new-fixture-password')).result.user.username, 'bob');
  await admin.request('/api/users/dave', 'PATCH', { role: 'admin' });
  await admin.request('/api/users/alice', 'PATCH', { role: 'member' });
  await assert.rejects(admin.request('/api/users'), { status: 403 });
});

test('草稿上传完成前不可发布；确认绑定内容和接收成员版本；发布前成员看不到文件和文本', async t => {
  const f = await setup(t); const owner = f.api('alice'); const bob = f.api('bob'); const web = await browser(f.origin);
  const draft = await owner.request('/api/drafts', 'POST', { requestId: 'draft-1', title: '交接', sourceThreadId: 'thread', recipients: ['bob'] });
  assert.equal(draft.status, 'uploading');
  await owner.request(`/api/shares/${draft.id}/events`, 'POST', { entries: [
    { eventId: 'u1', kind: 'message', role: 'user', text: '<script>window.bad=1</script>' },
    { eventId: 'f1', kind: 'file', name: 'handoff.txt', base64: 'YQ==' },
  ] });
  const read = await owner.request(`/api/shares/${draft.id}/events`); const fileId = read.events[1].fileId;
  assert.deepEqual((await bob.request('/api/shares')).shares, []);
  await assert.rejects(bob.request(`/api/shares/${draft.id}/events`), { status: 404 });
  await assert.rejects(bob.request(`/api/shares/${draft.id}/files/${fileId}`), { status: 404 });
  await assert.rejects(web.request(`/api/shares/${draft.id}/publish`, 'POST', { version: 2, revision: 0 }), { status: 409 });
  const sealed = await owner.request(`/api/shares/${draft.id}/seal`, 'POST', { version: 2 }); assert.equal(sealed.status, 'draft');
  await web.request(`/api/shares/${draft.id}/members`, 'POST', { username: 'charlie' });
  await assert.rejects(web.request(`/api/shares/${draft.id}/publish`, 'POST', { version: 2, revision: sealed.revision }), { status: 409 });
  const current = (await owner.request(`/api/shares/${draft.id}/events`)).share;
  assert.equal((await web.request(`/api/shares/${draft.id}/publish`, 'POST', { version: current.version, revision: current.revision })).status, 'shared');
  assert.equal((await bob.request(`/api/shares/${draft.id}/events`)).events.length, 2);
  await assert.rejects(bob.request(`/api/shares/${draft.id}/members`), { status: 404 });
});

test('网页授权需要登录与确认，设备密钥不在链接中；丢失响应可恢复且退出后不重新发令牌', async t => {
  let now = Date.now(); const f = await setup(t, { now: () => now }); const anon = new (f.api('alice').constructor)(f.origin);
  const device = await anon.request('/api/device', 'POST', {});
  assert.equal(device.verificationUri.includes(device.deviceCode), false);
  assert.equal((await anon.request('/api/device/poll', 'POST', { deviceCode: device.deviceCode })).status, 'pending');
  const web = await browser(f.origin);
  await assert.rejects(web.request(`/api/device/${device.userCode}`, 'POST', { approved: true }, { 'X-CSRF-Token': '' }), { status: 403 });
  await web.request(`/api/device/${device.userCode}`, 'POST', { approved: true });
  const first = await anon.request('/api/device/poll', 'POST', { deviceCode: device.deviceCode });
  assert.equal(first.username, 'alice');
  assert.equal((await anon.request('/api/device/poll', 'POST', { deviceCode: device.deviceCode })).token, first.token);
  const issued = new (anon.constructor)(f.origin, first.token); await issued.request('/api/logout', 'POST');
  await assert.rejects(anon.request('/api/device/poll', 'POST', { deviceCode: device.deviceCode }), { status: 410 });
  const denied = await anon.request('/api/device', 'POST', {});
  await web.request(`/api/device/${denied.userCode}`, 'POST', { approved: false });
  await assert.rejects(anon.request('/api/device/poll', 'POST', { deviceCode: denied.deviceCode }), { status: 403 });
  const expires = await anon.request('/api/device', 'POST', {}); now += 600001;
  await assert.rejects(anon.request('/api/device/poll', 'POST', { deviceCode: expires.deviceCode }), { status: 404 });
});

test('0.1 数据库升级保留原有账号、令牌、共享和动作编号；只在首次升级指定首个管理员', async t => {
  const f = await setup(t); const path = join(f.directory, 'old.sqlite'); const db = new DatabaseSync(path);
  db.exec(`CREATE TABLE users(id TEXT PRIMARY KEY,username TEXT UNIQUE NOT NULL,salt TEXT NOT NULL,hash TEXT NOT NULL);
    CREATE TABLE tokens(hash TEXT PRIMARY KEY,user_id TEXT,expires INTEGER NOT NULL);
    CREATE TABLE shares(id TEXT PRIMARY KEY,owner_id TEXT,title TEXT,source_thread_id TEXT,request_id TEXT,creation_hash TEXT,version INTEGER DEFAULT 0,UNIQUE(owner_id,request_id));
    CREATE TABLE members(share_id TEXT,user_id TEXT,PRIMARY KEY(share_id,user_id));
    CREATE TABLE events(share_id TEXT,seq INTEGER,event_id TEXT,digest TEXT,kind TEXT,payload TEXT,created_at INTEGER,PRIMARY KEY(share_id,seq),UNIQUE(share_id,event_id));
    CREATE TABLE files(id TEXT PRIMARY KEY,share_id TEXT,name TEXT,sha256 TEXT,bytes BLOB);`);
  db.prepare('INSERT INTO users VALUES(?,?,?,?)').run('old-user', 'old', 'old-salt', scryptSync(password, 'old-salt', 64).toString('hex'));
  db.prepare('INSERT INTO tokens VALUES(?,?,?)').run(sha256('old-token'), 'old-user', Date.now() + 60000);
  const input = { requestId: 'old-request', title: '旧共享', sourceThreadId: 'old-thread', recipients: ['old'] };
  const digest = sha256(JSON.stringify({ title: input.title, sourceThreadId: input.sourceThreadId, recipients: input.recipients }));
  db.prepare('INSERT INTO shares VALUES(?,?,?,?,?,?,?)').run('old-share', 'old-user', input.title, input.sourceThreadId, input.requestId, digest, 1);
  db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run('old-share', 1, 'old-event', 'unchanged', 'message', JSON.stringify({ role: 'user', text: '历史内容' }), 1);
  db.close();
  let upgraded = new Store(path);
  const user = upgraded.authenticate('old-token'); assert.equal(user.role, 'admin');
  assert.equal(upgraded.read(user, 'old-share').events[0].text, '历史内容');
  assert.equal(upgraded.createShare(user, input).id, 'old-share');
  upgraded.createUser('another', password, 'admin'); upgraded.updateUser(user, 'old', { role: 'member' });
  upgraded.close(); upgraded = new Store(path);
  assert.equal(upgraded.authenticate('old-token').role, 'member'); upgraded.close();
});
