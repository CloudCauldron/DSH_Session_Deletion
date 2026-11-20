/** Explicit, one-shot recovery with the DSH home offline. */
import * as fs from 'node:fs/promises';
import { basename, join, resolve, toNamespacedPath } from 'node:path';
import { atomicJSON, cleanAtomicTemps, exists, privateDir, safePath, stateDir, sweep, type DeletionRequest } from './core.js';
import { sameHomeHosts, tryLock } from './locks.js';
import { usesLockFiles, type Lock } from './platform/index.js';
import { LocalizedError } from './locale/errors.js';

const usageError = () => new LocalizedError('error.guardUsage', { command: 'node lib/guard.js <DSH_HOME>' });

async function assertOffline(home: string) {
  if ((await sameHomeHosts(home)).length) throw new LocalizedError('error.otherProcessCleanup');
}

async function offline(home: string, report?: (line: string) => void): Promise<void> {
  const state = stateDir(home);
  const handles: Lock[] = [];
  async function checkWriters(requests: readonly DeletionRequest[]) {
    const root = join(home, 'sessions');
    if (!await exists(root)) return;
    await safePath(root, { directory: true });
    const targets = new Set(requests.flatMap(request => request.plan.directories.map(row => basename(row.path))));
    const writerHomes = [home];
    if (process.platform === 'win32') {
      // rc.5 names its writer semaphore from the path string, including a supplied namespace prefix.
      const canonical = await fs.realpath(home);
      for (const spelling of [canonical, toNamespacedPath(canonical)]) {
        if (!writerHomes.some(path => path.toLowerCase() === spelling.toLowerCase())) writerHomes.push(spelling);
      }
    }
    async function checkWriter(project: string, session: string, hold: boolean) {
      for (const writerHome of writerHomes) {
        const path = join(writerHome, 'sessions', project, session, 'session.lock');
        if (usesLockFiles && !await exists(path)) continue;
        const lock = await tryLock(path);
        if (!lock) throw new LocalizedError('error.activeWriterCleanup');
        if (hold) handles.push(lock);
        else await lock.close();
      }
    }
    for (const project of await fs.readdir(root, { withFileTypes: true })) {
      if (!project.isDirectory()) continue;
      const dir = join(root, project.name);
      // Check exclusive offline use without retaining a descriptor for every old session.
      for (const session of await fs.readdir(dir, { withFileTypes: true }))
        if (session.isDirectory()) await checkWriter(project.name, session.name, false);
      // Look up each confirmed name as rc.5 does, including replacements in another project.
      for (const target of targets)
        if (await exists(join(dir, target))) await checkWriter(project.name, target, true);
    }
  }
  try {
    let resolved = 0;
    await sweep(home, { checkWriters, assertOffline: () => assertOffline(home), onResolved(id, outcome) {
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
