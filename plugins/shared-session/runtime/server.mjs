import { createServer } from 'node:http';
import { readFileSync } from 'node:fs';
import { timingSafeEqual } from 'node:crypto';
import { ServiceError, exactKeys, requireThat } from './errors.mjs';
import { sha256 } from './store.mjs';
import { serverUrl, isLanAddress } from './client.mjs';

const MAX_BODY = 12 * 1024 * 1024;
const LOOPBACK = new Set(['localhost', '127.0.0.1', '[::1]']);
async function readJson(req) {
  requireThat(req.headers['content-type']?.split(';')[0] === 'application/json', 415, 'json_required');
  const chunks = []; let length = 0;
  for await (const chunk of req) {
    length += chunk.length;
    requireThat(length <= MAX_BODY, 413, 'request_too_large'); chunks.push(chunk);
  }
  try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new ServiceError(400, 'invalid_json'); }
}
const csrf = token => sha256('browser-csrf:' + token);
function matches(a, b) {
  return typeof a === 'string' && /^[0-9a-f]{64}$/.test(a) && timingSafeEqual(Buffer.from(a), Buffer.from(b));
}

export function createService(store, { now = Date.now, loginLimit = 10, publicUrl, lanUrls = [] } = {}) {
  const publicOrigin = publicUrl ? serverUrl(publicUrl) : null;
  requireThat(Array.isArray(lanUrls), 400, 'invalid_lan_urls');
  const lanOrigins = new Map(lanUrls.map(value => {
    const url = new URL(serverUrl(value));
    requireThat(url.protocol === 'http:' && isLanAddress(url.hostname), 400, 'invalid_lan_url');
    return [url.host, url.origin];
  }));
  const assets = new Map([
    ['/', ['index.html', 'text/html; charset=utf-8']],
    ['/connect', ['index.html', 'text/html; charset=utf-8']],
    ['/review', ['index.html', 'text/html; charset=utf-8']],
    ['/inbox', ['index.html', 'text/html; charset=utf-8']],
    ['/app.js', ['app.js', 'text/javascript; charset=utf-8']],
    ['/style.css', ['style.css', 'text/css; charset=utf-8']],
    ['/inbox.css', ['inbox.css', 'text/css; charset=utf-8']],
  ]);
  const attempts = new Map();
  function rateLimit(key, limit) {
    const time = now();
    for (const [name, value] of attempts) if (value.until <= time) attempts.delete(name);
    if (!attempts.has(key)) {
      requireThat(attempts.size < 4096, 429, 'rate_limited'); attempts.set(key, { count: 0, until: time + 60000 });
    }
    requireThat(++attempts.get(key).count <= limit, 429, 'login_rate_limited');
  }
  const browserToken = req => /(?:^|;\s*)shared_session=([A-Za-z0-9_-]+)/.exec(req.headers.cookie || '')?.[1];
  const server = createServer(async (req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('X-Frame-Options', 'DENY');
    res.setHeader('Referrer-Policy', 'no-referrer');
    res.setHeader('Content-Security-Policy', "default-src 'self'; script-src 'self'; style-src 'self'; connect-src 'self'; img-src 'self' blob:; object-src 'none'; base-uri 'none'; frame-ancestors 'none'; form-action 'self'");
    res.setHeader('Content-Type', 'application/json; charset=utf-8');
    const send = (status, data) => { res.writeHead(status); res.end(JSON.stringify(data)); };
    try {
      const host = new URL(`http://${req.headers.host || ''}`);
      const lanOrigin = lanOrigins.get(host.host);
      const origin = lanOrigin || publicOrigin || host.origin;
      const cookie = (token, clear = false) => `shared_session=${clear ? '' : token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${clear ? 0 : Math.floor(store.tokenTtlMs / 1000)}${origin.startsWith('https:') ? '; Secure' : ''}`;
      const url = new URL(req.url, origin);
      const health = req.method === 'GET' && url.pathname === '/healthz';
      requireThat(lanOrigin || (publicOrigin ? host.host === new URL(publicOrigin).host : LOOPBACK.has(host.hostname)) || (health && LOOPBACK.has(host.hostname)), 403, 'invalid_host');
      requireThat(!req.headers.origin || req.headers.origin === origin, 403, 'invalid_origin');
      if (health) return send(200, { ok: true, version: '0.2.3' });
      if (req.method === 'GET' && url.pathname === '/favicon.ico') { res.writeHead(204); res.end(); return; }
      if (['GET', 'HEAD'].includes(req.method) && assets.has(url.pathname)) {
        const [file, mime] = assets.get(url.pathname);
        res.setHeader('Content-Type', mime); res.writeHead(200);
        res.end(readFileSync(new URL(`./web/${file}`, import.meta.url))); return;
      }
      const address = req.socket.remoteAddress || 'unknown';
      if (req.method === 'GET' && url.pathname === '/api/web/session') {
        const token = browserToken(req);
        try { return send(200, { user: store.authenticate(token, 'browser'), csrfToken: csrf(token) }); }
        catch { res.setHeader('Set-Cookie', cookie('', true)); return send(200, { user: null, setupRequired: store.db.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0 }); }
      }
      if (req.method === 'POST' && ['/api/login', '/api/web/login'].includes(url.pathname)) {
        rateLimit(`${address}:login-all`, 100);
        const input = await readJson(req); exactKeys(input, ['username', 'password']);
        requireThat(typeof input.username === 'string' && input.username.length <= 80);
        rateLimit(`${address}:login:${input.username.toLowerCase()}`, loginLimit);
        const web = url.pathname === '/api/web/login';
        const session = store.login(input.username, input.password, web ? 'browser' : 'api');
        if (!web) return send(200, session);
        res.setHeader('Set-Cookie', cookie(session.token));
        return send(200, { user: session.user, csrfToken: csrf(session.token) });
      }
      if (req.method === 'POST' && url.pathname === '/api/device') {
        rateLimit(`${address}:device`, 20);
        exactKeys(await readJson(req), []);
        const result = store.createDevice();
        return send(201, { ...result, verificationUri: `${origin}/connect?code=${result.userCode}` });
      }
      if (req.method === 'POST' && url.pathname === '/api/device/poll') {
        rateLimit(`${address}:poll`, 120);
        const input = await readJson(req); exactKeys(input, ['deviceCode']);
        return send(200, store.pollDevice(input.deviceCode));
      }
      const bearer = /^Bearer ([A-Za-z0-9_-]+)$/.exec(req.headers.authorization || '')?.[1];
      const token = req.headers.authorization ? bearer : browserToken(req);
      const kind = req.headers.authorization ? 'api' : 'browser';
      const user = store.authenticate(token, kind);
      if (kind === 'browser' && !['GET', 'HEAD'].includes(req.method)) {
        requireThat(matches(req.headers['x-csrf-token'], csrf(token)), 403, 'csrf_required');
      }
      if (req.method === 'POST' && ['/api/logout', '/api/web/logout'].includes(url.pathname)) {
        store.logout(token); if (kind === 'browser') res.setHeader('Set-Cookie', cookie('', true));
        return send(200, { ok: true });
      }
      if (req.method === 'GET' && url.pathname === '/api/me') return send(200, { user });
      if (req.method === 'GET' && url.pathname === '/api/inbox') return send(200, store.inbox(user, Number(url.searchParams.get('after') || 0), Number(url.searchParams.get('limit') || 50)));
      if (req.method === 'POST' && url.pathname === '/api/inbox/read') {
        const input = await readJson(req); exactKeys(input, ['ids']); return send(200, store.readNotifications(user, input.ids));
      }
      if (req.method === 'GET' && url.pathname === '/api/inbox/stream') {
        let cursor = Number(req.headers['last-event-id'] || url.searchParams.get('after') || 0);
        requireThat(Number.isSafeInteger(cursor) && cursor >= 0);
        res.setHeader('Content-Type', 'text/event-stream; charset=utf-8');
        res.setHeader('X-Accel-Buffering', 'no'); res.setHeader('Connection', 'keep-alive'); res.writeHead(200); res.flushHeaders();
        let count = -1; let ticks = 0;
        const tick = () => {
          try {
            if (res.writableLength > 256 * 1024) { res.end(); return; }
            const currentUser = store.authenticate(token, kind);
            const batch = store.inbox(currentUser, cursor, 50);
            if (batch.items.length || count !== batch.unreadCount) {
              res.write(`id: ${batch.nextCursor}\ndata: ${JSON.stringify(batch)}\n\n`);
              cursor = batch.nextCursor; count = batch.unreadCount;
            } else if (++ticks % 10 === 0) res.write(': keep-alive\n\n');
          } catch { res.write('event: reauth\ndata: {}\n\n'); res.end(); }
        };
        const timer = setInterval(tick, 2000); timer.unref(); res.once('close', () => clearInterval(timer)); tick(); return;
      }
      if (req.method === 'GET' && url.pathname === '/api/directory') return send(200, { members: store.directory() });
      if (url.pathname === '/api/users') {
        if (req.method === 'GET') return send(200, { members: store.listUsers(user) });
        if (req.method === 'POST') return send(201, store.addUser(user, await readJson(req)));
      }
      const account = /^\/api\/users\/([a-zA-Z0-9_.-]+)(\/password)?$/.exec(url.pathname);
      if (account) {
        if (req.method === 'PATCH' && !account[2]) return send(200, store.updateUser(user, account[1], await readJson(req)));
        if (req.method === 'POST' && account[2]) {
          const input = await readJson(req); exactKeys(input, ['password']);
          return send(200, store.resetPassword(user, account[1], input.password));
        }
      }
      const device = /^\/api\/device\/([A-F0-9]{10})$/.exec(url.pathname);
      if (device) {
        if (req.method === 'GET') return send(200, store.deviceInfo(device[1]));
        if (req.method === 'POST') {
          const input = await readJson(req); exactKeys(input, ['approved']);
          return send(200, store.approveDevice(user, device[1], input.approved));
        }
      }
      if (url.pathname === '/api/shares') {
        if (req.method === 'GET') return send(200, { shares: store.listShares(user) });
        if (req.method === 'POST') return send(201, store.createShare(user, await readJson(req)));
      }
      if (req.method === 'POST' && url.pathname === '/api/drafts') return send(201, store.createShare(user, await readJson(req), { draft: true }));
      const route = /^\/api\/shares\/([a-zA-Z0-9-]+)\/(events|members|files|seal|publish)(?:\/([^/]+))?$/.exec(url.pathname);
      if (route) {
        const [, shareId, resource, value] = route;
        if (resource === 'events' && !value) {
          if (req.method === 'GET') return send(200, store.read(user, shareId, Number(url.searchParams.get('after') || 0), Number(url.searchParams.get('limit') || 50)));
          if (req.method === 'POST') return send(200, store.append(user, shareId, await readJson(req)));
        }
        if (resource === 'members') {
          if (req.method === 'GET' && !value) return send(200, { members: store.shareMembers(user, shareId) });
          if (req.method === 'POST' && !value) {
            const input = await readJson(req); exactKeys(input, ['username']);
            return send(200, store.setMember(user, shareId, input.username, true));
          }
          if (req.method === 'DELETE' && value) return send(200, store.setMember(user, shareId, decodeURIComponent(value), false));
        }
        if (resource === 'seal' && !value && req.method === 'POST') {
          const input = await readJson(req); exactKeys(input, ['version']); return send(200, store.sealDraft(user, shareId, input.version));
        }
        if (resource === 'publish' && !value && req.method === 'POST') return send(200, store.publishDraft(user, shareId, await readJson(req)));
        if (resource === 'files' && value && req.method === 'GET') return send(200, store.file(user, shareId, value));
      }
      send(404, { error: 'not_found' });
    } catch (error) {
      req.resume();
      send(error instanceof ServiceError ? error.status : 500, { error: error instanceof ServiceError ? error.code : 'internal_error' });
    }
  });
  server.requestTimeout = 30000; server.headersTimeout = 10000; server.maxHeadersCount = 50;
  return server;
}
