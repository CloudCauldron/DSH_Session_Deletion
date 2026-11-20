/** Explicit, one-shot recovery with the DSH home offline. */
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { atomicJSON, cleanAtomicTemps, exists, privateDir, safePath, stateDir, sweep } from './core.js';
import { sameHomeHosts, tryLock } from './locks.js';
import { usesLockFiles } from './platform/index.js';
import { LocalizedError } from './locale/errors.js';
async function offline(home) {
    const state = stateDir(home);
    const pending = join(state, 'pending');
    const hasPending = await exists(pending) && (await fs.readdir(pending)).length > 0;
    const handles = [];
    try {
        const root = join(home, 'sessions');
        if (hasPending && await exists(root))
            for (const project of await fs.readdir(root, { withFileTypes: true })) {
                if (!project.isDirectory())
                    continue;
                for (const session of await fs.readdir(join(root, project.name), { withFileTypes: true })) {
                    if (!session.isDirectory())
                        continue;
                    const path = join(root, project.name, session.name, 'session.lock');
                    if (usesLockFiles && !(await exists(path)))
                        continue;
                    const lock = await tryLock(path);
                    if (!lock)
                        throw new LocalizedError('error.activeWriterCleanup');
                    handles.push(lock);
                }
            }
        await cleanAtomicTemps(state);
        await cleanAtomicTemps(join(home, 'storages'));
        await sweep(home);
    }
    finally {
        await Promise.all(handles.map(h => h.close()));
    }
}
export async function runGuard(home) {
    home = resolve(home);
    await safePath(home, { directory: true });
    if ((await sameHomeHosts(home)).length)
        throw new LocalizedError('error.otherProcessCleanup');
    const state = stateDir(home);
    await privateDir(state);
    const lock = await tryLock(join(await fs.realpath(state), 'lifecycle.lock'), true, true);
    if (!lock)
        throw new LocalizedError('error.cleanupBusy');
    try {
        await offline(home);
    }
    catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        await atomicJSON(join(state, 'status.json'), { schema: 1, state: 'blocked', error: message.slice(0, 2000), checkedAt: new Date().toISOString() });
        throw error;
    }
    finally {
        await lock.close();
    }
}
if (import.meta.main) {
    try {
        if (process.argv.length !== 3)
            throw new LocalizedError('error.guardUsage', { command: 'node lib/guard.js <DSH_HOME>' });
        await runGuard(process.argv[2]);
        console.log('Cleanup verified');
    }
    catch (error) {
        console.error(error instanceof Error ? error.message : error);
        process.exitCode = 1;
    }
}
