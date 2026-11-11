import test from 'node:test';
import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createConnection } from 'node:net';
import { randomUUID } from 'node:crypto';
import { join } from 'node:path';
import { setup, mcp, password } from '../test-support/helpers.mjs';
import { socketServer, nativeSocket } from '../test-support/codex-socket.mjs';
import { CodexWriter } from '../src/handoffs.mjs';
import { CodexSocket } from '../src/codex-socket.mjs';
import { privateJson } from '../src/profile.mjs';
import { writeFile, readFile } from 'node:fs/promises';

test('WebSocket Upgrade 后等待 initialize 成功，再发 initialized 和业务帧；按编号匹配乱序响应', async t => {
  const f = await setup(t); const frames = []; let releaseInitialize;
  const initializedRequest = new Promise(ok => { releaseInitialize = ok; });
  const { socketPath, server } = await socketServer(t, f.directory, socket => {
    socket.on('message', (data, binary) => {
      assert.equal(binary, false); assert.equal(data.toString().endsWith('\n'), false);
      const message = JSON.parse(data.toString()); frames.push(message);
      if (message.method === 'initialize') { releaseInitialize(socket); return; }
      if (message.method === 'initialized') return;
      if (frames.filter(frame => frame.method === 'thread/read').length === 2) {
        const reads = frames.filter(frame => frame.method === 'thread/read');
        socket.send(JSON.stringify({ method: 'thread/updated', params: {} }));
        socket.send(JSON.stringify({ id: reads[0].id, method: 'server/request', params: {} }));
        for (const read of reads.reverse()) socket.send(JSON.stringify({ id: read.id, result: { thread: { id: read.params.threadId } } }));
      }
    });
  });
  let upgrade;
  server.on('upgrade', request => { upgrade = request; });
  const writer = new CodexWriter({ socketPath, binary: 'must-not-spawn-proxy' }); t.after(() => writer.close());
  const first = writer.write('thread/read', { threadId: 'one' });
  const second = writer.write('thread/read', { threadId: 'two' });
  const socket = await initializedRequest;
  assert.equal(upgrade.headers.upgrade, 'websocket');
  assert.equal(upgrade.headers['sec-websocket-version'], '13');
  assert.deepEqual(frames.map(frame => frame.method), ['initialize']);
  socket.send(JSON.stringify({ id: frames[0].id, result: {} }));
  assert.deepEqual(await Promise.all([first, second]), [{ thread: { id: 'one' } }, { thread: { id: 'two' } }]);
  assert.deepEqual(frames.map(frame => frame.method), ['initialize', 'initialized', 'thread/read', 'thread/read']);
  assert.deepEqual(frames.filter(frame => frame.id !== undefined).map(frame => frame.id), [1, 2, 3]);
  await assert.rejects(writer.write('unapproved/method', {}), { code: 'unsupported_handoff_method' });
});

test('初始化 RPC 失败不发送 initialized 或创建聊天；错误正文不泄露', async t => {
  const f = await setup(t); const frames = [];
  const { socketPath } = await socketServer(t, f.directory, socket => socket.on('message', data => {
    const message = JSON.parse(data.toString()); frames.push(message);
    socket.send(JSON.stringify({ id: message.id, error: { code: -1, message: 'PRIVATE native error' } }));
  }));
  const writer = new CodexWriter({ socketPath }); t.after(() => writer.close());
  await assert.rejects(writer.write('thread/start', {}), { code: 'app_server_read_failed', status: 502, message: 'app_server_read_failed' });
  assert.deepEqual(frames.map(frame => frame.method), ['initialize']);
});

for (const failure of ['rpc-error', 'timeout', 'disconnect', 'invalid-json', 'invalid-response', 'oversize', 'close']) {
  test(`WebSocket ${failure} 保留错误码并清理待处理请求`, async t => {
    const f = await setup(t); let sent; const received = new Promise(ok => { sent = ok; });
    const { socketPath } = await socketServer(t, f.directory, socket => {
      socket.on('error', () => {});
      socket.on('message', data => {
        const message = JSON.parse(data.toString());
        if (message.method === 'initialize') socket.send(JSON.stringify({ id: message.id, result: {} }));
        else if (message.method !== 'initialized') {
          sent();
          if (failure === 'rpc-error') socket.send(JSON.stringify({ id: message.id, error: { code: -1, message: 'PRIVATE' } }));
          if (failure === 'disconnect') socket.terminate();
          if (failure === 'invalid-json') socket.send('null');
          if (failure === 'invalid-response') socket.send(JSON.stringify({ id: message.id }));
          if (failure === 'oversize') socket.send('x'.repeat(16 * 1024 * 1024 + 1));
        }
      });
    });
    const writer = new CodexWriter({ socketPath, timeoutMs: failure === 'timeout' ? 150 : 3000 });
    t.after(() => writer.close()); await writer.ready;
    const codes = { 'rpc-error': 'app_server_read_failed', timeout: 'app_server_timeout', disconnect: 'app_server_exited',
      'invalid-json': 'app_server_invalid_json', 'invalid-response': 'app_server_invalid_json',
      oversize: 'app_server_response_too_large', close: 'app_server_closed' };
    const result = assert.rejects(writer.write('thread/read', { threadId: 'test' }), {
      code: codes[failure], status: failure === 'timeout' ? 504 : 502,
    });
    if (failure === 'close') { await received; writer.close(); writer.close(); }
    await result; assert.equal(writer.connection.pending.size, 0);
    if (failure === 'timeout' || failure === 'rpc-error') assert.equal(writer.connection.closed, undefined);
    else await assert.rejects(writer.write('thread/read', {}), { code: 'app_server_exited' });
  });
}

test('缺失 socket 和无 HTTP Upgrade 响应均快速失败；关闭发生在握手中也能结束 ready', { timeout: 5000 }, async t => {
  const f = await setup(t);
  assert.throws(() => new CodexSocket({ socketPath: 'relative.sock' }), { code: 'absolute_codex_socket_required' });
  const missing = process.platform === 'win32' ? `\\\\.\\pipe\\missing-${randomUUID()}` : join(f.directory, 'missing.sock');
  const unavailable = new CodexWriter({ socketPath: missing }); t.after(() => unavailable.close());
  await assert.rejects(unavailable.ready, { code: 'app_server_unavailable' });
  const { socketPath, server } = await socketServer(t, f.directory, () => {});
  server.removeAllListeners('upgrade');
  const connections = new Set();
  server.on('connection', socket => { connections.add(socket); socket.on('close', () => connections.delete(socket)); });
  t.after(() => { for (const socket of connections) socket.destroy(); });
  const timeout = new CodexWriter({ socketPath, timeoutMs: 100 }); t.after(() => timeout.close());
  await assert.rejects(timeout.ready, { code: 'app_server_timeout', status: 504 });
  const closed = new CodexWriter({ socketPath }); closed.close();
  await assert.rejects(closed.ready, { code: 'app_server_closed' });
  // The fixture still accepts IPC connections; no TCP listener was involved.
  const socket = createConnection({ path: socketPath }); await once(socket, 'connect'); socket.destroy();
});

test('重启 MCP 后 shared_session_open(start=false) 复用同一聊天；打包运行时可直接加载 ws', async t => {
  const f = await setup(t); const statePath = join(f.directory, 'native.json');
  await writeFile(statePath, JSON.stringify({ calls: [], threads: {} }));
  const { socketPath } = await nativeSocket(t, f.directory, statePath);
  const profile = join(f.directory, 'bob.json'); await privateJson(profile, { server: f.origin, ...f.store.login('bob', password) });
  const share = f.store.createShare(f.alice, { requestId: 'socket-open', title: 'WebSocket 导入', sourceThreadId: 'source-thread', recipients: ['bob'] });
  f.store.append(f.alice, share.id, { entries: [{ eventId: 'message', kind: 'message', role: 'user', text: '仅验证导入。' }] });
  const env = { SHARED_SESSION_PROFILE: profile, SHARED_SESSION_SERVER: f.origin, SHARED_NOTIFICATIONS: '0',
    SHARED_CODEX_SOCKET: socketPath, SHARED_CODEX_BINARY: 'must-not-spawn-proxy' };
  const first = mcp(t, env); await first.rpc('initialize');
  const opened = await first.call('shared_session_open', { shareId: share.id, start: false });
  const second = mcp(t, env); await second.rpc('initialize');
  const reopened = await second.call('shared_session_open', { shareId: share.id, start: false });
  assert.equal(reopened.threadId, opened.threadId); assert.equal(reopened.openUrl, opened.openUrl);
  assert.equal(opened.openUrl, `codex://threads/${opened.threadId}`);
  const native = JSON.parse(await readFile(statePath, 'utf8'));
  assert.equal(native.calls.filter(call => call.method === 'thread/start').length, 1);
  assert.equal(native.threads[opened.threadId].context.length, 1);
  assert.equal(native.threads[opened.threadId].turns.length, 1);
  const { CodexWriter: PackagedWriter } = await import('../plugins/shared-session/runtime/handoffs.mjs');
  const packaged = new PackagedWriter({ socketPath }); t.after(() => packaged.close());
  assert.equal((await packaged.write('thread/read', { threadId: opened.threadId })).thread.id, opened.threadId);
});
