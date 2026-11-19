/** Detached Node.js supervisor for interrupted deletion recovery before startup or after exit. */
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { pathToFileURL } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { atomicJSON, cleanAtomicTemps, exists, privateDir, readJSON, safePath, stateDir, sweep } from './core.js';
import { birth, processes, tryLock as lock, usesLockFiles, homeVariable, resolvePath } from './platform/index.js';
import { LocalizedError } from './locale.js';
export async function waitingHosts(state) {
    const waiting = new Set();
    for (const name of await fs.readdir(join(state, 'hosts'))) {
        if (!/^\d+-\d+\.json$/.test(name))
            continue;
        const path = join(state, 'hosts', name);
        const host = await readJSON(path);
        if (!host)
            continue; // A waiting startup may exit between readdir and read.
        if (await birth(host.pid) !== host.birth)
            await fs.rm(path, { force: true });
        else if (host.phase === 'waiting')
            waiting.add(host.pid);
    }
    return waiting;
}
export async function otherHosts(home, excluded) {
    const actual = await fs.realpath(home);
    const hosts = await processes(excluded, ['node', 'nodejs', 'dsh', 'electron', 'dsh-desktop', 'deepseek-harness', 'deepseek harness'], (args, cwd) => args.some((arg, index) => {
        const path = resolve(cwd, arg).replaceAll('\\', '/').toLowerCase();
        return path.endsWith('/@deepseek-ai/dsh/lib/bin.js') || /\/@deepseek-ai\/dsh-desktop-host\/lib\/(?:index|cli)\.js$/.test(path)
            || path.includes('/deepseek-harness/apps/cli/') || (index <= 1 && /\/dsh(?:\.exe)?$/.test(path));
    }));
    const found = [];
    for (const host of hosts) {
        const env = (name) => host.env.find(row => row.startsWith(name + '='))?.slice(name.length + 1);
        const configured = env('DSH_HOME');
        let target = configured?.trim() ? configured : join(env(homeVariable) || userInfo().homedir, '.dsh');
        if (target === '~' || /^~[\\/]/.test(target))
            target = join(env(homeVariable) || userInfo().homedir, target.slice(2));
        try {
            if (await fs.realpath(resolvePath(host.cwd, target, host.env)) === actual)
                found.push(host.pid);
        }
        catch (e) {
            if (e.code !== 'ENOENT')
                throw e;
        }
    }
    return found;
}
/** Preserve DSH's writer protocol by default; machineWide additionally requires
 * exclusion across Windows logon sessions for the recovery lifecycle. */
export async function tryLock(path, create = false, machineWide = false) {
    await safePath(path, { missing: create || !usesLockFiles });
    return lock(path, create, machineWide);
}
async function offline(options) {
    const state = stateDir(options.home);
    const pending = join(state, 'pending');
    const excluded = await waitingHosts(state);
    excluded.add(process.pid);
    if (options.hostPid && await birth(options.hostPid) === options.hostBirth)
        excluded.add(options.hostPid);
    if ((await otherHosts(options.home, excluded)).length)
        throw LocalizedError.english('error.otherProcessCleanup');
    const hasPending = await exists(pending) && (await fs.readdir(pending)).length > 0;
    const handles = [];
    try {
        const root = join(options.home, 'sessions');
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
                        throw LocalizedError.english('error.activeWriterCleanup');
                    handles.push(lock);
                }
            }
        await cleanAtomicTemps(state);
        await cleanAtomicTemps(join(options.home, 'storages'));
        // Waiting guards publish before acquiring the lifecycle lock. Their writers may still be live.
        await cleanAtomicTemps(join(state, 'hosts'));
        await sweep(options.home);
    }
    finally {
        await Promise.all(handles.map(h => h.close()));
    }
}
export async function runGuard(options, announce = console.log) {
    options.home = resolve(options.home);
    const state = stateDir(options.home);
    let marker;
    let lock;
    let ready = false;
    try {
        await safePath(options.home, { directory: true });
        await privateDir(join(state, 'hosts'));
        const lifecycle = join(await fs.realpath(state), 'lifecycle.lock');
        if (options.hostPid) {
            if (!options.hostBirth || await birth(options.hostPid) !== options.hostBirth)
                throw LocalizedError.english('error.hostExitedBeforeGuard');
            marker = join(state, 'hosts', `${options.hostPid}-${options.hostBirth}.json`);
            await atomicJSON(marker, { pid: options.hostPid, birth: options.hostBirth, phase: 'waiting' });
        }
        const deadline = Date.now() + (options.startupTimeoutMs ?? 60000);
        while (!(lock = await tryLock(lifecycle, true, true))) {
            if (Date.now() >= deadline)
                throw LocalizedError.english('error.homeBusyAtStartup');
            if (options.hostPid && await birth(options.hostPid) !== options.hostBirth)
                return;
            await delay(200);
        }
        // Startup lock waiting is bounded; once we own the lock, real recovery may
        // take longer. Tell the gate to wait for completion instead of timing out.
        if (options.hostPid)
            announce('CLEANING');
        await offline(options);
        if (options.hostPid) {
            if (await birth(options.hostPid) !== options.hostBirth)
                return;
            await atomicJSON(marker, { pid: options.hostPid, birth: options.hostBirth, phase: 'running' });
            announce('READY');
            ready = true;
            // Poll identity, not a fixed grace period. PID reuse and zombies are handled explicitly.
            while (await birth(options.hostPid) === options.hostBirth)
                await delay(300);
            await fs.rm(marker, { force: true });
            await offline(options);
        }
        else
            announce('Cleanup verified');
    }
    catch (e) {
        const error = e instanceof Error ? e.message : String(e);
        // A competing startup that timed out must not race the current owner's
        // atomic status writes or overwrite the progress of its ongoing cleanup.
        if (lock)
            await atomicJSON(join(state, 'status.json'), { schema: 1, state: 'blocked', error: error.slice(0, 2000), checkedAt: new Date().toISOString() });
        if (!ready)
            announce('ERROR ' + error);
        throw e;
    }
    finally {
        try {
            if (marker)
                await fs.rm(marker, { force: true });
        }
        finally {
            await lock?.close();
        }
    }
}
if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
    const [home, hostPid, hostBirth] = process.argv.slice(2);
    try {
        if (!home)
            throw LocalizedError.english('error.guardUsage', { command: 'node lib/guard.js <DSH_HOME> [host-pid host-start-time]' });
        await runGuard({ home, hostPid: hostPid ? Number(hostPid) : undefined, hostBirth });
    }
    catch {
        process.exitCode = 1;
    }
}
