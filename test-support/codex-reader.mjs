// Deterministic App Server fixture. It accepts only initialization and read methods; no model is run.
import { createInterface } from 'node:readline';
import { readFileSync } from 'node:fs';
const lines = createInterface({ input: process.stdin });
lines.on('line', line => {
  const message = JSON.parse(line); if (message.id === undefined) return;
  const source = JSON.parse(readFileSync(process.env.SHARED_FIXTURE_SOURCE, 'utf8'));
  let result;
  if (message.method === 'initialize') result = { userAgent: 'read-only-fixture' };
  else if (message.params.threadId !== source.threadId) { process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32602, message: 'unknown thread' } }) + '\n'); return; }
  else if (message.method === 'thread/read') result = { thread: { id: source.threadId, name: source.title } };
  else if (message.method === 'thread/turns/list') result = { data: source.turns.map(turn => ({ id: turn.id, status: turn.status })), nextCursor: null };
  else if (message.method === 'thread/items/list') result = { data: source.turns.find(turn => turn.id === message.params.turnId).items.map(item => ({ turnId: message.params.turnId, item })), nextCursor: null };
  else { process.stdout.write(JSON.stringify({ id: message.id, error: { code: -32601, message: 'writes forbidden' } }) + '\n'); return; }
  process.stdout.write(JSON.stringify({ id: message.id, result }) + '\n');
});
