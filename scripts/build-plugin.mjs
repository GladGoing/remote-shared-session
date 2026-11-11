import { readdir, mkdir, copyFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
const root = fileURLToPath(new URL('../', import.meta.url));
const runtime = join(root, 'plugins', 'shared-session', 'runtime');
await mkdir(runtime, { recursive: true });
for (const name of await readdir(join(root, 'src'))) {
  if (name.endsWith('.mjs') || name === 'notify-windows.ps1') await copyFile(join(root, 'src', name), join(runtime, name));
}
console.log('Plugin runtime built: plugins/shared-session');
