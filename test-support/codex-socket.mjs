import { createServer } from 'node:http';
import { randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { WebSocketServer } from '../src/vendor/ws/wrapper.mjs';

// Windows tests use a named pipe; Unix tests exercise the actual Unix-socket path.
export async function socketServer(t, directory, onConnection) {
  const socketPath = process.platform === 'win32' ? `\\\\.\\pipe\\shared-session-${randomUUID()}` : join(directory, 'native.sock');
  const server = createServer();
  const sockets = new WebSocketServer({ server, perMessageDeflate: false });
  sockets.on('connection', onConnection);
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(socketPath, ok); });
  t.after(async () => {
    for (const socket of sockets.clients) socket.terminate();
    server.closeAllConnections();
    await new Promise(ok => sockets.close(ok));
    await new Promise(ok => server.close(ok));
  });
  return { socketPath, server, sockets };
}

// Stateful daemon fixture: records calls but never invokes a model or runs tasks.
export async function nativeSocket(t, directory, statePath) {
  return socketServer(t, directory, socket => {
    let initialized = false; let initializing = false;
    socket.on('message', (data, binary) => {
      if (binary) return socket.close(1003);
      const message = JSON.parse(data.toString());
      const state = JSON.parse(readFileSync(statePath, 'utf8')); state.calls.push(message);
      let result; const thread = state.threads[message.params?.threadId];
      if (message.method === 'initialize' && !initializing) { initializing = true; result = {}; }
      else if (message.method === 'initialized' && initializing) initialized = true;
      else if (!initialized) { socket.close(1008); return; }
      else if (message.method === 'thread/start') {
        const id = randomUUID(); state.threads[id] = { id, cwd: message.params.cwd, context: [], turns: [], status: { type: 'idle' } };
        result = { thread: state.threads[id] };
      } else if (!thread) result = null;
      else if (['thread/resume', 'thread/read'].includes(message.method)) result = { thread };
      else if (message.method === 'thread/name/set') { thread.name = message.params.name; result = {}; }
      else if (message.method === 'thread/inject_items') { thread.context.push(...message.params.items); result = {}; }
      else if (message.method === 'turn/start') { const turn = { id: randomUUID() }; thread.turns.push(message.params); result = { turn }; }
      writeFileSync(statePath, JSON.stringify(state));
      if (message.id !== undefined) socket.send(JSON.stringify({ id: message.id, ...(result
        ? { result } : { error: { code: -32602, message: 'unsupported fixture request' } }) }));
    });
  });
}
