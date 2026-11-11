import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setup, browser, mcp, password } from '../test-support/helpers.mjs';

test('Codex 完整协议流程：网页登录授权、准备草稿、网页发布、成员接收文件、同步与撤权', async t => {
  const f = await setup(t);
  const sourcePath = join(f.directory, 'source.json'); const filePath = join(f.directory, '交接资料.txt');
  const bytes = Buffer.from('交接文件：包含中文和二进制边界\n\u0000', 'utf8'); await writeFile(filePath, bytes);
  const source = { threadId: 'fixture-thread', title: '项目交接', turns: [
    { id: 't1', status: 'completed', items: [
      { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: '请核对附件中的接口说明。' }] },
      { id: 'a1', type: 'agentMessage', text: '接口说明已经整理。' },
      { id: 'r1', type: 'reasoning', content: ['PRIVATE-REASONING-NOT-SHARED'] },
    ] },
    { id: 't2', status: 'inProgress', items: [{ id: 'u2', type: 'userMessage', content: [{ type: 'text', text: '这轮尚未结束。' }] }] },
  ] };
  await writeFile(sourcePath, JSON.stringify(source));
  const common = { SHARED_SESSION_SERVER: f.origin, SHARED_CODEX_BINARY: process.execPath,
    SHARED_CODEX_ARGS: JSON.stringify([fileURLToPath(new URL('../test-support/codex-reader.mjs', import.meta.url))]), SHARED_FIXTURE_SOURCE: sourcePath };
  const sender = mcp(t, { ...common, SHARED_SESSION_PROFILE: join(f.directory, 'alice.json'), SHARED_SESSION_DOWNLOAD_DIR: join(f.directory, 'alice-files') });
  const receiver = mcp(t, { ...common, SHARED_SESSION_PROFILE: join(f.directory, 'bob.json'), SHARED_SESSION_DOWNLOAD_DIR: join(f.directory, 'bob-files') });
  await sender.rpc('initialize', { protocolVersion: '2025-06-18' }); await receiver.rpc('initialize', { protocolVersion: '2025-06-18' });
  const alice = await browser(f.origin); const bob = await browser(f.origin, 'bob');
  async function connect(peer, web, profile) {
    const link = await peer.call('shared_connect');
    const pending = JSON.parse(await readFile(profile + '.pending.json', 'utf8'));
    assert.equal(JSON.stringify(link).includes(pending.deviceCode), false);
    assert.equal((await peer.call('shared_connection_status')).pending, true);
    await web.request(`/api/device/${link.userCode}`, 'POST', { approved: true });
    const result = await peer.call('shared_connection_status'); assert.equal(result.connected, true);
    const saved = JSON.parse(await readFile(profile, 'utf8'));
    assert.equal(JSON.stringify(result).includes(saved.token), false);
    return result;
  }
  assert.equal((await connect(sender, alice, join(f.directory, 'alice.json'))).username, 'alice');
  assert.equal((await connect(receiver, bob, join(f.directory, 'bob.json'))).username, 'bob');
  const args = { threadId: source.threadId, requestId: 'stable-request', recipients: ['bob'], filePaths: [filePath] };
  const draft = await sender.call('shared_session_prepare', args);
  assert.equal(draft.status, 'draft'); assert.equal(draft.messages, 2); assert.equal(draft.pendingTurns, 1);
  assert.equal(draft.omittedItems, 1); assert.match(draft.reviewUrl, /\/review\?share=/);
  assert.deepEqual((await receiver.call('shared_sessions')).shares, []);
  await assert.rejects(receiver.call('shared_session_read', { shareId: draft.shareId }), { code: 'share_not_found' });
  const before = await alice.request(`/api/shares/${draft.shareId}/events`);
  assert.equal(JSON.stringify(before).includes('PRIVATE-REASONING'), false);
  await alice.request(`/api/shares/${draft.shareId}/publish`, 'POST', { version: before.share.version, revision: before.share.revision });
  const first = await receiver.call('shared_session_read', { shareId: draft.shareId, after: 0, limit: 1 });
  assert.equal(first.events[0].text, '请核对附件中的接口说明。'); assert.equal(first.hasMore, true);
  const rest = await receiver.call('shared_session_read', { shareId: draft.shareId, after: first.nextCursor });
  const file = rest.events.find(event => event.kind === 'file');
  const downloaded = await receiver.call('shared_file_download', { shareId: draft.shareId, fileId: file.fileId });
  assert.deepEqual(await readFile(downloaded.path), bytes);
  assert.equal((await receiver.call('shared_file_download', { shareId: draft.shareId, fileId: file.fileId })).reused, true);
  // Repeating a preparation after publication returns its original receipt, without sending new content.
  source.turns[1].status = 'completed';
  source.turns[1].items.push({ id: 'a2', type: 'agentMessage', text: '新增的协作进展。' });
  await writeFile(sourcePath, JSON.stringify(source));
  assert.equal((await sender.call('shared_session_prepare', args)).status, 'shared');
  assert.equal((await receiver.call('shared_session_read', { shareId: draft.shareId, after: rest.nextCursor })).events.length, 0);
  const synced = await sender.call('shared_session_sync', { threadId: source.threadId, shareId: draft.shareId });
  assert.equal(synced.version, 5);
  const delta = await receiver.call('shared_session_read', { shareId: draft.shareId, after: rest.nextCursor });
  assert.equal(delta.events.length, 2); assert.equal(delta.events[1].text, '新增的协作进展。');
  await assert.rejects(receiver.call('shared_session_sync', { threadId: source.threadId, shareId: draft.shareId }), { code: 'published_owned_share_required' });
  await assert.rejects(sender.call('shared_session_sync', { threadId: 'another-thread', shareId: draft.shareId }), { code: 'source_thread_mismatch' });
  await alice.request(`/api/shares/${draft.shareId}/members/bob`, 'DELETE');
  await assert.rejects(receiver.call('shared_session_read', { shareId: draft.shareId }), { code: 'share_not_found' });
  await assert.rejects(receiver.call('shared_file_download', { shareId: draft.shareId, fileId: file.fileId }), { code: 'share_not_found' });
});

test('连接时保存服务器地址；切换服务重新授权，不向新服务发送原令牌，重启保留选择', async t => {
  const first = await setup(t); const second = await setup(t);
  const profile = join(first.directory, 'connection.json'); const settings = join(first.directory, 'settings.json');
  const original = first.store.login('alice', password);
  await writeFile(profile, JSON.stringify({ server: first.origin, ...original }));
  await writeFile(settings, JSON.stringify({ server: first.origin, notifications: false, downloadDirectory: first.directory }));
  const env = { SHARED_SESSION_PROFILE: profile, SHARED_SESSION_SETTINGS: settings, SHARED_SESSION_DOWNLOAD_DIR: first.directory, SHARED_NOTIFICATIONS: '0' };
  const peer = mcp(t, { ...env, SHARED_SESSION_SERVER: first.origin }); await peer.rpc('initialize');
  assert.equal((await peer.call('shared_connection_status')).server, first.origin);
  await assert.rejects(peer.call('shared_connect', { server: 'http://public.example' }), { code: 'https_required' });
  await assert.rejects(peer.call('shared_connect', { server: 'https://alice:secret@example.com' }), { code: 'invalid_server_url' });
  assert.equal((await peer.call('shared_connection_status')).server, first.origin);
  assert.equal(JSON.parse(await readFile(settings, 'utf8')).server, first.origin);
  const receivedTokens = [];
  second.server.prependListener('request', request => { if (request.headers.authorization) receivedTokens.push(request.headers.authorization); });
  const link = await peer.call('shared_connect', { server: ` ${second.origin}/ ` });
  assert.equal(link.pending, true); assert.equal(link.server, second.origin);
  assert.deepEqual(JSON.parse(await readFile(settings, 'utf8')), { server: second.origin, notifications: false, downloadDirectory: first.directory });
  assert.deepEqual(receivedTokens, []);
  const web = await browser(second.origin, 'bob');
  await web.request(`/api/device/${link.userCode}`, 'POST', { approved: true });
  const connected = await peer.call('shared_connection_status');
  assert.equal(connected.username, 'bob'); assert.equal(connected.server, second.origin);
  const restarted = mcp(t, { ...env, SHARED_SESSION_SERVER: '' }); await restarted.rpc('initialize');
  assert.equal((await restarted.call('shared_connection_status')).username, 'bob');
  assert.equal(receivedTokens.includes(`Bearer ${original.token}`), false);
});
