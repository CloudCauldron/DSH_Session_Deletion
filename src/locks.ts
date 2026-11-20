import * as fs from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { safePath } from './core.js';
import { processes, tryLock as lock, usesLockFiles, homeVariable, resolvePath, type Lock } from './platform/index.js';

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

export async function sameHomeHosts(home: string, excludePid?: number): Promise<number[]> {
  const actual = await fs.realpath(home);
  const hosts = await processes(excludePid, ['node', 'nodejs', 'dsh', 'electron', 'dsh-desktop', 'deepseek-harness', 'deepseek harness'], isDshHost);
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
