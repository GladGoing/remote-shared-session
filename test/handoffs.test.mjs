import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { setup, mcp, password } from '../test-support/helpers.mjs';
import { privateJson } from '../src/profile.mjs';
import { Bridge } from '../src/bridge.mjs';
import { HandoffReceiver, CodexWriter } from '../src/handoffs.mjs';

const writerPath = fileURLToPath(new URL('../test-support/codex-writer.mjs', import.meta.url));
async function fixtures(t) {
  const f = await setup(t); const nativePath = join(f.directory, 'native.json');
  await writeFile(nativePath, JSON.stringify({ calls: [], threads: {} }));
  const profile = join(f.directory, 'bob.json');
  await privateJson(profile, { server: f.origin, ...f.store.login('bob', password) });
  const bridge = new Bridge({ profile, server: f.origin });
  const writer = () => {
    const original = process.env.SHARED_FIXTURE_NATIVE; process.env.SHARED_FIXTURE_NATIVE = nativePath;
    try { return new CodexWriter({ binary: process.execPath, args: [writerPath] }); }
    finally { if (original === undefined) delete process.env.SHARED_FIXTURE_NATIVE; else process.env.SHARED_FIXTURE_NATIVE = original; }
  };
  const receiver = new HandoffReceiver(bridge, { writer });
  const aliceProfile = join(f.directory, 'alice.json');
  await privateJson(aliceProfile, { server: f.origin, ...f.store.login('alice', password) });
  const sender = new Bridge({ profile: aliceProfile, server: f.origin });
  const send = (requestId = 'handoff', content = '请修复当前项目的登录校验，并运行现有测试。', recipients = ['bob']) =>
    sender.send({ requestId, title: '登录交接', content, recipients });
  return { ...f, profile, bridge, sender, receiver, send, nativePath, native: async () => JSON.parse(await readFile(nativePath, 'utf8')) };
}

test('Codex 直接发送编辑后的内容与明确附件；不读取原聊天，重复发送幂等，修改后的重试拒绝', async t => {
  const f = await fixtures(t); const profile = join(f.directory, 'alice.json');
  const peer = mcp(t, { SHARED_SESSION_PROFILE: profile, SHARED_SESSION_SERVER: f.origin, SHARED_CODEX_BINARY: 'must-not-read-history', SHARED_NOTIFICATIONS: '0' });
  await peer.rpc('initialize'); const file = join(f.directory, '交接.txt'); await writeFile(file, '附件');
  const args = { requestId: 'direct-send', title: '交接', content: '只发送最后编辑确认的内容。', recipients: ['bob'], filePaths: [file] };
  const sent = await peer.call('shared_session_send', args); assert.equal(sent.status, 'shared');
  assert.equal((await peer.call('shared_session_send', args)).shareId, sent.shareId);
  await assert.rejects(peer.call('shared_session_send', { ...args, content: '已改变' }), { code: 'request_conflict' });
  const bob = f.api('bob'); const received = await bob.request(`/api/shares/${sent.shareId}/events`);
  assert.equal(received.events.length, 2); assert.equal(received.events[0].text, args.content);
  assert.equal((await bob.request('/api/inbox')).items.length, 1);
  await assert.rejects(f.api('charlie').request(`/api/shares/${sent.shareId}/events`), { code: 'share_not_found' });
});

test('收到提醒时创建本机聊天并阅读；后续更新与打开操作复用同一聊天，阅读不标已读', async t => {
  const f = await fixtures(t); const sent = await f.send(); const notices = [];
  const event = { hook_event_name: 'SessionStart', session_id: 'receiver-chat' };
  const emit = async value => notices.push(value);
  const first = await f.receiver.check(event, emit); assert.match(first[0].openUrl, /^codex:\/\/threads\//);
  const opened = await f.receiver.open({ shareId: sent.shareId }); assert.equal(opened.threadId, first[0].threadId);
  await f.receiver.check({ ...event, hook_event_name: 'UserPromptSubmit' }, emit); assert.equal(notices.length, 1);
  await f.sender.send({ requestId: 'update', shareId: sent.shareId, title: '登录交接', content: '还有：校验中文输入。', recipients: ['bob'] });
  const update = await f.receiver.check(event, emit); assert.equal(update[0].threadId, opened.threadId); assert.equal(notices.length, 2);
  const native = await f.native(); assert.equal(Object.keys(native.threads).length, 1);
  const thread = native.threads[opened.threadId]; assert.equal(thread.context.length, 2); assert.equal(thread.turns.length, 2);
  assert.match(thread.turns[0].input[0].text, /仅阅读，不调用工具/);
  assert.match(JSON.stringify(thread.context), /校验中文输入/);
  assert.equal((await f.api('bob').request('/api/inbox')).unreadCount, 2);
  assert.equal(notices[0].hookSpecificOutput.additionalContext.includes(opened.openUrl), true);
});

test('自动工作需明确配置本机工作目录；启动一次，挂起的聊天等空闲后再开始', async t => {
  const f = await fixtures(t); await assert.rejects(f.receiver.configure({ mode: 'work' }), { code: 'auto_work_workspace_required' });
  await f.receiver.configure({ mode: 'work', workspace: f.directory });
  const sent = await f.send(); const event = { hook_event_name: 'UserPromptSubmit', session_id: 'chat' };
  await f.receiver.check(event, async () => {}); await f.receiver.check(event, async () => {});
  let native = await f.native(); const thread = Object.values(native.threads)[0];
  assert.equal(thread.turns.length, 1); assert.equal(thread.cwd, f.directory);
  assert.equal(native.calls.some(call => call.params?.approvalPolicy === 'never' || call.params?.sandbox === 'danger-full-access'), false);
  native.threads[thread.id].status = { type: 'active' }; await writeFile(f.nativePath, JSON.stringify(native));
  await f.api('alice').request(`/api/shares/${sent.shareId}/events`, 'POST', { entries: [{ eventId: 'busy-update', kind: 'message', role: 'user', text: '补充任务' }] });
  await f.receiver.check(event, async () => {}); assert.equal((await f.native()).threads[thread.id].turns.length, 1);
  native = await f.native(); native.threads[thread.id].status = { type: 'idle' }; await writeFile(f.nativePath, JSON.stringify(native));
  await f.receiver.check(event, async () => {}); assert.equal((await f.native()).threads[thread.id].turns.length, 2);
});

test('真实插件 Hook 使用同一配置，在无桌面通知时输出打开链接；重复触发静默，关闭不访问服务', async t => {
  const f = await fixtures(t); await f.send(); const settingsPath = join(f.directory, 'settings.json');
  await privateJson(settingsPath, { server: f.origin, profile: f.profile, notifications: false });
  const hookPath = fileURLToPath(new URL('../plugins/shared-session/hooks/inbox.mjs', import.meta.url));
  const hook = () => new Promise((ok, fail) => {
    const child = spawn(process.execPath, [hookPath], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env,
      SHARED_SESSION_SETTINGS: settingsPath, SHARED_SESSION_PROFILE: f.profile, SHARED_SESSION_SERVER: f.origin,
      SHARED_CODEX_BINARY: process.execPath, SHARED_CODEX_ARGS: JSON.stringify([writerPath]), SHARED_FIXTURE_NATIVE: f.nativePath } });
    let output = ''; child.stdout.on('data', bytes => output += bytes); child.stderr.resume(); child.once('error', fail);
    child.once('close', code => { assert.equal(code, 0); ok(output); });
    child.stdin.end(JSON.stringify({ hook_event_name: 'UserPromptSubmit', session_id: 'hook-chat', prompt: 'PRIVATE-PROMPT' }));
  });
  const notice = JSON.parse(await hook()); assert.match(notice.hookSpecificOutput.additionalContext, /codex:\/\/threads\//);
  assert.equal(JSON.stringify(notice).includes('PRIVATE-PROMPT'), false); assert.equal(await hook(), '');
  await f.receiver.configure({ enabled: false }); let requests = 0; f.server.prependListener('request', () => requests++);
  assert.equal(await hook(), ''); assert.equal(requests, 0);
});

test('已阅读的交接可明确开始工作；重复打开不重复启动，跨账号分别绑定，撤权不导入', async t => {
  const f = await fixtures(t); const sent = await f.send('shared-members', '交接内容', ['bob', 'charlie']);
  const opened = await f.receiver.open({ shareId: sent.shareId });
  await f.receiver.configure({ workspace: f.directory });
  const started = await f.receiver.open({ shareId: sent.shareId, start: true });
  assert.equal(started.threadId, opened.threadId); assert.equal(started.workStatus, 'started');
  await f.receiver.open({ shareId: sent.shareId, start: true });
  assert.equal((await f.native()).threads[opened.threadId].turns.length, 2);
  await privateJson(f.profile, { server: f.origin, ...f.store.login('charlie', password) });
  const other = await f.receiver.open({ shareId: sent.shareId }); assert.notEqual(other.threadId, opened.threadId);
  await f.api('alice').request(`/api/shares/${sent.shareId}/members/charlie`, 'DELETE');
  await assert.rejects(f.receiver.open({ shareId: sent.shareId }), { code: 'share_not_found' });
  await privateJson(f.profile, { server: f.origin, ...f.store.login('bob', password) });
  assert.equal((await f.receiver.open({ shareId: sent.shareId })).threadId, opened.threadId);
});

test('只提醒模式不创建聊天或调用模型，提醒失败后的重试保留原内容', async t => {
  const f = await fixtures(t); await f.send(); await f.receiver.configure({ mode: 'notify' });
  const outputs = []; await f.receiver.check({ hook_event_name: 'UserPromptSubmit', session_id: 'notify-only' }, async value => outputs.push(value));
  assert.equal((await f.native()).calls.length, 0);
  const link = outputs[0].hookSpecificOutput.additionalContext.match(/\]\((codex:\/\/new\?[^\s]+)\)/)[1];
  const prompt = new URL(link).searchParams.get('prompt'); assert.match(prompt, /shared_session_open/); assert.match(prompt, /服务器 http:\/\/127\.0\.0\.1/);
});

test('输出失败不吞提醒；断网或本机宿主不可用保留收件记录，不自动新建重复聊天', async t => {
  const f = await fixtures(t); await f.send(); const event = { hook_event_name: 'SessionStart', session_id: 'failed-output' };
  await assert.rejects(f.receiver.check(event, async () => { throw new Error('output unavailable'); }));
  let count = 0; await f.receiver.check(event, async () => count++); assert.equal(count, 1);
  assert.equal(Object.keys((await f.native()).threads).length, 1);
  const sent = await f.send('lost-create');
  const broken = new HandoffReceiver(f.bridge, { writer: () => ({ ready: Promise.resolve(), close() {}, write: async () => { throw Object.assign(new Error('lost response'), { code: 'app_server_timeout' }); } }) });
  await assert.rejects(broken.open({ shareId: sent.shareId }), { code: 'app_server_timeout' });
  await assert.rejects(f.receiver.open({ shareId: sent.shareId }), { code: 'handoff_creation_uncertain' });
  assert.equal((await f.api('bob').request('/api/inbox')).unreadCount, 2);
});

test('收件与交接内容都完整翻页，同一批多条更新合并为一次阅读；超大上下文拒绝导入', async t => {
  const f = await fixtures(t); const sent = await f.send();
  for (let index = 0; index < 100; index++) f.store.append(f.alice, sent.shareId, {
    entries: [{ eventId: `page-${index}`, kind: 'message', role: 'user', text: `补充 ${index}` }] });
  const outputs = []; const event = { hook_event_name: 'UserPromptSubmit', session_id: 'pages' };
  await f.receiver.check(event, async value => outputs.push(value));
  await f.receiver.check(event, async value => outputs.push(value));
  assert.equal(outputs.length, 1); assert.match(outputs[0].systemMessage, /101 条未读/);
  const thread = Object.values((await f.native()).threads)[0]; assert.equal(thread.turns.length, 1);
  assert.match(JSON.stringify(thread.context), /补充 99/);
  const large = await f.send('large');
  f.store.append(f.alice, large.shareId, { entries: Array.from({ length: 35 }, (_, i) => ({ eventId: `large-${i}`, kind: 'message', role: 'user', text: 'x'.repeat(64000) })) });
  await assert.rejects(f.receiver.open({ shareId: large.shareId }), { code: 'handoff_context_too_large' });
  assert.equal(Object.keys((await f.native()).threads).length, 1);
});
