import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { optionalJson } from './profile.mjs';
import { requireThat } from './errors.mjs';

// Both the MCP process and standalone hooks must resolve the same account.
export async function pluginSettings(env = process.env) {
  const root = join(homedir(), '.remote-shared-session');
  const settingsPath = env.SHARED_SESSION_SETTINGS || join(root, 'settings.json');
  requireThat(isAbsolute(settingsPath), 400, 'absolute_settings_path_required');
  const settings = await optionalJson(settingsPath) || {};
  const profile = env.SHARED_SESSION_PROFILE || settings.profile || join(root, 'profile.json');
  const downloadDirectory = env.SHARED_SESSION_DOWNLOAD_DIR || settings.downloadDirectory || join(homedir(), 'Downloads', 'SharedSessions');
  requireThat(isAbsolute(profile) && isAbsolute(downloadDirectory), 400, 'absolute_paths_required');
  return { settingsPath, profile, downloadDirectory,
    server: env.SHARED_SESSION_SERVER || settings.server || 'http://127.0.0.1:8787',
    notifications: (env.SHARED_NOTIFICATIONS || (settings.notifications === false || process.platform !== 'win32' ? '0' : '1')) === '1',
    chatNotifications: (env.SHARED_CHAT_NOTIFICATIONS || (settings.chatNotifications === false ? '0' : '1')) === '1',
    receiveMode: settings.receiveMode || 'create', workspace: settings.workspace || null };
}
