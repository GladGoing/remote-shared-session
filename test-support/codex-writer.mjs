// Stateful native protocol fixture. It never calls a model or executes shared content.
import { createInterface } from 'node:readline';
import { readFileSync, writeFileSync } from 'node:fs';
import { randomUUID } from 'node:crypto';
const path = process.env.SHARED_FIXTURE_NATIVE;
createInterface({ input: process.stdin }).on('line', line => {
  const message = JSON.parse(line); if (message.id === undefined) return;
  const state = JSON.parse(readFileSync(path, 'utf8')); state.calls.push(message);
  let result;
  const thread = state.threads[message.params?.threadId];
  if (message.method === 'initialize') result = {};
  else if (message.method === 'thread/start') {
    const id = randomUUID(); state.threads[id] = { id, cwd: message.params.cwd, context: [], turns: [], status: { type: 'idle' } };
    result = { thread: state.threads[id] };
  } else if (!thread) result = null;
  else if (['thread/resume', 'thread/read'].includes(message.method)) result = { thread };
  else if (message.method === 'thread/name/set') { thread.name = message.params.name; result = {}; }
  else if (message.method === 'thread/inject_items') { thread.context.push(...message.params.items); result = {}; }
  else if (message.method === 'turn/start') { const turn = { id: randomUUID() }; thread.turns.push(message.params); result = { turn }; }
  writeFileSync(path, JSON.stringify(state));
  if (message.method === process.env.SHARED_FIXTURE_LOST_RESPONSE) process.exit(0);
  process.stdout.write(JSON.stringify({ id: message.id, ...(result ? { result } : { error: { code: -32602, message: 'unsupported fixture request' } }) }) + '\n');
});
