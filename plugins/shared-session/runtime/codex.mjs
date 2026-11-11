import { spawn } from 'node:child_process';
import { createInterface } from 'node:readline';
import { readFile, stat } from 'node:fs/promises';
import { basename, isAbsolute } from 'node:path';
import { requireThat, ServiceError } from './errors.mjs';
import { MAX_FILE_BYTES, sha256 } from './store.mjs';

const READ_METHODS = new Set(['thread/read', 'thread/turns/list', 'thread/items/list']);
export class CodexReader {
  constructor({ binary = 'codex', args = [], proxy = false, timeoutMs = 30000 } = {}) {
    this.child = spawn(binary, [...args, 'app-server', ...(proxy ? ['proxy'] : ['--stdio'])], { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
    this.pending = new Map(); this.nextId = 0; this.timeoutMs = timeoutMs;
    this.child.stderr.on('data', () => {}); // Never forward native logs or conversation bodies.
    this.child.stdin.on('error', () => this.fail('app_server_unavailable'));
    this.child.on('error', () => this.fail('app_server_unavailable'));
    this.child.on('exit', () => { this.closed = true; this.fail('app_server_exited'); });
    const lines = createInterface({ input: this.child.stdout });
    lines.on('line', line => {
      if (line.length > 16 * 1024 * 1024) { this.fail('app_server_response_too_large'); this.close(); return; }
      let message;
      try { message = JSON.parse(line); } catch { this.fail('app_server_invalid_json'); this.close(); return; }
      if (!this.pending.has(message.id)) return;
      const job = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(job.timer);
      if (message.error) job.reject(new ServiceError(502, 'app_server_read_failed'));
      else job.resolve(message.result);
    });
    this.ready = this.rpc('initialize', { clientInfo: { name: 'remote_shared_session', version: '0.1.0' }, capabilities: { experimentalApi: true } })
      .then(() => this.child.stdin.write(JSON.stringify({ method: 'initialized' }) + '\n'));
    this.ready.catch(() => {});
  }
  fail(code) {
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(new ServiceError(502, code)); }
    this.pending.clear();
  }
  rpc(method, params) {
    if (this.closed) return Promise.reject(new ServiceError(502, 'app_server_exited'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ServiceError(504, 'app_server_timeout')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(JSON.stringify({ id, method, params }) + '\n');
    });
  }
  async read(method, params) {
    requireThat(READ_METHODS.has(method), 400, 'read_only_method_required');
    await this.ready;
    return this.rpc(method, params);
  }
  close() { this.closed = true; this.fail('app_server_closed'); this.child.kill(); }
}

async function pages(reader, method, params, maxPages = 200) {
  const result = []; const cursors = new Set(); let cursor;
  for (let count = 0; count < maxPages; count++) {
    const page = await reader.read(method, { ...params, ...(cursor ? { cursor } : {}) });
    requireThat(Array.isArray(page.data), 502, 'unsupported_history_response');
    result.push(...page.data);
    if (!page.nextCursor) return result;
    requireThat(!cursors.has(page.nextCursor), 502, 'history_cursor_cycle');
    cursor = page.nextCursor; cursors.add(cursor);
  }
  throw new ServiceError(413, 'history_page_limit_exceeded');
}

// Read completed turns only. No resume, subscription, execution, raw database or JSONL reads.
export async function exportThread(reader, threadId) {
  requireThat(typeof threadId === 'string' && threadId.length > 0 && threadId.length <= 180);
  const { thread } = await reader.read('thread/read', { threadId });
  requireThat(thread?.id === threadId, 502, 'wrong_source_thread');
  const turns = await pages(reader, 'thread/turns/list', { threadId, limit: 50, sortDirection: 'asc', itemsView: 'notLoaded' });
  const entries = []; let omittedItems = 0; let pendingTurns = 0;
  for (const turn of turns) {
    if (turn.status !== 'completed') { pendingTurns++; continue; }
    const items = await pages(reader, 'thread/items/list', { threadId, turnId: turn.id, limit: 100, sortDirection: 'asc' });
    for (const entry of items) {
      requireThat(entry.turnId === turn.id && entry.item?.id, 502, 'wrong_source_item');
      const item = entry.item;
      let role; let body;
      if (item.type === 'userMessage') {
        role = 'user';
        requireThat(Array.isArray(item.content), 502, 'unsupported_user_message');
        body = item.content.filter(part => part.type === 'text').map(part => part.text).join('\n');
        omittedItems += item.content.filter(part => part.type !== 'text').length;
      } else if (item.type === 'agentMessage') { role = 'assistant'; body = item.text; }
      else { omittedItems++; continue; }
      if (!body) continue;
      requireThat(typeof body === 'string' && body.length <= 64000, 413, 'message_too_large');
      entries.push({ eventId: `${turn.id}:${item.id}`, kind: 'message', role, text: body });
    }
  }
  return { sourceThreadId: threadId, title: thread.name || '共享会话', entries, omittedItems, pendingTurns };
}

export async function explicitFile(path) {
  requireThat(isAbsolute(path), 400, 'absolute_file_path_required');
  const info = await stat(path);
  requireThat(info.isFile() && info.size <= MAX_FILE_BYTES, 413, 'file_too_large_or_not_regular');
  const bytes = await readFile(path);
  requireThat(bytes.length <= MAX_FILE_BYTES, 413, 'file_too_large');
  return { eventId: `file:${basename(path)}:${sha256(bytes)}`, kind: 'file', name: basename(path), base64: bytes.toString('base64') };
}

export async function publishSnapshot(client, shareId, snapshot, files = []) {
  const current = await client.request(`/api/shares/${shareId}/events?limit=1`);
  requireThat(current.share.sourceThreadId === snapshot.sourceThreadId, 409, 'source_thread_mismatch');
  let result = { version: current.share.version };
  for (let start = 0; start < snapshot.entries.length; start += 50) {
    result = await client.request(`/api/shares/${shareId}/events`, 'POST', { entries: snapshot.entries.slice(start, start + 50) });
  }
  // Files are separate bounded requests; retries use the same content-derived event identity.
  for (const file of files) result = await client.request(`/api/shares/${shareId}/events`, 'POST', { entries: [file] });
  return { shareId, version: result.version, messages: snapshot.entries.length, files: files.length,
    omittedItems: snapshot.omittedItems, pendingTurns: snapshot.pendingTurns };
}
