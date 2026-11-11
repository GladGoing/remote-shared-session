import { homedir } from 'node:os';
import { join, isAbsolute } from 'node:path';
import { readFile } from 'node:fs/promises';

const root = join(homedir(), '.remote-shared-session');
const settingsPath = process.env.SHARED_SESSION_SETTINGS || join(root, 'settings.json');
if (!isAbsolute(settingsPath)) throw new Error('absolute_settings_path_required');
process.env.SHARED_SESSION_SETTINGS = settingsPath;
let settings = {};
try { settings = JSON.parse(await readFile(settingsPath, 'utf8')); }
catch (error) { if (error.code !== 'ENOENT') throw error; }
process.env.SHARED_SESSION_SERVER ||= settings.server || 'http://127.0.0.1:8787';
process.env.SHARED_SESSION_PROFILE ||= settings.profile || join(root, 'profile.json');
process.env.SHARED_SESSION_DOWNLOAD_DIR ||= settings.downloadDirectory || join(homedir(), 'Downloads', 'SharedSessions');
process.env.SHARED_NOTIFICATIONS ||= settings.notifications === false ? '0' : '1';
if (!isAbsolute(process.env.SHARED_SESSION_PROFILE) || !isAbsolute(process.env.SHARED_SESSION_DOWNLOAD_DIR)) throw new Error('absolute_paths_required');
// Importing does not start stdio; spawn one runtime and forward the host's protocol unchanged.
const { spawn } = await import('node:child_process');
const { fileURLToPath } = await import('node:url');
const child = spawn(process.execPath, [fileURLToPath(new URL('../runtime/mcp.mjs', import.meta.url))], { env: process.env, windowsHide: true, stdio: 'inherit' });
child.once('error', () => { console.error('shared_session_runtime_unavailable'); process.exitCode = 1; });
child.once('exit', code => { process.exitCode = code ?? 1; });
for (const signal of ['SIGINT', 'SIGTERM']) process.once(signal, () => child.kill());
