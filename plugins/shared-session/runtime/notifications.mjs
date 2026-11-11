import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { optionalJson, privateJson } from './profile.mjs';
import { requireThat } from './errors.mjs';

// SSE is our service transport, not a claim of native ChatGPT MCP Events support.
export async function* inboxStream(client, after, signal) {
  const response = await fetch(`${client.url}/api/inbox/stream?after=${after}`, {
    headers: { Authorization: `Bearer ${client.token}` }, redirect: 'error', signal,
  });
  requireThat(response.ok, response.status, response.status === 401 ? 'authentication_required' : 'notification_connection_failed');
  const decoder = new TextDecoder(); let buffer = '';
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
    requireThat(buffer.length < 1024 * 1024, 413, 'notification_too_large');
    let index;
    while ((index = buffer.indexOf('\n\n')) >= 0) {
      const frame = buffer.slice(0, index); buffer = buffer.slice(index + 2);
      if (frame.startsWith('event: reauth')) throw Object.assign(new Error('authentication_required'), { code: 'authentication_required' });
      const data = frame.split('\n').filter(line => line.startsWith('data: ')).map(line => line.slice(6)).join('\n');
      if (data) yield JSON.parse(data);
    }
  }
}

export async function desktopNotice(url) {
  requireThat(process.platform === 'win32', 400, 'desktop_notifications_require_windows');
  const command = await readFile(new URL('./notify-windows.ps1', import.meta.url), 'utf8');
  return new Promise((ok, fail) => {
    const child = spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', command],
      { windowsHide: true, stdio: ['pipe', 'ignore', 'pipe'] });
    const timer = setTimeout(() => { child.kill(); fail(new Error('desktop_notification_timeout')); }, 12000);
    child.once('error', error => { clearTimeout(timer); fail(error); });
    child.stderr.resume();
    child.once('exit', code => { clearTimeout(timer); code === 0 ? ok() : fail(new Error('desktop_notification_unavailable')); });
    child.stdin.on('error', () => {});
    child.stdin.end(JSON.stringify({ url, title: '共享会话', body: '收到新的共享内容，点击打开收件箱。' }));
  });
}

export class NotificationWatcher {
  constructor(bridge, { notify = desktopNotice, defaultEnabled = false, retryMs = 3000 } = {}) {
    this.bridge = bridge; this.path = bridge.profile ? bridge.profile + '.notifications.json' : null;
    this.notify = notify; this.defaultEnabled = defaultEnabled; this.retryMs = retryMs;
    this.supported = process.platform === 'win32' || notify !== desktopNotice;
    this.controller = null; this.running = null; this.error = null; this.preferences = null;
  }
  async status() {
    const saved = this.path ? await optionalJson(this.path) : null;
    return { enabled: saved?.enabled ?? this.defaultEnabled, running: !!this.running, supported: this.supported, platform: process.platform,
      lastError: this.error, delivery: 'desktop_notification_while_plugin_running', inbox: this.bridge.server ? `${this.bridge.server}/inbox` : undefined };
  }
  async configure(enabled) {
    requireThat(typeof enabled === 'boolean' && this.path, 400, 'notification_profile_required');
    await this.stop();
    const saved = await optionalJson(this.path) || {};
    await privateJson(this.path, { ...saved, enabled });
    if (enabled) await this.start();
    return this.status();
  }
  async start() {
    if (this.running || !this.path || !this.supported) return;
    this.preferences = await optionalJson(this.path) || { enabled: this.defaultEnabled };
    if (!this.preferences.enabled) return;
    this.controller = new AbortController(); const signal = this.controller.signal;
    this.running = this.watch(signal).catch(error => { if (!signal.aborted) this.error = error.code || 'notifications_unavailable'; })
      .finally(() => { this.running = null; });
  }
  async watch(signal) {
    while (!signal.aborted) {
      try {
        const client = await this.bridge.client(); const { user } = await client.request('/api/me');
        const identity = `${client.url}|${user.id}`;
        if (this.preferences.identity !== identity) this.preferences = { enabled: true, identity, cursor: 0 };
        for await (const batch of inboxStream(client, this.preferences.cursor || 0, signal)) {
          if (signal.aborted) break;
          if (batch.items.some(item => !item.isRead)) await this.notify(`${client.url}/inbox`);
          // Advance only after the OS accepted the notice; a failure is retried after reconnect.
          this.preferences.cursor = batch.nextCursor; await privateJson(this.path, this.preferences); this.error = null;
        }
      } catch (error) { if (!signal.aborted) this.error = error.code === 'ENOENT' ? 'login_required' : error.code || 'notification_delivery_failed'; }
      if (!signal.aborted) await delay(this.retryMs, undefined, { signal }).catch(() => {});
    }
  }
  async stop() {
    this.controller?.abort(); if (this.running) await this.running;
  }
}
