/** Detached Node.js supervisor for interrupted deletion recovery before startup or after exit. */
import * as fs from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJSON, cleanAtomicTemps, exists, privateDir, readJSON, safePath, stateDir, sweep } from './core.js';
import { birth, processes, tryLock as lock, usesLockFiles, homeVariable, resolvePath, type Lock } from './platform/index.js';
import { LocalizedError } from './locale.js';

interface HostMarker { pid: number; birth: string; phase: 'waiting' | 'running' }
export interface GuardOptions { home: string; hostPid?: number; hostBirth?: string; startupTimeoutMs?: number }

export async function waitingHosts(state: string): Promise<Set<number>> {
  const waiting = new Set<number>();
  for (const name of await fs.readdir(join(state, 'hosts'))) {
    if (!/^\d+-\d+\.json$/.test(name)) continue;
    const path = join(state, 'hosts', name);
    const host = await readJSON<HostMarker | undefined>(path);
    if (!host) continue; // A waiting startup may exit between readdir and read.
    if (await birth(host.pid) !== host.birth) await fs.rm(path, { force: true });
    else if (host.phase === 'waiting') waiting.add(host.pid);
  }
  return waiting;
}

function isDshEntry(entry: string): boolean {
  const path = entry.replaceAll('\\', '/').toLowerCase();
  if (path.endsWith('/@deepseek-ai/dsh/lib/bin.js') || /\/@deepseek-ai\/dsh-desktop-host\/lib\/(?:index|cli)\.js$/.test(path)
    || /\/dsh(?:\.exe)?$/.test(path)) return true;
  if (/\/apps\/cli\/(?:src\/bin\.ts|lib\/bin\.js)$/.test(path)) {
    // Source checkouts can have any name. Read the CLI package's identity.
    try { if (JSON.parse(readFileSync(join(entry, '../../package.json'), 'utf8')).name === '@deepseek-ai/dsh') return true; }
    catch { return true; } // A moved or unreadable checkout could still own this home.
  }
  return false;
}

function isDshHost(args: readonly string[], cwd: string): boolean {
  for (const [index, arg] of args.entries()) {
    if (/^(?:-e|-p|--eval|--print)(?:=|$)/.test(arg)) return false;
    if (arg.startsWith('-')) continue;
    const entry = resolve(cwd, arg);
    if (isDshEntry(entry)) return true;
    if (index > 0) {
      try {
        const actual = realpathSync.native(entry);
        if (actual !== entry && isDshEntry(actual)) return true;
      } catch (error) {
        // A loader or preload specifier need not be a path in the target cwd.
        if (!['ENOENT', 'ENOTDIR', 'EINVAL', 'ENAMETOOLONG'].includes((error as NodeJS.ErrnoException).code ?? '')) throw error;
      }
    }
    // Stop at the script. Only an option with a separate operand could put
    // another positional before it. Node exposes boolean options' --no- forms.
    const previous = args[index - 1];
    if (previous && (!previous.startsWith('-') || previous === '--' || previous.includes('=') || previous === '--expose-internals'
      || previous.startsWith('--no-') || process.allowedNodeEnvironmentFlags.has('--no-' + previous.slice(2)))) break;
  }
  return false;
}

export async function otherHosts(home: string, excluded: Set<number>): Promise<number[]> {
  const actual = await fs.realpath(home);
  const hosts = await processes(excluded, ['node', 'nodejs', 'dsh', 'electron', 'dsh-desktop', 'deepseek-harness', 'deepseek harness'], isDshHost);
  const found: number[] = [];
  for (const host of hosts) {
    const env = (name: string) => host.env.find(row => row.startsWith(name + '='))?.slice(name.length + 1);
    const configured = env('DSH_HOME');
    let target = configured?.trim() ? configured : join(env(homeVariable) || userInfo().homedir, '.dsh');
    if (target === '~' || /^~[\\/]/.test(target)) target = join(env(homeVariable) || userInfo().homedir, target.slice(2));
    try {
      if (await fs.realpath(resolvePath(host.cwd, target, host.env)) === actual) found.push(host.pid);
    } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
  return found;
}

/** Preserve DSH's writer protocol by default; machineWide additionally requires
 * exclusion across Windows logon sessions for the recovery lifecycle. */
export async function tryLock(path: string, create = false, machineWide = false): Promise<Lock | undefined> {
  await safePath(path, { missing: create || !usesLockFiles });
  return lock(path, create, machineWide);
}
async function offline(options: GuardOptions): Promise<void> {
  const state = stateDir(options.home);
  const pending = join(state, 'pending');
  const excluded = await waitingHosts(state); excluded.add(process.pid);
  if (options.hostPid && await birth(options.hostPid) === options.hostBirth) excluded.add(options.hostPid);
  if ((await otherHosts(options.home, excluded)).length) throw new LocalizedError('error.otherProcessCleanup');
  const hasPending = await exists(pending) && (await fs.readdir(pending)).length > 0;
  const handles: Lock[] = [];
  try {
    const root = join(options.home, 'sessions');
    if (hasPending && await exists(root)) for (const project of await fs.readdir(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      for (const session of await fs.readdir(join(root, project.name), { withFileTypes: true })) {
        if (!session.isDirectory()) continue;
        const path = join(root, project.name, session.name, 'session.lock');
        if (usesLockFiles && !(await exists(path))) continue;
        const lock = await tryLock(path);
        if (!lock) throw new LocalizedError('error.activeWriterCleanup');
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
  const state = stateDir(options.home);
  let marker: string | undefined; let lock: Lock | undefined; let ready = false;
  try {
    await safePath(options.home, { directory: true });
    await privateDir(join(state, 'hosts'));
    const lifecycle = join(await fs.realpath(state), 'lifecycle.lock');
    if (options.hostPid) {
      if (!options.hostBirth || await birth(options.hostPid) !== options.hostBirth) throw new LocalizedError('error.hostExitedBeforeGuard');
      marker = join(state, 'hosts', `${options.hostPid}-${options.hostBirth}.json`);
      await atomicJSON(marker, { pid: options.hostPid, birth: options.hostBirth, phase: 'waiting' });
    }
    const deadline = Date.now() + (options.startupTimeoutMs ?? 60000);
    while (!(lock = await tryLock(lifecycle, true, true))) {
      if (Date.now() >= deadline) throw new LocalizedError('error.homeBusyAtStartup');
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
    try { if (marker) await fs.rm(marker, { force: true }); }
    finally { await lock?.close(); }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  const [home, hostPid, hostBirth] = process.argv.slice(2);
  try {
    if (!home) throw new LocalizedError('error.guardUsage', { command: 'node lib/guard.js <DSH_HOME> [host-pid host-start-time]' });
    await runGuard({ home, hostPid: hostPid ? Number(hostPid) : undefined, hostBirth });
  } catch { process.exitCode = 1; }
}
