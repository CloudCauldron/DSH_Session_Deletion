/** Detached Node.js supervisor for interrupted deletion recovery before startup or after exit. */
import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { homedir } from 'node:os';
import { basename, join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import koffi from 'koffi';
import { atomicJSON, birth, cleanAtomicTemps, exists, privateDir, readJSON, safePath, stateDir, sweep } from './core.js';

// libc is an operating-system component, not an additional executable or interpreter.
const libc = koffi.load('libc.so.6');
const flock = libc.func('int flock(int fd, int operation)') as (fd: number, operation: number) => number;
const LOCK_EX = 2; const LOCK_NB = 4;
interface HostMarker { pid: number; birth: string; phase: 'waiting' | 'running' }
export interface GuardOptions { home: string; hostPid?: number; hostBirth?: string; startupTimeoutMs?: number }

export async function waitingHosts(state: string): Promise<Set<number>> {
  const waiting = new Set<number>();
  for (const name of await fs.readdir(join(state, 'hosts'))) {
    if (!/^\d+-\d+\.json$/.test(name)) continue;
    const path = join(state, 'hosts', name);
    const host = await readJSON<HostMarker | undefined>(path);
    if (!host) continue; // A waiting startup may exit between readdir and read.
    if (await birth(host.pid) !== host.birth) await fs.unlink(path);
    else if (host.phase === 'waiting') waiting.add(host.pid);
  }
  return waiting;
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

/** Kernel lock, held on an open inode and automatically released on process death. */
export async function tryLock(path: string, create = false): Promise<fs.FileHandle | undefined> {
  await safePath(path, { missing: create });
  const handle = await fs.open(path, constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0), 0o600);
  if (flock(handle.fd, LOCK_EX | LOCK_NB) === 0) return handle;
  const errno = koffi.errno();
  await handle.close();
  if (errno === 11 || errno === 35) return undefined;
  throw new Error(`Kernel file lock failed (errno ${errno})`);
}
async function offline(options: GuardOptions): Promise<void> {
  const state = stateDir(options.home);
  const pending = join(state, 'pending');
  const excluded = await waitingHosts(state); excluded.add(process.pid);
  if (options.hostPid && await birth(options.hostPid) === options.hostBirth) excluded.add(options.hostPid);
  if ((await otherHosts(options.home, excluded)).length) throw new Error('Another DSH process is using this home; cleanup deferred');
  const hasPending = await exists(pending) && (await fs.readdir(pending)).length > 0;
  const handles: fs.FileHandle[] = [];
  try {
    const root = join(options.home, 'sessions');
    if (hasPending && await exists(root)) for (const project of await fs.readdir(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      for (const session of await fs.readdir(join(root, project.name), { withFileTypes: true })) {
        if (!session.isDirectory()) continue;
        const path = join(root, project.name, session.name, 'session.lock');
        if (!(await exists(path))) continue;
        const lock = await tryLock(path);
        if (!lock) throw new Error('A session still has a live writer; cleanup deferred');
        handles.push(lock);
      }
    }
    await cleanAtomicTemps(state);
    await cleanAtomicTemps(join(options.home, 'storages'));
    // Waiting guards publish before acquiring the lifecycle lock. Their writers may still be live.
    await cleanAtomicTemps(join(state, 'hosts'));
    await sweep(options.home);
  } finally { await Promise.all(handles.map(h => h.close())); }
}

export async function runGuard(options: GuardOptions, announce: (line: string) => void = console.log): Promise<void> {
  options.home = resolve(options.home);
  await safePath(options.home, { directory: true });
  const state = stateDir(options.home);
  await privateDir(join(state, 'hosts'));
  let marker: string | undefined; let lock: fs.FileHandle | undefined; let ready = false;
  try {
    if (options.hostPid) {
      if (!options.hostBirth || await birth(options.hostPid) !== options.hostBirth) throw new Error('Host exited before guard initialization');
      marker = join(state, 'hosts', `${options.hostPid}-${options.hostBirth}.json`);
      await atomicJSON(marker, { pid: options.hostPid, birth: options.hostBirth, phase: 'waiting' });
    }
    const deadline = Date.now() + (options.startupTimeoutMs ?? 60000);
    while (!(lock = await tryLock(join(state, 'lifecycle.lock'), true))) {
      if (Date.now() >= deadline) throw new Error('Another DSH host or cleanup owns this home; close it before starting DSH');
      if (options.hostPid && await birth(options.hostPid) !== options.hostBirth) return;
      await delay(200);
    }
    // Startup lock waiting is bounded; once we own the lock, real recovery may
    // take longer. Tell the gate to wait for completion instead of timing out.
    if (options.hostPid) announce('CLEANING');
    await offline(options);
    if (options.hostPid) {
      if (await birth(options.hostPid) !== options.hostBirth) return;
      await atomicJSON(marker!, { pid: options.hostPid, birth: options.hostBirth, phase: 'running' });
      announce('READY'); ready = true;
      // Poll identity, not a fixed grace period. PID reuse and zombies are handled explicitly.
      while (await birth(options.hostPid) === options.hostBirth) await delay(300);
      await fs.rm(marker!, { force: true });
      await offline(options);
    } else announce('Cleanup verified');
  } catch (e) {
    const error = e instanceof Error ? e.message : String(e);
    // A competing startup that timed out must not race the current owner's
    // atomic status writes or overwrite the progress of its ongoing cleanup.
    if (lock) await atomicJSON(join(state, 'status.json'), { schema: 1, state: 'blocked', error: error.slice(0, 2000), checkedAt: new Date().toISOString() });
    if (!ready) announce('ERROR ' + error);
    throw e;
  } finally {
    if (marker) await fs.rm(marker, { force: true });
    await lock?.close();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [home, hostPid, hostBirth] = process.argv.slice(2);
  try {
    if (!home || process.platform !== 'linux') throw new Error('Usage: node lib/guard.js <DSH_HOME> [host-pid host-start-time]; Linux only');
    await runGuard({ home, hostPid: hostPid ? Number(hostPid) : undefined, hostBirth });
  } catch { process.exitCode = 1; }
}
