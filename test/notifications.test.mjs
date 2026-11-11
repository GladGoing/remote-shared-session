import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { setup, browser, mcp } from '../test-support/helpers.mjs';
import { NotificationWatcher, inboxStream } from '../src/notifications.mjs';
import { privateJson, optionalJson } from '../src/profile.mjs';

const message = (id, text = id) => ({ entries: [{ eventId: id, kind: 'message', role: 'assistant', text }] });
async function publish(f, requestId = 'notify-share') {
  const alice = f.api('alice');
  const draft = await alice.request('/api/drafts', 'POST', { requestId, title: '共享提醒', sourceThreadId: requestId, recipients: ['bob'] });
  const { version } = await alice.request(`/api/shares/${draft.id}/events`, 'POST', message('first'));
  const sealed = await alice.request(`/api/shares/${draft.id}/seal`, 'POST', { version });
  return { alice, draft, sealed, finish: () => alice.request(`/api/shares/${draft.id}/publish`, 'POST', { version, revision: sealed.revision }) };
}
async function until(predicate) {
  for (let i = 0; i < 100; i++) { if (await predicate()) return; await delay(50); }
  assert.fail('notification did not arrive');
}

test('收件箱只向接收成员记录发布和更新；重试不重复，已读隔离，撤权删除，重新授权可补收', async t => {
  const f = await setup(t); const p = await publish(f); const bob = f.api('bob');
  assert.equal((await bob.request('/api/inbox')).unreadCount, 0);
  await p.finish(); await p.finish();
  const first = await bob.request('/api/inbox'); assert.equal(first.items.length, 1); assert.equal(first.unreadCount, 1);
  assert.equal((await p.alice.request('/api/inbox')).items.length, 0);
  assert.equal((await f.api('charlie').request('/api/inbox')).items.length, 0);
  await f.api('charlie').request('/api/inbox/read', 'POST', { ids: [first.items[0].id] });
  assert.equal((await bob.request('/api/inbox')).unreadCount, 1);
  await bob.request('/api/inbox/read', 'POST', { ids: [first.items[0].id] });
  assert.equal((await bob.request('/api/inbox')).unreadCount, 0);
  await p.alice.request(`/api/shares/${p.draft.id}/events`, 'POST', message('next'));
  await p.alice.request(`/api/shares/${p.draft.id}/events`, 'POST', message('next'));
  const delta = await bob.request(`/api/inbox?after=${first.nextCursor}&limit=1`);
  assert.equal(delta.items.length, 1); assert.equal(delta.items[0].kind, 'updated');
  await p.alice.request(`/api/shares/${p.draft.id}/members/bob`, 'DELETE');
  assert.equal((await bob.request('/api/inbox')).items.length, 0);
  await p.alice.request(`/api/shares/${p.draft.id}/members`, 'POST', { username: 'bob' });
  assert.equal((await bob.request(`/api/inbox?after=${delta.nextCursor}`)).items[0].kind, 'shared');
});

test('真实 SSE 长连接推送新增记录，携带游标断线补收；停用账号使已打开的流失效', async t => {
  const f = await setup(t); const p = await publish(f); const bob = f.api('bob'); const control = new AbortController();
  t.after(() => control.abort()); const stream = inboxStream(bob, 0, control.signal);
  assert.equal((await stream.next()).value.items.length, 0);
  await p.finish(); const first = (await stream.next()).value; assert.equal(first.items.length, 1);
  control.abort(); await stream.return().catch(error => assert.equal(error.name, 'AbortError'));
  await p.alice.request(`/api/shares/${p.draft.id}/events`, 'POST', message('offline-update'));
  const resumedControl = new AbortController(); t.after(() => resumedControl.abort());
  const resumed = inboxStream(bob, first.nextCursor, resumedControl.signal);
  assert.equal((await resumed.next()).value.items[0].kind, 'updated');
  await p.alice.request('/api/users/bob', 'PATCH', { enabled: false });
  await assert.rejects(resumed.next(), { code: 'authentication_required' });
});

test('插件提醒保存独立账号游标，重启不重复通知；失败不丢记录，关闭后停止连接', async t => {
  const f = await setup(t); const p = await publish(f); await p.finish(); const bob = f.api('bob');
  const profile = join(f.directory, 'watcher.json'); const notices = []; let fail = true;
  const watcher = new NotificationWatcher({ profile, server: f.origin, client: async () => bob }, {
    retryMs: 50, notify: async url => { if (fail) { fail = false; throw new Error('fixture delivery failure'); } notices.push(url); },
  });
  t.after(() => watcher.stop()); await watcher.configure(true);
  await until(async () => notices.length === 1 && (await optionalJson(profile + '.notifications.json'))?.cursor > 0);
  assert.equal(notices[0], f.origin + '/inbox'); await watcher.stop();
  await watcher.start(); await delay(150); assert.equal(notices.length, 1);
  await p.alice.request(`/api/shares/${p.draft.id}/events`, 'POST', message('watch-update'));
  await until(() => notices.length === 2);
  await watcher.configure(false); assert.equal((await watcher.status()).running, false);
  await p.alice.request(`/api/shares/${p.draft.id}/events`, 'POST', message('after-stop'));
  await delay(150); assert.equal(notices.length, 2);
});

test('真实 MCP 提供收件箱、已读和提醒设置，不返回登录凭据', async t => {
  const f = await setup(t); const p = await publish(f); await p.finish();
  const profile = join(f.directory, 'bob-mcp.json'); const login = f.store.login('bob', 'local-fixture-password-2026');
  await privateJson(profile, { server: f.origin, token: login.token, expiresAt: login.expiresAt });
  const peer = mcp(t, { SHARED_SESSION_PROFILE: profile, SHARED_SESSION_SERVER: f.origin, SHARED_NOTIFICATIONS: '0' });
  await peer.rpc('initialize'); const inbox = await peer.call('shared_inbox');
  assert.equal(inbox.unreadCount, 1); assert.equal(JSON.stringify(inbox).includes(login.token), false);
  await peer.call('shared_inbox_read', { ids: [inbox.items[0].id] });
  assert.equal((await peer.call('shared_inbox')).unreadCount, 0);
  assert.equal((await peer.call('shared_notifications', { enabled: false })).enabled, false);
  await assert.rejects(peer.call('shared_inbox', { after: -1 }), { code: 'invalid_request' });
});
