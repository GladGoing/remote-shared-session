import { connect } from 'node:net';
import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import WebSocket from './vendor/ws/wrapper.mjs';
import { requireThat, ServiceError } from './errors.mjs';

const MAX_RESPONSE_BYTES = 16 * 1024 * 1024;

// The daemon's control socket speaks WebSocket, not newline-delimited stdio.
export class CodexSocket {
  constructor({ socketPath = join(process.env.CODEX_HOME || join(homedir(), '.codex'),
    'app-server-control', 'app-server-control.sock'), timeoutMs = 5000 } = {}) {
    requireThat(typeof socketPath === 'string' && isAbsolute(socketPath), 400, 'absolute_codex_socket_required');
    this.pending = new Map(); this.nextId = 0; this.timeoutMs = timeoutMs;
    // HTTP request socket timeouts do not reliably cover custom IPC connections.
    this.connectTimer = setTimeout(() => this.stop('app_server_timeout', 504), timeoutMs);
    this.socket = new WebSocket('ws://localhost/', {
      createConnection: () => connect({ path: socketPath }),
      handshakeTimeout: timeoutMs, maxPayload: MAX_RESPONSE_BYTES, perMessageDeflate: false,
    });
    const connected = new Promise((resolve, reject) => {
      this.rejectConnect = reject;
      this.socket.once('open', () => { clearTimeout(this.connectTimer); this.rejectConnect = null; resolve(); });
    });
    this.socket.on('error', error => this.stop(error.code === 'WS_ERR_UNSUPPORTED_MESSAGE_LENGTH'
      ? 'app_server_response_too_large' : 'app_server_unavailable'));
    this.socket.on('close', () => this.stop('app_server_exited'));
    this.socket.on('message', (data, isBinary) => {
      let message;
      try {
        if (isBinary) throw new Error();
        message = JSON.parse(data.toString());
        if (!message || typeof message !== 'object' || Array.isArray(message)) throw new Error();
      } catch { this.stop('app_server_invalid_json'); return; }
      if (message.method || !this.pending.has(message.id)) return;
      if (!message.error && !Object.hasOwn(message, 'result')) { this.stop('app_server_invalid_json'); return; }
      const job = this.pending.get(message.id); this.pending.delete(message.id); clearTimeout(job.timer);
      if (message.error) job.reject(new ServiceError(502, 'app_server_read_failed'));
      else job.resolve(message.result);
    });
    this.ready = connected.then(() => this.rpc('initialize', {
      clientInfo: { name: 'remote_shared_session', version: '0.3.2' }, capabilities: { experimentalApi: true },
    })).then(() => this.send({ method: 'initialized' }));
    this.ready.catch(() => this.close());
  }
  send(message) {
    if (this.closed) return Promise.reject(new ServiceError(502, 'app_server_exited'));
    return new Promise((resolve, reject) => {
      this.socket.send(JSON.stringify(message), error => error
        ? reject(new ServiceError(502, 'app_server_unavailable')) : resolve());
    });
  }
  rpc(method, params) {
    if (this.closed) return Promise.reject(new ServiceError(502, 'app_server_exited'));
    return new Promise((resolve, reject) => {
      const id = ++this.nextId;
      const timer = setTimeout(() => { this.pending.delete(id); reject(new ServiceError(504, 'app_server_timeout')); }, this.timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.send({ id, method, params }).catch(() => this.stop('app_server_unavailable'));
    });
  }
  stop(code, status = 502) {
    if (this.closed) return;
    this.closed = true;
    clearTimeout(this.connectTimer);
    const error = new ServiceError(status, code);
    this.rejectConnect?.(error); this.rejectConnect = null;
    for (const job of this.pending.values()) { clearTimeout(job.timer); job.reject(error); }
    this.pending.clear(); this.socket.terminate();
  }
  close() { this.stop('app_server_closed'); }
}
