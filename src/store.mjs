import { DatabaseSync } from 'node:sqlite';
import { randomBytes, randomUUID, createHash, scryptSync, timingSafeEqual } from 'node:crypto';
import { mkdirSync, chmodSync } from 'node:fs';
import { dirname } from 'node:path';
import { requireThat, text, exactKeys } from './errors.mjs';

export const MAX_FILE_BYTES = 8 * 1024 * 1024;
export const sha256 = value => createHash('sha256').update(value).digest('hex');
const usernameOf = value => {
  text(value, 80);
  requireThat(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/.test(value));
  return value.toLowerCase();
};
const fileName = value => {
  text(value, 180);
  requireThat(!/[\x00-\x1f\x7f\\/:*?"<>|]/.test(value) && !/[. ]$/.test(value) && value !== '.' && value !== '..');
  return value;
};

export class Store {
  constructor(path, { now = Date.now, tokenTtlMs = 12 * 60 * 60 * 1000 } = {}) {
    this.now = now;
    this.tokenTtlMs = tokenTtlMs;
    if (path !== ':memory:') mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
    this.db = new DatabaseSync(path);
    if (path !== ':memory:') chmodSync(path, 0o600);
    this.db.exec(`PRAGMA foreign_keys=ON; PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS users(id TEXT PRIMARY KEY, username TEXT UNIQUE NOT NULL, salt TEXT NOT NULL, hash TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS tokens(hash TEXT PRIMARY KEY, user_id TEXT REFERENCES users(id), expires INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS shares(id TEXT PRIMARY KEY, owner_id TEXT REFERENCES users(id), title TEXT NOT NULL,
        source_thread_id TEXT NOT NULL, request_id TEXT NOT NULL, creation_hash TEXT NOT NULL, version INTEGER NOT NULL DEFAULT 0,
        UNIQUE(owner_id, request_id));
      CREATE TABLE IF NOT EXISTS members(share_id TEXT REFERENCES shares(id), user_id TEXT REFERENCES users(id), PRIMARY KEY(share_id,user_id));
      CREATE TABLE IF NOT EXISTS events(share_id TEXT REFERENCES shares(id), seq INTEGER NOT NULL, event_id TEXT NOT NULL,
        digest TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL, created_at INTEGER NOT NULL,
        PRIMARY KEY(share_id,seq), UNIQUE(share_id,event_id));
      CREATE TABLE IF NOT EXISTS files(id TEXT PRIMARY KEY, share_id TEXT REFERENCES shares(id), name TEXT NOT NULL,
        sha256 TEXT NOT NULL, bytes BLOB NOT NULL);`);
    this.migrate();
    this.dummySalt = randomBytes(16).toString('hex');
    this.dummyHash = scryptSync('dummy-password-never-used', this.dummySalt, 64);
  }
  migrate() {
    this.atomic(() => {
      const add = (table, name, definition) => {
        if (this.db.prepare(`PRAGMA table_info(${table})`).all().some(column => column.name === name)) return false;
        this.db.exec(`ALTER TABLE ${table} ADD COLUMN ${name} ${definition}`); return true;
      };
      const newRoles = add('users', 'role', "TEXT NOT NULL DEFAULT 'member' CHECK(role IN ('admin','member'))");
      add('users', 'enabled', 'INTEGER NOT NULL DEFAULT 1 CHECK(enabled IN (0,1))');
      add('tokens', 'kind', "TEXT NOT NULL DEFAULT 'api' CHECK(kind IN ('api','browser'))");
      add('shares', 'published', 'INTEGER NOT NULL DEFAULT 1');
      add('shares', 'ready', 'INTEGER NOT NULL DEFAULT 1');
      add('shares', 'revision', 'INTEGER NOT NULL DEFAULT 0');
      if (newRoles) this.db.exec("UPDATE users SET role='admin' WHERE rowid=(SELECT MIN(rowid) FROM users)");
      const hadInbox = this.db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='notifications'").get();
      this.db.exec(`CREATE TABLE IF NOT EXISTS device_authorizations(
        hash TEXT PRIMARY KEY, user_code TEXT UNIQUE NOT NULL, expires INTEGER NOT NULL,
        status TEXT NOT NULL DEFAULT 'pending', approved_user TEXT REFERENCES users(id),
        issued_hash TEXT, issued_expires INTEGER, last_poll INTEGER NOT NULL DEFAULT 0);
        CREATE TABLE IF NOT EXISTS notifications(id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id TEXT NOT NULL REFERENCES users(id), share_id TEXT NOT NULL REFERENCES shares(id),
          kind TEXT NOT NULL, event_key TEXT NOT NULL, version INTEGER NOT NULL, created_at INTEGER NOT NULL, read_at INTEGER,
          UNIQUE(user_id,share_id,event_key));
        CREATE INDEX IF NOT EXISTS notifications_user_id ON notifications(user_id,id);
        PRAGMA user_version=2;`);
      if (!hadInbox) for (const share of this.db.prepare('SELECT id FROM shares WHERE published=1 AND version>0').all()) this.notifyMembers(share.id, 'shared', 'upgrade-v2');
    });
  }
  close() { this.db.close(); }
  atomic(fn) {
    this.db.exec('BEGIN IMMEDIATE');
    try { const result = fn(); this.db.exec('COMMIT'); return result; }
    catch (error) { this.db.exec('ROLLBACK'); throw error; }
  }
  createUser(username, password, role) {
    username = usernameOf(username);
    text(password, 1024);
    requireThat(password.length >= 12, 400, 'password_too_short');
    requireThat(!this.db.prepare('SELECT id FROM users WHERE username=?').get(username), 409, 'username_exists');
    const salt = randomBytes(16).toString('hex');
    const id = randomUUID();
    role ??= this.db.prepare('SELECT COUNT(*) AS count FROM users').get().count === 0 ? 'admin' : 'member';
    requireThat(['admin', 'member'].includes(role));
    this.db.prepare('INSERT INTO users(id,username,salt,hash,role) VALUES(?,?,?,?,?)').run(id, username, salt, scryptSync(password, salt, 64).toString('hex'), role);
    return { id, username, role, enabled: true };
  }
  login(username, password, kind = 'api') {
    username = usernameOf(username);
    text(password, 1024);
    const user = this.db.prepare('SELECT * FROM users WHERE username=?').get(username);
    const hash = scryptSync(password, user?.salt || this.dummySalt, 64);
    requireThat(timingSafeEqual(hash, user ? Buffer.from(user.hash, 'hex') : this.dummyHash) && user?.enabled, 401, 'invalid_credentials');
    return this.createToken(user, kind);
  }
  createToken(user, kind = 'api', token = randomBytes(32).toString('base64url')) {
    requireThat(['api', 'browser'].includes(kind));
    const expiresAt = this.now() + this.tokenTtlMs;
    this.db.prepare('DELETE FROM tokens WHERE expires <= ?').run(this.now());
    this.db.prepare('INSERT INTO tokens(hash,user_id,expires,kind) VALUES(?,?,?,?)').run(sha256(token), user.id, expiresAt, kind);
    return { token, expiresAt, username: user.username, user: { id: user.id, username: user.username, role: user.role } };
  }
  authenticate(token, kind = 'api') {
    requireThat(typeof token === 'string' && token.length <= 200, 401, 'authentication_required');
    const user = this.db.prepare(`SELECT u.id,u.username,u.role FROM tokens t JOIN users u ON u.id=t.user_id
      WHERE t.hash=? AND t.expires>? AND t.kind=? AND u.enabled=1`).get(sha256(token), this.now(), kind);
    requireThat(user, 401, 'authentication_required');
    return user;
  }
  logout(token) { this.db.prepare('DELETE FROM tokens WHERE hash=?').run(sha256(token)); }
  admin(user) {
    requireThat(this.db.prepare("SELECT 1 FROM users WHERE id=? AND enabled=1 AND role='admin'").get(user.id), 403, 'admin_required');
  }
  listUsers(user) {
    this.admin(user);
    return this.db.prepare('SELECT id,username,role,enabled FROM users ORDER BY rowid').all().map(row => ({ ...row, enabled: !!row.enabled }));
  }
  directory() { return this.db.prepare('SELECT username FROM users WHERE enabled=1 ORDER BY username').all(); }
  addUser(user, input) {
    this.admin(user); exactKeys(input, ['username', 'password', 'role']);
    return this.atomic(() => this.createUser(input.username, input.password, input.role || 'member'));
  }
  updateUser(user, username, input) {
    this.admin(user); exactKeys(input, ['role', 'enabled']);
    requireThat(Object.keys(input).length > 0);
    if (input.role !== undefined) requireThat(['admin', 'member'].includes(input.role));
    if (input.enabled !== undefined) requireThat(typeof input.enabled === 'boolean');
    return this.atomic(() => {
      const target = this.db.prepare('SELECT id,username,role,enabled FROM users WHERE username=?').get(usernameOf(username));
      requireThat(target, 404, 'member_not_found');
      const role = input.role ?? target.role; const enabled = input.enabled ?? !!target.enabled;
      if (target.role === 'admin' && target.enabled && (role !== 'admin' || !enabled)) {
        requireThat(this.db.prepare("SELECT COUNT(*) AS count FROM users WHERE role='admin' AND enabled=1").get().count > 1, 409, 'last_admin_required');
      }
      requireThat(target.id !== user.id || enabled, 409, 'cannot_disable_self');
      this.db.prepare('UPDATE users SET role=?,enabled=? WHERE id=?').run(role, enabled ? 1 : 0, target.id);
      if (!enabled) {
        this.db.prepare('DELETE FROM tokens WHERE user_id=?').run(target.id);
        this.db.prepare("UPDATE device_authorizations SET status='denied' WHERE approved_user=?").run(target.id);
      }
      return { id: target.id, username: target.username, role, enabled };
    });
  }
  resetPassword(user, username, password) {
    this.admin(user); text(password, 1024); requireThat(password.length >= 12, 400, 'password_too_short');
    const target = this.db.prepare('SELECT id FROM users WHERE username=?').get(usernameOf(username));
    requireThat(target, 404, 'member_not_found');
    requireThat(target.id !== user.id, 409, 'cannot_reset_self');
    const salt = randomBytes(16).toString('hex'); const hash = scryptSync(password, salt, 64).toString('hex');
    return this.atomic(() => {
      this.db.prepare('UPDATE users SET salt=?,hash=? WHERE id=?').run(salt, hash, target.id);
      this.db.prepare('DELETE FROM tokens WHERE user_id=?').run(target.id);
      this.db.prepare("UPDATE device_authorizations SET status='denied' WHERE approved_user=?").run(target.id);
      return { username: usernameOf(username), reset: true };
    });
  }
  createDevice() {
    this.db.prepare('DELETE FROM device_authorizations WHERE expires<=?').run(this.now());
    requireThat(this.db.prepare('SELECT COUNT(*) AS count FROM device_authorizations').get().count < 500, 429, 'too_many_connections');
    const deviceCode = randomBytes(32).toString('base64url');
    const userCode = randomBytes(5).toString('hex').toUpperCase();
    const expiresAt = this.now() + 10 * 60 * 1000;
    this.db.prepare('INSERT INTO device_authorizations(hash,user_code,expires) VALUES(?,?,?)').run(sha256(deviceCode), userCode, expiresAt);
    return { deviceCode, userCode, expiresAt };
  }
  deviceInfo(userCode) {
    const item = this.db.prepare('SELECT user_code,expires,status FROM device_authorizations WHERE user_code=? AND expires>?').get(userCode, this.now());
    requireThat(item, 404, 'connection_expired');
    return { userCode: item.user_code, expiresAt: item.expires, status: item.status };
  }
  approveDevice(user, userCode, approved) {
    requireThat(typeof approved === 'boolean');
    return this.atomic(() => {
      this.deviceInfo(userCode);
      const item = this.db.prepare('SELECT status,approved_user FROM device_authorizations WHERE user_code=?').get(userCode);
      requireThat(item.status === 'pending', 409, 'connection_already_decided');
      this.db.prepare('UPDATE device_authorizations SET status=?,approved_user=? WHERE user_code=?')
        .run(approved ? 'approved' : 'denied', user.id, userCode);
      return { approved };
    });
  }
  pollDevice(deviceCode) {
    text(deviceCode, 100);
    return this.atomic(() => {
      const item = this.db.prepare('SELECT * FROM device_authorizations WHERE hash=? AND expires>?').get(sha256(deviceCode), this.now());
      requireThat(item, 404, 'connection_expired');
      requireThat(item.status !== 'denied', 403, 'connection_denied');
      if (item.status === 'pending') return { status: 'pending' };
      const user = this.db.prepare('SELECT id,username,role FROM users WHERE id=? AND enabled=1').get(item.approved_user);
      requireThat(user, 401, 'authentication_required');
      // Stable delivery permits a lost poll response to be retried, without storing a plaintext token.
      const token = sha256('shared-session-device-token:' + deviceCode);
      if (item.issued_hash) {
        requireThat(this.db.prepare('SELECT 1 FROM tokens WHERE hash=? AND expires>?').get(item.issued_hash, this.now()), 410, 'connection_consumed');
        return { status: 'connected', token, expiresAt: item.issued_expires, username: user.username, user };
      }
      const session = this.createToken(user, 'api', token);
      this.db.prepare('UPDATE device_authorizations SET issued_hash=?,issued_expires=? WHERE hash=?').run(sha256(token), session.expiresAt, item.hash);
      return { status: 'connected', ...session };
    });
  }
  access(user, shareId, ownerOnly = false) {
    const share = this.db.prepare('SELECT * FROM shares WHERE id=?').get(shareId);
    const owner = share?.owner_id === user.id;
    const member = share?.published && this.db.prepare('SELECT 1 FROM members WHERE share_id=? AND user_id=?').get(shareId, user.id);
    requireThat(share && (owner || (!ownerOnly && member)), 404, 'share_not_found');
    return share;
  }
  describe(share, user) {
    return { id: share.id, title: share.title, sourceThreadId: share.source_thread_id, version: share.version,
      owner: this.db.prepare('SELECT username FROM users WHERE id=?').get(share.owner_id).username,
      status: share.published ? 'shared' : (share.ready ? 'draft' : 'uploading'),
      revision: share.revision, canManage: user?.id === share.owner_id };
  }
  createShare(user, input, { draft = false } = {}) {
    exactKeys(input, ['requestId', 'title', 'sourceThreadId', 'recipients']);
    const { requestId, title, sourceThreadId, recipients } = input;
    text(requestId, 180); text(title, 300); text(sourceThreadId, 180);
    requireThat(Array.isArray(recipients) && (draft || recipients.length > 0) && recipients.length <= 100);
    const names = [...new Set(recipients.map(usernameOf))].sort();
    const digest = sha256(JSON.stringify({ title, sourceThreadId, recipients: names, ...(draft ? { draft: true } : {}) }));
    return this.atomic(() => {
      const previous = this.db.prepare('SELECT * FROM shares WHERE owner_id=? AND request_id=?').get(user.id, requestId);
      if (previous) {
        requireThat(previous.creation_hash === digest, 409, 'request_conflict');
        return this.describe(previous, user);
      }
      const users = names.map(name => {
        const found = this.db.prepare('SELECT id FROM users WHERE username=? AND enabled=1').get(name);
        requireThat(found, 400, 'recipient_not_found'); return found;
      });
      const id = randomUUID();
      this.db.prepare('INSERT INTO shares(id,owner_id,title,source_thread_id,request_id,creation_hash,published,ready) VALUES(?,?,?,?,?,?,?,?)')
        .run(id, user.id, title, sourceThreadId, requestId, digest, draft ? 0 : 1, draft ? 0 : 1);
      for (const recipient of users) this.db.prepare('INSERT OR IGNORE INTO members VALUES(?,?)').run(id, recipient.id);
      return this.describe(this.access(user, id), user);
    });
  }
  listShares(user) {
    return this.db.prepare(`SELECT s.* FROM shares s WHERE s.owner_id=? OR (s.published=1 AND EXISTS
      (SELECT 1 FROM members m WHERE m.share_id=s.id AND m.user_id=?)) ORDER BY s.rowid DESC`).all(user.id, user.id)
      .map(share => this.describe(share, user));
  }
  shareMembers(user, shareId) {
    this.access(user, shareId, true);
    return this.db.prepare('SELECT u.username,u.enabled FROM users u JOIN members m ON m.user_id=u.id WHERE m.share_id=? ORDER BY u.username')
      .all(shareId).map(row => ({ ...row, enabled: !!row.enabled }));
  }
  sealDraft(user, shareId, version) {
    return this.atomic(() => {
      const share = this.access(user, shareId, true);
      requireThat(!share.published && Number.isSafeInteger(version) && share.version === version && version > 0, 409, 'draft_changed');
      this.db.prepare('UPDATE shares SET ready=1 WHERE id=?').run(shareId);
      return this.describe(this.access(user, shareId), user);
    });
  }
  publishDraft(user, shareId, input) {
    exactKeys(input, ['version', 'revision']);
    return this.atomic(() => {
      const share = this.access(user, shareId, true);
      if (share.published) return this.describe(share, user);
      requireThat(share.ready && share.version === input.version && share.revision === input.revision, 409, 'draft_changed');
      requireThat(this.db.prepare('SELECT 1 FROM members m JOIN users u ON u.id=m.user_id WHERE m.share_id=? AND u.enabled=1 AND u.id<>?').get(shareId, user.id), 400, 'recipient_required');
      this.db.prepare('UPDATE shares SET published=1 WHERE id=?').run(shareId);
      this.notifyMembers(shareId, 'shared', `publish:${share.version}`);
      return this.describe(this.access(user, shareId), user);
    });
  }
  setMember(user, shareId, username, enabled) {
    return this.atomic(() => {
      const share = this.access(user, shareId, true);
      const member = this.db.prepare('SELECT id,enabled FROM users WHERE username=?').get(usernameOf(username));
      requireThat(member, 400, 'recipient_not_found');
      requireThat(!enabled || member.enabled, 400, 'member_disabled');
      const result = enabled ? this.db.prepare('INSERT OR IGNORE INTO members VALUES(?,?)').run(shareId, member.id)
        : this.db.prepare('DELETE FROM members WHERE share_id=? AND user_id=?').run(shareId, member.id);
      if (result.changes) {
        this.db.prepare('UPDATE shares SET revision=revision+1 WHERE id=?').run(shareId);
        if (enabled && share.published && share.version > 0) this.notifyMembers(shareId, 'shared', `grant:${share.revision + 1}`, member.id);
        if (!enabled) this.db.prepare('DELETE FROM notifications WHERE share_id=? AND user_id=?').run(shareId, member.id);
      }
      return { username: usernameOf(username), enabled };
    });
  }
  prepareEntry(entry) {
    exactKeys(entry, ['eventId', 'kind', 'role', 'text', 'name', 'base64']);
    text(entry.eventId, 300);
    if (entry.kind === 'message') {
      exactKeys(entry, ['eventId', 'kind', 'role', 'text']);
      requireThat(['user', 'assistant'].includes(entry.role)); text(entry.text, 64000);
      return { eventId: entry.eventId, kind: 'message', payload: { role: entry.role, text: entry.text },
        digest: sha256(JSON.stringify({ role: entry.role, text: entry.text })) };
    }
    requireThat(entry.kind === 'file');
    exactKeys(entry, ['eventId', 'kind', 'name', 'base64']);
    const name = fileName(entry.name);
    requireThat(typeof entry.base64 === 'string' && entry.base64.length <= Math.ceil(MAX_FILE_BYTES / 3) * 4, 413, 'file_too_large');
    const bytes = Buffer.from(entry.base64, 'base64');
    requireThat(bytes.toString('base64') === entry.base64, 400, 'invalid_base64');
    requireThat(bytes.length <= MAX_FILE_BYTES, 413, 'file_too_large');
    const hash = sha256(bytes);
    return { eventId: entry.eventId, kind: 'file', bytes, payload: { name, sha256: hash, size: bytes.length },
      digest: sha256(JSON.stringify({ name, sha256: hash })) };
  }
  append(user, shareId, input) {
    exactKeys(input, ['entries']);
    requireThat(Array.isArray(input.entries) && input.entries.length > 0 && input.entries.length <= 100);
    const entries = input.entries.map(entry => this.prepareEntry(entry));
    return this.atomic(() => {
      const share = this.access(user, shareId, true);
      let version = share.version;
      const receipts = [];
      for (const entry of entries) {
        const old = this.db.prepare('SELECT seq,digest FROM events WHERE share_id=? AND event_id=?').get(shareId, entry.eventId);
        if (old) {
          requireThat(old.digest === entry.digest, 409, 'event_conflict');
          receipts.push({ eventId: entry.eventId, seq: old.seq }); continue;
        }
        if (entry.kind === 'file') {
          entry.payload.fileId = randomUUID();
          this.db.prepare('INSERT INTO files VALUES(?,?,?,?,?)').run(entry.payload.fileId, shareId, entry.payload.name, entry.payload.sha256, entry.bytes);
        }
        this.db.prepare('INSERT INTO events VALUES(?,?,?,?,?,?,?)').run(shareId, ++version, entry.eventId, entry.digest,
          entry.kind, JSON.stringify(entry.payload), this.now());
        receipts.push({ eventId: entry.eventId, seq: version });
      }
      this.db.prepare('UPDATE shares SET version=?,ready=? WHERE id=?').run(version, !share.published && version !== share.version ? 0 : share.ready, shareId);
      if (share.published && version !== share.version) this.notifyMembers(shareId, share.version ? 'updated' : 'shared', `version:${version}`);
      return { version, receipts };
    });
  }
  read(user, shareId, after = 0, limit = 50) {
    const share = this.access(user, shareId);
    requireThat(Number.isSafeInteger(after) && after >= 0 && after <= share.version);
    requireThat(Number.isSafeInteger(limit) && limit >= 1 && limit <= 100);
    const events = this.db.prepare('SELECT seq,event_id,kind,payload,created_at FROM events WHERE share_id=? AND seq>? ORDER BY seq LIMIT ?')
      .all(shareId, after, limit).map(row => ({ seq: row.seq, eventId: row.event_id, kind: row.kind,
        ...JSON.parse(row.payload), createdAt: row.created_at }));
    const nextCursor = events.at(-1)?.seq ?? after;
    return { share: this.describe(share, user), events, nextCursor, hasMore: nextCursor < share.version };
  }
  file(user, shareId, fileId) {
    this.access(user, shareId);
    const file = this.db.prepare('SELECT name,sha256,bytes FROM files WHERE share_id=? AND id=?').get(shareId, fileId);
    requireThat(file, 404, 'file_not_found');
    return { fileId, name: file.name, sha256: file.sha256, base64: Buffer.from(file.bytes).toString('base64') };
  }
  notifyMembers(shareId, kind, eventKey, onlyUserId) {
    const share = this.db.prepare('SELECT version,owner_id FROM shares WHERE id=? AND published=1').get(shareId);
    if (!share) return;
    const members = this.db.prepare('SELECT m.user_id FROM members m JOIN users u ON u.id=m.user_id WHERE m.share_id=? AND u.enabled=1 AND m.user_id<>?').all(shareId, share.owner_id);
    for (const member of members) {
      if (onlyUserId && member.user_id !== onlyUserId) continue;
      this.db.prepare('INSERT OR IGNORE INTO notifications(user_id,share_id,kind,event_key,version,created_at) VALUES(?,?,?,?,?,?)')
        .run(member.user_id, shareId, kind, eventKey, share.version, this.now());
    }
  }
  inbox(user, after = 0, limit = 50) {
    requireThat(Number.isSafeInteger(after) && after >= 0 && Number.isSafeInteger(limit) && limit >= 1 && limit <= 100);
    const visible = `FROM notifications n JOIN shares s ON s.id=n.share_id JOIN users u ON u.id=s.owner_id
      WHERE n.user_id=? AND s.published=1 AND EXISTS(SELECT 1 FROM members m WHERE m.share_id=s.id AND m.user_id=n.user_id)`;
    const rows = this.db.prepare(`SELECT n.id,n.share_id,n.kind,n.version,n.created_at,n.read_at,s.title,u.username ${visible} AND n.id>? ORDER BY n.id LIMIT ?`).all(user.id, after, limit + 1);
    const items = rows.slice(0, limit).map(row => ({ id: row.id, shareId: row.share_id, kind: row.kind, version: row.version,
      title: row.title, owner: row.username, createdAt: row.created_at, isRead: row.read_at !== null }));
    const unreadCount = this.db.prepare(`SELECT COUNT(*) AS count ${visible} AND n.read_at IS NULL`).get(user.id).count;
    return { items, nextCursor: items.at(-1)?.id ?? after, hasMore: rows.length > limit, unreadCount };
  }
  readNotifications(user, ids) {
    requireThat(Array.isArray(ids) && ids.length > 0 && ids.length <= 100 && ids.every(id => Number.isSafeInteger(id) && id > 0));
    return this.atomic(() => {
      let acknowledged = 0;
      for (const id of new Set(ids)) {
        const result = this.db.prepare(`UPDATE notifications SET read_at=COALESCE(read_at,?) WHERE id=? AND user_id=?
          AND EXISTS(SELECT 1 FROM members m JOIN shares s ON s.id=m.share_id WHERE m.share_id=notifications.share_id AND m.user_id=? AND s.published=1)`)
          .run(this.now(), id, user.id, user.id);
        acknowledged += Number(result.changes);
      }
      return { acknowledged };
    });
  }
}
