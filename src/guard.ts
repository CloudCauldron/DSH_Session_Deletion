/** Explicit, one-shot recovery with the DSH home offline. */
import * as fs from 'node:fs/promises';
import { join, resolve, toNamespacedPath } from 'node:path';
import { atomicJSON, cleanAtomicTemps, exists, privateDir, safePath, stateDir, sweep } from './core.js';
import { sameHomeHosts, tryLock } from './locks.js';
import { usesLockFiles, type Lock } from './platform/index.js';
import { LocalizedError } from './locale/errors.js';

const usageError = () => new LocalizedError('error.guardUsage', { command: 'node lib/guard.js <DSH_HOME>' });

async function assertOffline(home: string) {
  if ((await sameHomeHosts(home)).length) throw new LocalizedError('error.otherProcessCleanup');
}

async function offline(home: string, report?: (line: string) => void): Promise<void> {
  const state = stateDir(home);
  const pending = join(state, 'pending');
  const hasPending = await exists(pending) && (await fs.readdir(pending)).length > 0;
  const handles: Lock[] = [];
  try {
    const root = join(home, 'sessions');
    const writerHomes = [home];
    if (hasPending && process.platform === 'win32') {
      // rc.5 names its writer semaphore from the path string, including a supplied namespace prefix.
      const canonical = await fs.realpath(home);
      for (const spelling of [canonical, toNamespacedPath(canonical)]) {
        if (!writerHomes.some(path => path.toLowerCase() === spelling.toLowerCase())) writerHomes.push(spelling);
      }
    }
    if (hasPending && await exists(root)) for (const project of await fs.readdir(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      for (const session of await fs.readdir(join(root, project.name), { withFileTypes: true })) {
        if (!session.isDirectory()) continue;
        for (const writerHome of writerHomes) {
          const path = join(writerHome, 'sessions', project.name, session.name, 'session.lock');
          if (usesLockFiles && !(await exists(path))) continue;
          const lock = await tryLock(path);
          if (!lock) throw new LocalizedError('error.activeWriterCleanup');
          handles.push(lock);
        }
      }
    }
    let resolved = 0;
    await sweep(home, { assertOffline: () => assertOffline(home), onResolved(id, outcome) {
      resolved++;
      report?.(`Deletion ${outcome} for ${id}.`);
    } });
    await cleanAtomicTemps(state);
    await cleanAtomicTemps(join(home, 'storages'));
    if (!resolved) report?.('Nothing pending.');
  } finally { await Promise.all(handles.map(h => h.close())); }
}

export async function runGuard(home: string, report?: (line: string) => void): Promise<void> {
  if (!home) throw usageError();
  home = resolve(home);
  await safePath(home, { directory: true });
  await assertOffline(home);
  const state = stateDir(home);
  await privateDir(state);
  const lock = await tryLock(join(await fs.realpath(state), 'lifecycle.lock'), true, true);
  if (!lock) throw new LocalizedError('error.cleanupBusy');
  try {
    await offline(home, report);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await atomicJSON(join(state, 'status.json'), { schema: 1, state: 'blocked', error: message.slice(0, 2000), checkedAt: new Date().toISOString() });
    throw error;
  } finally { await lock.close(); }
}

if (import.meta.main) {
  try {
    if (process.argv.length !== 3) throw usageError();
    await runGuard(process.argv[2], console.log);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  }
}
