import { mkdtemp, rm } from 'node:fs/promises';
import { resolve, join, dirname, basename } from 'node:path';
import { tmpdir } from 'node:os';
import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { fileURLToPath } from 'node:url';
import { Store } from '../src/store.mjs';
import { createService } from '../src/server.mjs';
import { Client } from '../src/client.mjs';

export const password = 'local-fixture-password-2026';
export async function setup(t, options = {}) {
  const directory = await mkdtemp(join(tmpdir(), 'shared-session-v2-'));
  const store = new Store(join(directory, 'test.sqlite'), options);
  const alice = store.createUser('alice', password); const bob = store.createUser('bob', password); store.createUser('charlie', password);
  const server = createService(store, options);
  await new Promise((ok, fail) => { server.once('error', fail); server.listen(0, '127.0.0.1', ok); });
  const origin = `http://127.0.0.1:${server.address().port}`;
  t.after(async () => {
    server.closeAllConnections(); await new Promise(ok => server.close(ok)); store.close();
    if (resolve(dirname(directory)) !== resolve(tmpdir()) || !basename(directory).startsWith('shared-session-v2-')) throw new Error('unsafe_test_cleanup');
    await rm(directory, { recursive: true, force: true });
  });
  const api = name => new Client(origin, store.login(name, password).token);
  return { directory, store, server, origin, alice, bob, api };
}
export async function browser(origin, username = 'alice', secret = password) {
  const response = await fetch(origin + '/api/web/login', { method: 'POST', headers: { 'Content-Type': 'application/json', Origin: origin }, body: JSON.stringify({ username, password: secret }) });
  const result = await response.json();
  if (!response.ok) throw Object.assign(new Error(result.error), { status: response.status, code: result.error });
  const cookie = response.headers.get('set-cookie');
  const request = async (path, method = 'GET', body, overrides = {}) => {
    const response = await fetch(origin + path, { method, headers: { Cookie: cookie.split(';')[0], Origin: origin,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(!['GET', 'HEAD'].includes(method) ? { 'X-CSRF-Token': result.csrfToken } : {}), ...overrides }, body: body === undefined ? undefined : JSON.stringify(body) });
    const value = await response.json();
    if (!response.ok) throw Object.assign(new Error(value.error), { status: response.status, code: value.error });
    return value;
  };
  return { request, cookie, result };
}
export function mcp(t, env) {
  const child = spawn(process.execPath, [fileURLToPath(new URL('../src/mcp.mjs', import.meta.url))], {
    windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'], env: { ...process.env, ...env },
  });
  const waiting = new Map(); let id = 0;
  const lines = createInterface({ input: child.stdout });
  lines.on('line', line => { const result = JSON.parse(line); waiting.get(result.id)?.(result); });
  child.stderr.on('data', () => {});
  t.after(async () => {
    const done = new Promise(ok => { if (child.exitCode !== null) ok(); else child.once('close', ok); });
    child.kill(); lines.close(); await done;
  });
  const rpc = (method, params = {}) => new Promise((ok, fail) => {
    const current = ++id; const timeout = setTimeout(() => { waiting.delete(current); fail(new Error('MCP timeout')); }, 15000);
    waiting.set(current, result => { clearTimeout(timeout); waiting.delete(current); ok(result); });
    child.stdin.write(JSON.stringify({ jsonrpc: '2.0', id: current, method, params }) + '\n');
  });
  const call = async (name, args = {}) => {
    const response = await rpc('tools/call', { name, arguments: args });
    if (response.error) throw new Error(response.error.message);
    const result = response.result;
    if (result.isError) throw Object.assign(new Error(result.content[0].text), { code: result.content[0].text });
    return JSON.parse(result.content[0].text);
  };
  return { rpc, call };
}
