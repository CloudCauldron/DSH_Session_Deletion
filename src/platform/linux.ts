import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import koffi from 'koffi';
import type { Lock } from './index.js';

const flock = koffi.load('libc.so.6').func('int flock(int fd, int operation)');

export function assertOwner(path: string, uid: number): void {
  if (uid !== process.getuid!()) throw new Error(`Not owned by this user: ${path}`);
}
export async function mkdir(path: string): Promise<string | undefined> {
  return fs.mkdir(path, { recursive: true, mode: 0o700 });
}
const durableDirectories = new Set<string>();
export async function secureDir(path: string, firstCreated?: string): Promise<void> {
  await fs.chmod(path, 0o700);
  // Sync the entire newly-created chain, including the first new entry's parent.
  let requiredParent = firstCreated ? dirname(resolve(firstCreated)) : undefined;
  const synced: string[] = [];
  for (let current = path;; current = dirname(current)) {
    await syncDir(current); synced.push(current);
    if (current === requiredParent) requiredParent = undefined;
    if (dirname(current) === current || (!requiredParent && durableDirectories.has(current))) break;
  }
  for (const directory of synced) durableDirectories.add(directory);
}
export async function syncDir(path: string): Promise<void> {
  const h = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await h.sync(); } finally { await h.close(); }
}
export async function rename(from: string, to: string): Promise<void> {
  await fs.rename(from, to);
}
export async function birth(pid: number): Promise<string | undefined> {
  try {
    const text = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    if (!/^\d+$/.test(fields[19] ?? '')) throw new Error('Cannot read process identity');
    return fields[0] === 'Z' ? undefined : fields[19];
  } catch (e) { if (['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code || '')) return; throw e; }
}
export async function otherHosts(home: string, excluded: Set<number>): Promise<number[]> {
  const found: number[] = [];
  for (const pidText of await fs.readdir('/proc')) {
    if (!/^\d+$/.test(pidText) || excluded.has(Number(pidText))) continue;
    try {
      const p = `/proc/${pidText}`;
      if ((await fs.stat(p)).uid !== process.getuid!() || !(await birth(Number(pidText)))) continue;
      const args = (await fs.readFile(join(p, 'cmdline'), 'utf8')).split('\0').filter(Boolean);
      if (!args.length || !['dsh', 'node', 'nodejs'].includes(basename(args[0]))) continue;
      if (!args.slice(0, 4).some(a => a.includes('@deepseek-ai/dsh/') || a.includes('deepseek-harness') || a.endsWith('/dsh'))) continue;
      const env = (await fs.readFile(join(p, 'environ'), 'utf8')).split('\0');
      const configured = env.find(x => x.startsWith('DSH_HOME='))?.slice(9);
      if (resolve(configured || join(homedir(), '.dsh')) === home) found.push(Number(pidText));
    } catch (e) {
      if (['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code || '')) continue;
      throw new Error('Cannot inspect a same-user process; cleanup deferred', { cause: e });
    }
  }
  return found;
}
export async function tryLock(path: string, create = false): Promise<Lock | undefined> {
  const handle = await fs.open(path, constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0), 0o600);
  if (flock(handle.fd, 2 /* LOCK_EX */ | 4 /* LOCK_NB */) === 0) return handle;
  const errno = koffi.errno();
  await handle.close();
  if (errno === 11 || errno === 35) return undefined;
  throw new Error(`Kernel file lock failed (errno ${errno})`);
}
