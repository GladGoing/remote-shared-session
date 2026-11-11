import { mkdir, open, rename, lstat, readFile, unlink } from 'node:fs/promises';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { requireThat } from './errors.mjs';

export async function privateJson(path, value) {
  requireThat(isAbsolute(path), 400, 'absolute_profile_path_required');
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  try { requireThat((await lstat(path)).isFile(), 400, 'unsafe_profile_path'); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  const temporary = `${path}.${randomUUID()}.tmp`;
  const handle = await open(temporary, 'wx', 0o600);
  try { await handle.writeFile(JSON.stringify(value)); await handle.sync(); }
  finally { await handle.close(); }
  try { await rename(temporary, path); }
  catch (error) { await unlink(temporary); throw error; }
}
export async function optionalJson(path) {
  try {
    requireThat((await lstat(path)).isFile(), 400, 'unsafe_profile_path');
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}
