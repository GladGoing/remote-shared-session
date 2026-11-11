import { unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Client, clientFromProfile, serverUrl } from './client.mjs';
import { privateJson, optionalJson } from './profile.mjs';
import { CodexReader, exportThread, explicitFile, publishSnapshot } from './codex.mjs';
import { requireThat, text, exactKeys } from './errors.mjs';
import { createHash } from 'node:crypto';

export class Bridge {
  constructor({ profile, server, settingsPath, downloadDirectory, readerOptions = {} }) {
    this.profile = profile ? resolve(profile) : null;
    this.server = server ? serverUrl(server) : null;
    this.settingsPath = settingsPath ? resolve(settingsPath) : null;
    this.downloadDirectory = downloadDirectory;
    this.readerOptions = readerOptions;
  }
  async client() {
    requireThat(this.profile, 401, 'SHARED_SESSION_PROFILE_required');
    const client = await clientFromProfile(this.profile);
    requireThat(!this.server || client.url === this.server, 401, 'profile_server_mismatch');
    return client;
  }
  async status() {
    requireThat(this.profile, 401, 'SHARED_SESSION_PROFILE_required');
    try {
      const client = await this.client(); const { user } = await client.request('/api/me');
      return { connected: true, username: user.username, role: user.role, server: client.url };
    } catch (error) {
      if (!['login_required', 'authentication_required', 'ENOENT', 'profile_server_mismatch'].includes(error.code)) throw error;
    }
    const pending = await optionalJson(this.profile + '.pending.json');
    if (!pending || pending.expiresAt <= Date.now() || (this.server && pending.server !== this.server)) return { connected: false, action: 'use_shared_connect' };
    let result;
    try { result = await new Client(pending.server).request('/api/device/poll', 'POST', { deviceCode: pending.deviceCode }); }
    catch (error) {
      if (!['connection_expired', 'connection_denied', 'connection_consumed'].includes(error.code)) throw error;
      await unlink(this.profile + '.pending.json');
      return { connected: false, action: 'use_shared_connect', reason: error.code };
    }
    if (result.status === 'pending') return { connected: false, pending: true, server: pending.server, verificationUrl: pending.verificationUrl, userCode: pending.userCode };
    requireThat(result.status === 'connected' && result.token && result.expiresAt > Date.now(), 502, 'invalid_login_response');
    await privateJson(this.profile, { server: pending.server, token: result.token, expiresAt: result.expiresAt, username: result.username });
    await unlink(this.profile + '.pending.json');
    return { connected: true, username: result.username, role: result.user.role, server: pending.server };
  }
  async connect(args = {}) {
    exactKeys(args, ['server']);
    if (args.server === undefined) return this.beginConnection();
    const input = text(args.server, 2000).trim();
    requireThat(input && !/[\s\\]/.test(input), 400, 'invalid_server_url');
    const target = serverUrl(input.includes('://') ? input : `https://${input}`);
    const previous = this.server;
    this.server = target;
    try {
      const result = await this.beginConnection();
      if (this.settingsPath) {
        const settings = await optionalJson(this.settingsPath) || {};
        requireThat(typeof settings === 'object' && !Array.isArray(settings), 400, 'invalid_settings');
        await privateJson(this.settingsPath, { ...settings, server: target });
      }
      return result;
    } catch (error) { this.server = previous; throw error; }
  }
  async beginConnection() {
    const status = await this.status();
    if (status.connected || status.pending) return status;
    const saved = await optionalJson(this.profile);
    const server = this.server || saved?.server;
    requireThat(server, 400, 'SHARED_SESSION_SERVER_required');
    const client = new Client(server);
    const result = await client.request('/api/device', 'POST', {});
    requireThat(/^[A-F0-9]{10}$/.test(result.userCode) && typeof result.deviceCode === 'string' && result.expiresAt > Date.now(), 502, 'invalid_login_response');
    const verificationUrl = `${client.url}/connect?code=${result.userCode}`;
    await privateJson(this.profile + '.pending.json', { ...result, server: client.url, verificationUrl });
    return { connected: false, pending: true, server: client.url, verificationUrl, userCode: result.userCode, expiresAt: result.expiresAt,
      instruction: '请在浏览器登录共享账号并确认连接，再调用 shared_connection_status。不要把密码或授权令牌发到聊天。' };
  }
  async source(threadId, filePaths) {
    text(threadId, 180);
    requireThat(Array.isArray(filePaths) && filePaths.length <= 20);
    const files = [];
    for (const path of [...new Set(filePaths)]) files.push(await explicitFile(text(path, 4000)));
    const reader = new CodexReader(this.readerOptions);
    try { return { snapshot: await exportThread(reader, threadId), files }; }
    finally { reader.close(); }
  }
  async prepare(args) {
    exactKeys(args, ['threadId', 'requestId', 'title', 'recipients', 'filePaths']);
    text(args.requestId, 180);
    const client = await this.client();
    const { snapshot, files } = await this.source(args.threadId, args.filePaths || []);
    requireThat(snapshot.entries.length + files.length > 0, 409, 'no_completed_content');
    const share = await client.request('/api/drafts', 'POST', { requestId: args.requestId, title: args.title || snapshot.title,
      sourceThreadId: snapshot.sourceThreadId, recipients: args.recipients || [] });
    if (share.status === 'shared') return { shareId: share.id, status: 'shared', action: 'already_published_use_shared_session_sync_for_updates' };
    const result = await publishSnapshot(client, share.id, snapshot, files);
    const sealed = await client.request(`/api/shares/${share.id}/seal`, 'POST', { version: result.version });
    return { ...result, status: sealed.status, reviewUrl: `${client.url}/review?share=${share.id}`,
      instruction: '草稿仅自己可见。请在网页核对完整文本、文件和接收成员，并点击确认发布；未发布前成员无法读取。' };
  }
  async send(args) {
    exactKeys(args, ['requestId', 'shareId', 'title', 'content', 'recipients', 'filePaths']);
    text(args.requestId, 180); text(args.title, 300); text(args.content, 64000);
    requireThat(Array.isArray(args.recipients) && args.recipients.length > 0 && args.recipients.length <= 100);
    const paths = args.filePaths || [];
    requireThat(Array.isArray(paths) && paths.length <= 20);
    const files = [];
    for (const path of [...new Set(paths)]) files.push(await explicitFile(text(path, 4000)));
    // Content is authored in chat; no native history is read. A changed retry is rejected, not silently appended.
    const digest = createHash('sha256').update(JSON.stringify({ content: args.content, files })).digest('hex');
    const sourceThreadId = `message:${digest}`;
    const client = await this.client();
    if (args.shareId !== undefined) {
      text(args.shareId, 180);
      const current = await client.request(`/api/shares/${encodeURIComponent(args.shareId)}/events?limit=1`);
      requireThat(current.share.canManage && current.share.status === 'shared', 409, 'published_owned_share_required');
      const { members } = await client.request(`/api/shares/${encodeURIComponent(args.shareId)}/members`);
      const recipients = [...new Set(args.recipients.map(name => text(name, 80).toLowerCase()))].sort();
      requireThat(JSON.stringify(recipients) === JSON.stringify(members.map(member => member.username).sort()), 409, 'handoff_recipients_changed');
      requireThat(args.title === current.share.title, 409, 'handoff_title_changed');
      let result = await client.request(`/api/shares/${args.shareId}/events`, 'POST', {
        entries: [{ eventId: `composed:${args.requestId}`, kind: 'message', role: 'user', text: args.content }] });
      for (const file of files) result = await client.request(`/api/shares/${args.shareId}/events`, 'POST', { entries: [file] });
      return { shareId: args.shareId, status: 'shared', title: current.share.title, recipients, version: result.version,
        files: files.length, viewUrl: `${client.url}/review?share=${args.shareId}` };
    }
    const share = await client.request('/api/drafts', 'POST', { requestId: args.requestId, title: args.title,
      sourceThreadId, recipients: args.recipients });
    if (share.status !== 'shared') {
      const uploaded = await publishSnapshot(client, share.id, { sourceThreadId,
        entries: [{ eventId: `message:${digest}`, kind: 'message', role: 'user', text: args.content }], omittedItems: 0, pendingTurns: 0 }, files);
      const sealed = await client.request(`/api/shares/${share.id}/seal`, 'POST', { version: uploaded.version });
      await client.request(`/api/shares/${share.id}/publish`, 'POST', { version: sealed.version, revision: sealed.revision });
    }
    return { shareId: share.id, status: 'shared', title: args.title, recipients: [...new Set(args.recipients)],
      files: files.length, viewUrl: `${client.url}/review?share=${share.id}` };
  }
  async sync(args) {
    exactKeys(args, ['threadId', 'shareId', 'filePaths']); text(args.shareId, 180);
    const client = await this.client();
    const current = await client.request(`/api/shares/${encodeURIComponent(args.shareId)}/events?limit=1`);
    requireThat(current.share.canManage && current.share.status === 'shared', 409, 'published_owned_share_required');
    requireThat(current.share.sourceThreadId === args.threadId, 409, 'source_thread_mismatch');
    const { snapshot, files } = await this.source(args.threadId, args.filePaths || []);
    return publishSnapshot(client, args.shareId, snapshot, files);
  }
}
