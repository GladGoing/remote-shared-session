import { mkdir, open, readFile, realpath, lstat } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { isIP } from 'node:net';
import { sha256 } from './store.mjs';
import { requireThat, ServiceError } from './errors.mjs';

export function isLanAddress(hostname) {
  if (isIP(hostname) !== 4) return false;
  const [first, second] = hostname.split('.').map(Number);
  return first === 10 || (first === 172 && second >= 16 && second <= 31) || (first === 192 && second === 168);
}
export function serverUrl(value) {
  const url = new URL(value);
  requireThat(!url.username && !url.password && !url.search && !url.hash && url.pathname === '/', 400, 'invalid_server_url');
  requireThat(url.protocol === 'https:' || (url.protocol === 'http:' && (['127.0.0.1', '[::1]', 'localhost'].includes(url.hostname) || isLanAddress(url.hostname))),
    400, 'https_required');
  return url.origin;
}
export class Client {
  constructor(url, token) { this.url = serverUrl(url); this.token = token; }
  async request(path, method = 'GET', body) {
    requireThat(path.startsWith('/api/'), 400, 'invalid_api_path');
    const response = await fetch(this.url + path, {
      method, redirect: 'error', signal: AbortSignal.timeout(30000),
      headers: { ...(this.token ? { Authorization: `Bearer ${this.token}` } : {}), ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const chunks = []; let length = 0;
    for await (const chunk of response.body) {
      length += chunk.length; requireThat(length <= 14 * 1024 * 1024, 413, 'response_too_large'); chunks.push(chunk);
    }
    const result = JSON.parse(Buffer.concat(chunks).toString('utf8'));
    if (!response.ok) throw new ServiceError(response.status, result.error || 'request_failed');
    return result;
  }
  async download(shareId, fileId, directory) {
    requireThat(isAbsolute(directory), 400, 'absolute_download_directory_required');
    const file = await this.request(`/api/shares/${encodeURIComponent(shareId)}/files/${encodeURIComponent(fileId)}`);
    requireThat(/^[a-zA-Z0-9-]+$/.test(file.fileId) && file.fileId === fileId && typeof file.name === 'string' &&
      file.name.length <= 180 && !/[\x00-\x1f\x7f\\/:*?"<>|]/.test(file.name) && !/[. ]$/.test(file.name), 400, 'invalid_file_metadata');
    const bytes = Buffer.from(file.base64, 'base64');
    requireThat(sha256(bytes) === file.sha256, 400, 'file_hash_mismatch');
    await mkdir(directory, { recursive: true, mode: 0o700 });
    const root = await realpath(resolve(directory));
    const path = join(root, `${file.fileId}-${file.name}`);
    let handle;
    try { handle = await open(path, 'wx', 0o600); }
    catch (error) {
      if (error.code !== 'EEXIST') throw error;
      if ((await lstat(path)).isFile() && sha256(await readFile(path)) === file.sha256) {
        return { path, sha256: file.sha256, size: bytes.length, reused: true };
      }
      throw new ServiceError(409, 'download_destination_exists');
    }
    try { await handle.writeFile(bytes); await handle.sync(); }
    finally { await handle.close(); }
    return { path, sha256: file.sha256, size: bytes.length };
  }
}
export async function clientFromProfile(path) {
  const profile = JSON.parse(await readFile(path, 'utf8'));
  requireThat(typeof profile.token === 'string' && profile.expiresAt > Date.now(), 401, 'login_required');
  return new Client(profile.server, profile.token);
}
