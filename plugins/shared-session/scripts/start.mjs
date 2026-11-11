import { pluginSettings } from '../runtime/plugin-settings.mjs';

const settings = await pluginSettings();
Object.assign(process.env, { SHARED_SESSION_SETTINGS: settings.settingsPath, SHARED_SESSION_SERVER: settings.server,
  SHARED_SESSION_PROFILE: settings.profile, SHARED_SESSION_DOWNLOAD_DIR: settings.downloadDirectory,
  SHARED_NOTIFICATIONS: settings.notifications ? '1' : '0', SHARED_CHAT_NOTIFICATIONS: settings.chatNotifications ? '1' : '0' });
// Importing does not start stdio; spawn one runtime and forward the host's protocol unchanged.
const { spawn } = await import('node:child_process');
const { fileURLToPath } = await import('node:url');
const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/mcp.mjs', import.meta.url))], { env: process.env, windowsHide: true, stdio: 'inherit' });
child.once('error', () => { console.error('shared_session_runtime_unavailable'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill());
