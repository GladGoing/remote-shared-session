'use strict';
const $ = id => document.getElementById(id);
const state = { user: null, csrf: '', shares: [], directory: [], selected: null, share: null, cursor: 0,
  filter: 'all', generation: 0, loading: false, polling: false, events: new Set(), recipients: [], resetTarget: null,
  inbox: new Map(), inboxCursor: 0, inboxMore: false, stream: null, desktop: false };
const errors = {
  invalid_credentials: '账号或密码不正确，或账号已停用。', authentication_required: '登录已过期，请重新登录。',
  admin_required: '只有管理员可以进行此操作。', username_exists: '这个账号已经存在，请换一个账号。',
  password_too_short: '密码至少需要 12 个字符。', last_admin_required: '需要至少保留一名启用的管理员。',
  cannot_disable_self: '不能停用当前登录的账号。', cannot_reset_self: '请使用其他管理员账号重置你的密码。',
  member_disabled: '这位成员已停用，请先由管理员启用。', recipient_not_found: '未找到这位成员。',
  recipient_required: '请至少添加一位接收成员。', draft_changed: '草稿内容或接收成员已更新，请重新核对后发布。',
  share_not_found: '未找到会话，或你已无权访问。', connection_expired: '连接已过期，请从 Codex 重新发起。',
  connection_already_decided: '这次连接已经处理，请回到 Codex 查看连接状态。', connection_denied: '这次连接已取消。',
  csrf_required: '页面状态已更新，请刷新后重试。', invalid_origin: '当前访问地址不受支持。',
  login_rate_limited: '操作较频繁，请稍后再试。', invalid_request: '请检查输入内容。',
};
function node(tag, className, text) {
  const result = document.createElement(tag); if (className) result.className = className;
  if (text !== undefined) result.textContent = text; return result;
}
function button(text, className, action) {
  const result = node('button', className, text); result.type = 'button';
  result.addEventListener('click', () => run(action)); return result;
}
let toastTimer;
function toast(message) { $('toast').textContent = message; $('toast').hidden = false; clearTimeout(toastTimer); toastTimer = setTimeout(() => { $('toast').hidden = true; }, 5000); }
const messageOf = error => errors[error.code] || '操作未完成，请检查连接后重试。';
async function run(action) { try { await action(); } catch (error) { toast(messageOf(error)); } }
async function api(path, method = 'GET', body) {
  const response = await fetch(path, { method, credentials: 'same-origin', redirect: 'error',
    headers: { ...(body === undefined ? {} : { 'Content-Type': 'application/json' }), ...(!['GET', 'HEAD'].includes(method) && state.csrf ? { 'X-CSRF-Token': state.csrf } : {}) },
    body: body === undefined ? undefined : JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) {
    if (response.status === 401 && state.user) signedOut();
    throw Object.assign(new Error(result.error), { code: result.error, status: response.status });
  }
  return result;
}
function signedOut() {
  state.stream?.close(); state.stream = null; state.inbox.clear(); state.inboxCursor = 0; state.desktop = false;
  $('unread-count').hidden = true; $('inbox-list').replaceChildren(); document.title = '共享会话';
  state.user = null; state.csrf = ''; state.shares = []; state.directory = []; state.selected = null; state.share = null;
  state.cursor = 0; state.loading = false; state.events.clear(); state.generation++;
  $('thread-events').replaceChildren(); $('session-list').replaceChildren(); $('member-table').replaceChildren();
  $('app-screen').hidden = true; $('login-screen').hidden = false;
  for (const dialog of document.querySelectorAll('dialog[open]')) dialog.close();
  $('login-password').value = '';
}
function signedIn(result) {
  state.user = result.user; state.csrf = result.csrfToken;
  $('login-screen').hidden = true; $('app-screen').hidden = false;
  $('account-name').textContent = state.user.username;
  $('account-role').textContent = state.user.role === 'admin' ? '管理员' : '成员';
  $('avatar').textContent = state.user.username.slice(0, 1).toUpperCase();
  $('nav-members').hidden = state.user.role !== 'admin';
}
$('login-form').addEventListener('submit', async event => {
  event.preventDefault(); $('login-error').textContent = ''; $('login-submit').disabled = true;
  try {
    const result = await api('/api/web/login', 'POST', { username: $('login-username').value.trim(), password: $('login-password').value });
    $('login-password').value = ''; signedIn(result); await start();
  } catch (error) { if (state.user) toast(messageOf(error)); else $('login-error').textContent = messageOf(error); }
  finally { $('login-submit').disabled = false; }
});
$('logout').addEventListener('click', () => run(async () => { await api('/api/web/logout', 'POST'); signedOut(); }));

function showView(name) {
  for (const view of ['sessions', 'inbox', 'members', 'connection']) $(view + '-view').hidden = view !== name;
  for (const [id, view] of [['nav-sessions', 'sessions'], ['nav-inbox', 'inbox'], ['nav-members', 'members'], ['nav-connect', 'connection']]) $(id).classList.toggle('active', view === name);
}
function normalLocation() { history.replaceState({}, '', '/'); }
$('nav-sessions').addEventListener('click', () => run(async () => { normalLocation(); showView('sessions'); await refreshShares(); }));
$('nav-members').addEventListener('click', () => run(async () => { normalLocation(); showView('members'); await loadMembers(); }));
$('nav-inbox').addEventListener('click', () => run(async () => { normalLocation(); showView('inbox'); await loadInbox(); }));
$('nav-connect').addEventListener('click', () => run(async () => { normalLocation(); await showConnection(null); }));
$('share-help').addEventListener('click', () => $('help-dialog').showModal());
for (const element of document.querySelectorAll('[data-close]')) element.addEventListener('click', () => $(element.dataset.close).close());
for (const id of ['member-dialog', 'password-dialog']) $(id).addEventListener('close', () => { $(id).querySelector('form').reset(); $(id).querySelector('.error').textContent = ''; });

function filteredShares() {
  const search = $('search').value.trim().toLowerCase();
  return state.shares.filter(share => {
    const own = share.owner === state.user.username;
    const matches = state.filter === 'all' || (state.filter === 'sent' && own && share.status === 'shared') ||
      (state.filter === 'received' && !own) || (state.filter === 'draft' && share.status !== 'shared');
    return matches && `${share.title} ${share.owner}`.toLowerCase().includes(search);
  });
}
const statusText = share => share.status === 'shared' ? '已共享' : share.status === 'draft' ? '待发布' : '准备中';
function renderList() {
  const shares = filteredShares(); const scroll = $('session-list').scrollTop;
  $('session-list').replaceChildren(); $('list-count').textContent = `${shares.length} 个会话`;
  $('empty-list').hidden = shares.length > 0;
  for (const share of shares) {
    const item = button('', 'session-item', () => openShare(share.id));
    item.classList.toggle('active', state.selected === share.id);
    item.append(node('h3', '', share.title));
    const meta = node('div', 'session-item-meta'); meta.append(node('span', '', share.owner), node('span', '', statusText(share)));
    item.append(meta); item.setAttribute('aria-label', `${share.title}，${share.owner}，${statusText(share)}`);
    $('session-list').append(item);
  }
  $('session-list').scrollTop = scroll;
}
async function refreshShares() {
  const result = await api('/api/shares'); if (!state.user) return;
  state.shares = result.shares; renderList();
}
for (const filter of document.querySelectorAll('[data-filter]')) filter.addEventListener('click', () => {
  state.filter = filter.dataset.filter;
  for (const other of document.querySelectorAll('[data-filter]')) other.classList.toggle('selected', other === filter);
  renderList();
});
$('search').addEventListener('input', renderList);
$('refresh').addEventListener('click', () => run(async () => { await refreshShares(); if (state.selected) await openShare(state.selected); }));
function renderHeading() {
  const share = state.share; if (!share) return;
  $('thread-title').textContent = share.title; $('thread-owner').textContent = `由 ${share.owner} 分享`;
  $('thread-status').textContent = statusText(share); $('thread-status').className = 'badge' + (share.status === 'shared' ? '' : ' draft');
  $('thread-summary').textContent = `${state.events.size} 项内容 · ${share.status === 'shared' ? '已发布的会话可读取后续更新' : '发布前仅自己可见'}`;
  $('draft-notice').hidden = share.status === 'shared';
  $('draft-notice').textContent = share.status === 'uploading' ? '会话正在准备，请等待 Codex 完成上传后再核对。' : '这是仅自己可见的草稿。请核对会话、文件和接收成员，再确认发布。';
  $('publish').hidden = !share.canManage || share.status === 'shared';
  $('publish').disabled = share.status !== 'draft'; $('share-members').hidden = !share.canManage;
}
function sizeText(bytes) { return bytes < 1024 ? `${bytes} B` : bytes < 1024 * 1024 ? `${(bytes / 1024).toFixed(1)} KB` : `${(bytes / 1024 / 1024).toFixed(1)} MB`; }
function appendEvents(events) {
  for (const event of events) {
    if (state.events.has(event.seq)) continue; state.events.add(event.seq);
    if (event.kind === 'message') {
      const item = node('article', 'message'); const header = node('div', 'message-header');
      header.append(node('strong', '', event.role === 'assistant' ? 'Codex' : state.share.owner), node('span', '', new Date(event.createdAt).toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hour12: false })));
      item.append(header, node('pre', '', event.text)); $('thread-events').append(item);
    } else if (event.kind === 'file') {
      const wrap = node('div', 'file-event'); const attachment = button('', 'attachment', () => downloadFile(event));
      attachment.append(node('span', '', '▧'));
      const info = node('span', 'file-name', event.name); info.append(node('span', 'file-details', sizeText(event.size)));
      attachment.append(info, node('span', 'file-action', '下载文件')); wrap.append(attachment); $('thread-events').append(wrap);
    }
  }
}
async function fetchUpdates(generation = state.generation) {
  const id = state.selected; if (!id) return;
  for (let page = 0; page < 200; page++) {
    const result = await api(`/api/shares/${id}/events?after=${state.cursor}&limit=100`);
    if (generation !== state.generation || id !== state.selected || !state.user) return;
    const revision = state.share?.revision;
    state.share = result.share; appendEvents(result.events); state.cursor = result.nextCursor; renderHeading();
    if (result.share.canManage && revision !== result.share.revision) await renderRecipients(generation);
    if (!result.hasMore) return;
  }
  throw Object.assign(new Error('too_many_events'), { code: 'too_many_events' });
}
async function openShare(id) {
  const generation = ++state.generation; state.selected = id; state.share = null; state.cursor = 0; state.events.clear();
  state.loading = true; $('thread-events').replaceChildren(); $('recipient-list').replaceChildren();
  $('reader-empty').hidden = true; $('reader-content').hidden = false; $('thread-title').textContent = '正在读取…';
  $('share-members').hidden = true; $('publish').hidden = true; $('draft-notice').hidden = true;
  renderList();
  try { await fetchUpdates(generation); }
  catch (error) {
    if (generation === state.generation) { $('reader-content').hidden = true; $('reader-empty').hidden = false; }
    throw error;
  } finally { if (generation === state.generation) state.loading = false; }
}
async function renderRecipients(generation) {
  const id = state.selected;
  const result = await api(`/api/shares/${id}/members`);
  if (generation !== state.generation || id !== state.selected) return;
  state.recipients = result.members; const selected = $('recipient-select').value;
  $('recipient-list').replaceChildren(); $('member-count').textContent = `(${result.members.length})`;
  for (const member of result.members) {
    const chip = node('span', 'recipient', member.username + (member.enabled ? '' : ' · 已停用'));
    const remove = button('×', '', async () => {
      await api(`/api/shares/${id}/members/${encodeURIComponent(member.username)}`, 'DELETE');
      await fetchUpdates(); toast('已移除这位成员的访问权限。');
    });
    remove.setAttribute('aria-label', `移除 ${member.username}`); chip.append(remove); $('recipient-list').append(chip);
  }
  $('recipient-select').replaceChildren();
  const available = state.directory.filter(member => member.username !== state.user.username && !result.members.some(saved => saved.username === member.username));
  for (const member of available) { const option = node('option', '', member.username); option.value = member.username; $('recipient-select').append(option); }
  if (available.some(member => member.username === selected)) $('recipient-select').value = selected;
  $('recipient-select').disabled = !available.length;
  $('recipient-form').querySelector('button').disabled = !available.length;
  if (!available.length) $('recipient-select').append(node('option', '', '暂无可添加成员'));
}
$('recipient-form').addEventListener('submit', event => {
  event.preventDefault(); run(async () => {
    if (!state.selected || !$('recipient-select').value) return;
    await api(`/api/shares/${state.selected}/members`, 'POST', { username: $('recipient-select').value });
    await fetchUpdates(); toast('已添加接收成员。');
  });
});
$('publish').addEventListener('click', () => run(async () => {
  const share = state.share; if (!share) return; $('publish').disabled = true;
  try {
    await api(`/api/shares/${share.id}/publish`, 'POST', { version: share.version, revision: share.revision });
    await fetchUpdates(); await refreshShares(); toast('已发布，接收成员现在可以在 Codex 中读取。');
  } catch (error) { await fetchUpdates(); throw error; }
  finally { renderHeading(); }
}));
async function downloadFile(event) {
  const result = await api(`/api/shares/${state.selected}/files/${event.fileId}`);
  const bytes = Uint8Array.from(atob(result.base64), char => char.charCodeAt(0));
  const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', bytes))].map(byte => byte.toString(16).padStart(2, '0')).join('');
  if (hash !== result.sha256) { toast('文件校验未通过，请重新获取。'); return; }
  const url = URL.createObjectURL(new Blob([bytes], { type: 'application/octet-stream' }));
  const anchor = node('a'); anchor.href = url; anchor.download = result.name; document.body.append(anchor); anchor.click(); anchor.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000); toast('文件校验通过，已开始下载。');
}

async function loadMembers() {
  const { members } = await api('/api/users'); $('member-table').replaceChildren();
  for (const member of members) {
    const row = node('tr'); const identity = node('div', 'member-identity');
    identity.append(node('span', 'avatar', member.username.slice(0, 1).toUpperCase()), node('strong', '', member.username));
    const nameCell = node('td'); nameCell.append(identity); row.append(nameCell, node('td', '', member.role === 'admin' ? '管理员' : '成员'));
    const statusCell = node('td'); statusCell.append(node('span', 'badge' + (member.enabled ? '' : ' disabled'), member.enabled ? '已启用' : '已停用')); row.append(statusCell);
    const actions = node('div', 'row-actions');
    if (member.id === state.user.id) actions.append(node('span', 'small muted', '当前账号'));
    else {
      actions.append(button(member.role === 'admin' ? '设为成员' : '设为管理员', '', async () => {
        await api(`/api/users/${encodeURIComponent(member.username)}`, 'PATCH', { role: member.role === 'admin' ? 'member' : 'admin' });
        await loadMembers(); toast('成员角色已更新。');
      }));
      actions.append(button('重置密码', '', () => {
        state.resetTarget = member.username; $('password-form').reset(); $('reset-username').value = member.username; $('password-error').textContent = '';
        $('reset-target').textContent = `为 ${member.username} 设置新密码。保存后，该成员需要重新登录。`; $('password-dialog').showModal();
      }));
      actions.append(button(member.enabled ? '停用' : '启用', member.enabled ? 'danger' : '', async () => {
        await api(`/api/users/${encodeURIComponent(member.username)}`, 'PATCH', { enabled: !member.enabled });
        await loadMembers(); state.directory = (await api('/api/directory')).members; toast(member.enabled ? '账号已停用，已有登录已失效。' : '账号已启用。');
      }));
    }
    const actionCell = node('td'); actionCell.append(actions); row.append(actionCell); $('member-table').append(row);
  }
}

function unreadCount(count) {
  $('unread-count').textContent = count > 99 ? '99+' : String(count); $('unread-count').hidden = !count;
  document.title = count ? `(${count}) 共享会话` : '共享会话';
}
function renderInbox() {
  $('inbox-list').replaceChildren(); $('inbox-empty').hidden = state.inbox.size > 0;
  for (const item of [...state.inbox.values()].sort((a, b) => b.id - a.id)) {
    const row = button('', 'inbox-item' + (item.isRead ? '' : ' unread'), async () => {
      showView('sessions'); await refreshShares(); await openShare(item.shareId);
      await api('/api/inbox/read', 'POST', { ids: [item.id] }); item.isRead = true; renderInbox();
      unreadCount((await api('/api/inbox?limit=1')).unreadCount);
    });
    const text = node('div'); text.append(node('strong', '', item.title), node('p', 'muted', `${item.owner} ${item.kind === 'shared' ? '分享了会话' : '更新了会话'} · 版本 ${item.version}`));
    row.append(node('span', 'inbox-dot', item.isRead ? '○' : '●'), text, node('time', 'small muted', new Date(item.createdAt).toLocaleString('zh-CN')));
    $('inbox-list').append(row);
  }
  $('inbox-more').hidden = !state.inboxMore;
}
async function loadInbox(more = false) {
  // The server cursor is ascending; load bounded pages, then display newest first.
  const batch = await api(`/api/inbox?after=${more ? state.inboxCursor : 0}&limit=100`);
  if (!more) state.inbox.clear();
  for (const item of batch.items) state.inbox.set(item.id, item);
  state.inboxCursor = batch.nextCursor; state.inboxMore = batch.hasMore; unreadCount(batch.unreadCount); renderInbox();
}
$('inbox-more').addEventListener('click', () => run(() => loadInbox(true)));
$('enable-notifications').addEventListener('click', () => run(async () => {
  if (!('Notification' in window)) { toast('当前浏览器不支持桌面提醒，请使用 Codex 插件提醒。'); return; }
  if (state.desktop) { state.desktop = false; $('enable-notifications').textContent = '开启网页桌面提醒'; return; }
  const permission = await Notification.requestPermission(); state.desktop = permission === 'granted';
  $('enable-notifications').textContent = state.desktop ? '关闭网页桌面提醒' : '开启网页桌面提醒';
  toast(state.desktop ? '已开启；保留此页面即可接收新内容提醒。' : '浏览器未允许通知，可在站点设置中调整。');
}));
function connectInbox() {
  state.stream?.close(); const stream = new EventSource('/api/inbox/stream'); state.stream = stream;
  let initial = true;
  stream.onopen = () => { $('inbox-status').textContent = '提醒已连接 · 新内容会自动送达'; };
  stream.onerror = () => { $('inbox-status').textContent = '连接中断，正在重连；未读记录已保留。'; };
  stream.addEventListener('reauth', () => { stream.close(); signedOut(); });
  stream.onmessage = event => run(async () => {
    if (state.stream !== stream || !state.user) return;
    const batch = JSON.parse(event.data); unreadCount(batch.unreadCount);
    const received = batch.items.filter(item => !item.isRead && !state.inbox.has(item.id));
    for (const item of batch.items) state.inbox.set(item.id, item);
    if (received.length && !initial) {
      toast('收到新的共享内容，可前往收件箱查看。');
      if (state.desktop && Notification.permission === 'granted') {
        const notice = new Notification('共享会话', { body: '收到新的共享内容，打开收件箱查看。', tag: 'shared-session-update' });
        notice.onclick = () => { window.focus(); showView('inbox'); run(() => loadInbox()); notice.close(); };
      }
      await refreshShares();
    }
    initial = batch.hasMore; renderInbox();
    // Refresh current ACL/read state after batches that only update the unread count.
    if (!batch.items.length && !$('inbox-view').hidden) await loadInbox();
  });
}
$('add-member').addEventListener('click', () => { $('member-form').reset(); $('member-error').textContent = ''; $('member-dialog').showModal(); });
$('member-form').addEventListener('submit', async event => {
  event.preventDefault(); const submit = $('member-form').querySelector('[type=submit]'); submit.disabled = true;
  try {
    await api('/api/users', 'POST', { username: $('new-username').value.trim(), password: $('new-password').value, role: $('new-role').value });
    $('member-dialog').close(); await loadMembers(); state.directory = (await api('/api/directory')).members; toast('成员已创建。');
  } catch (error) { $('member-error').textContent = messageOf(error); }
  finally { submit.disabled = false; }
});
$('reset-confirm').addEventListener('input', () => $('reset-confirm').setCustomValidity(''));
$('password-form').addEventListener('submit', async event => {
  event.preventDefault();
  if ($('reset-password').value !== $('reset-confirm').value) { $('reset-confirm').setCustomValidity('两次输入的密码不一致。'); $('reset-confirm').reportValidity(); return; }
  const submit = $('password-form').querySelector('[type=submit]'); submit.disabled = true;
  try { await api(`/api/users/${encodeURIComponent(state.resetTarget)}/password`, 'POST', { password: $('reset-password').value }); $('password-dialog').close(); toast('密码已重置，该成员需要重新登录。'); }
  catch (error) { $('password-error').textContent = messageOf(error); }
  finally { submit.disabled = false; }
});

async function showConnection(code) {
  showView('connection'); $('device-authorization').hidden = !code; $('device-result').textContent = '';
  $('approve-device').disabled = false; $('deny-device').disabled = false;
  $('connect-title').textContent = code ? '确认连接这台 Codex' : '将共享空间连接到 Codex';
  $('connect-description').textContent = code ? '请确认这是你刚刚在 Codex 中发起的连接。' : '在已经配置共享连接的 Codex 中说：“连接共享空间”。打开它返回的登录地址，即可在此确认连接。';
  if (!code) return;
  const result = await api(`/api/device/${encodeURIComponent(code)}`);
  $('device-code').textContent = result.userCode; $('connect-account').textContent = `将使用账号 ${state.user.username} 连接。`;
  const pending = result.status === 'pending'; $('approve-device').disabled = !pending; $('deny-device').disabled = !pending;
  if (!pending) $('device-result').textContent = result.status === 'denied' ? '这次连接已取消。' : '授权已确认，请回到 Codex 查看连接状态。';
}
async function decideConnection(approved) {
  const code = new URL(location.href).searchParams.get('code');
  $('approve-device').disabled = true; $('deny-device').disabled = true;
  try { await api(`/api/device/${encodeURIComponent(code)}`, 'POST', { approved }); $('device-result').textContent = approved ? '授权已确认，请回到 Codex 完成连接。' : '连接已取消。'; }
  catch (error) { $('approve-device').disabled = false; $('deny-device').disabled = false; throw error; }
}
$('approve-device').addEventListener('click', () => run(() => decideConnection(true)));
$('deny-device').addEventListener('click', () => run(() => decideConnection(false)));
async function start() {
  const params = new URL(location.href).searchParams;
  state.directory = (await api('/api/directory')).members;
  await refreshShares();
  await loadInbox(); connectInbox();
  if (location.pathname === '/connect' && params.get('code')) return showConnection(params.get('code'));
  if (location.pathname === '/inbox') { showView('inbox'); return; }
  showView('sessions');
  const id = params.get('share');
  if (id) await openShare(id);
  else if (state.shares.length) await openShare(state.shares[0].id);
  else { $('reader-content').hidden = true; $('reader-empty').hidden = false; }
}
setInterval(async () => {
  if (!state.user || state.polling || state.loading || document.visibilityState !== 'visible') return;
  state.polling = true;
  try {
    const { user } = await api('/api/me');
    state.user = user; $('nav-members').hidden = user.role !== 'admin';
    if (!$('sessions-view').hidden) { await refreshShares(); if (state.selected) await fetchUpdates(); }
  } catch (error) {
    if (error.status === 404) { $('reader-content').hidden = true; $('reader-empty').hidden = false; state.selected = null; state.share = null; state.generation++; toast(messageOf(error)); }
  } finally { state.polling = false; }
}, 5000);
run(async () => {
  const session = await api('/api/web/session');
  if (session.user) { signedIn(session); await start(); }
  else if (session.setupRequired) $('login-error').textContent = '尚未创建管理员账号，请联系服务管理员初始化。';
});
