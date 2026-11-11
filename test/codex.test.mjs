import test from 'node:test';
import assert from 'node:assert/strict';
import { exportThread } from '../src/codex.mjs';

test('官方接口分页导出，只包含完成轮次的用户和助手文本', async () => {
  const calls = [];
  const reader = { async read(method, args) {
    calls.push({ method, args });
    if (method === 'thread/read') return { thread: { id: 'thread', name: 'test' } };
    if (method === 'thread/turns/list') return args.cursor ? { data: [{ id: 'active', status: 'inProgress' }], nextCursor: null }
      : { data: [{ id: 'turn', status: 'completed' }], nextCursor: 'next-turn' };
    if (method === 'thread/items/list') return args.cursor ? { data: [{ turnId: 'turn', item: { id: 'a', type: 'agentMessage', text: '回答' } }], nextCursor: null }
      : { data: [
        { turnId: 'turn', item: { id: 'u', type: 'userMessage', content: [{ type: 'text', text: '问题' }, { type: 'localImage', path: 'private-image.png' }] } },
        { turnId: 'turn', item: { id: 'r', type: 'reasoning', content: ['private reasoning'] } },
        { turnId: 'turn', item: { id: 'c', type: 'commandExecution', aggregatedOutput: 'private command output' } },
      ], nextCursor: 'next-item' };
    throw new Error('Unexpected method');
  } };
  const snapshot = await exportThread(reader, 'thread');
  assert.deepEqual(snapshot.entries.map(entry => [entry.role, entry.text]), [['user', '问题'], ['assistant', '回答']]);
  assert.equal(snapshot.pendingTurns, 1); assert.equal(snapshot.omittedItems, 3);
  assert.ok(calls.every(call => ['thread/read', 'thread/turns/list', 'thread/items/list'].includes(call.method)));
  assert.equal(calls[1].args.sortDirection, 'asc');
  assert.equal(calls.some(call => call.args.turnId === 'active'), false);
  assert.equal(JSON.stringify(snapshot).includes('private'), false);
});

test('重复游标和错误来源失败，不发布不完整历史', async () => {
  const wrong = { read: async () => ({ thread: { id: 'other' } }) };
  await assert.rejects(exportThread(wrong, 'thread'), { code: 'wrong_source_thread' });
  const cycle = { read: async method => method === 'thread/read' ? { thread: { id: 'thread' } } : { data: [], nextCursor: 'cycle' } };
  await assert.rejects(exportThread(cycle, 'thread'), { code: 'history_cursor_cycle' });
});
