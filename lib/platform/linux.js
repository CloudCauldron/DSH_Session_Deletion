import * as fs from 'node:fs/promises';
import { constants } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import koffi from 'koffi';
import { LocalizedError } from '../locale.js';
export const homeVariable = 'HOME';
// Use the already-loaded libc without assuming a glibc-specific filename.
const flock = koffi.load(null).func('int flock(int fd, int operation)');
export function resolvePath(cwd, value, _env) {
    return resolve(cwd, value);
}
export function assertOwner(path, uid) {
    if (uid !== process.getuid())
        throw LocalizedError.english('error.wrongFileOwner', { path });
}
export async function mkdir(path) {
    return fs.mkdir(path, { recursive: true, mode: 0o700 });
}
const durableDirectories = new Set();
export async function secureDir(path, firstCreated) {
    await fs.chmod(path, 0o700);
    // Sync the entire newly-created chain, including the first new entry's parent.
    let requiredParent = firstCreated ? dirname(resolve(firstCreated)) : undefined;
    const synced = [];
    for (let current = path;; current = dirname(current)) {
        await syncDir(current);
        synced.push(current);
        if (current === requiredParent)
            requiredParent = undefined;
        if (dirname(current) === current || (!requiredParent && durableDirectories.has(current)))
            break;
    }
    for (const directory of synced)
        durableDirectories.add(directory);
}
export async function syncDir(path) {
    const h = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
    try {
        await h.sync();
    }
    finally {
        await h.close();
    }
}
export async function rename(from, to) {
    await fs.rename(from, to);
}
export async function birth(pid) {
    try {
        const text = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
        const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
        if (!/^\d+$/.test(fields[19] ?? ''))
            throw LocalizedError.english('error.processIdentityUnreadable');
        return fields[0] === 'Z' ? undefined : fields[19];
    }
    catch (e) {
        if (['ENOENT', 'ESRCH'].includes(e.code || ''))
            return;
        throw e;
    }
}
export async function processes(excluded, executables, matches) {
    const found = [];
    for (const pidText of await fs.readdir('/proc')) {
        const pid = Number(pidText);
        if (!/^\d+$/.test(pidText) || excluded.has(pid))
            continue;
        try {
            const p = '/proc/' + pidText;
            if ((await fs.stat(p)).uid !== process.getuid() || !(await birth(pid)))
                continue;
            const args = (await fs.readFile(join(p, 'cmdline'), 'utf8')).split('\0').filter(Boolean);
            if (!args.length || !executables.includes(basename(args[0]).toLowerCase()))
                continue;
            const cwd = await fs.readlink(join(p, 'cwd'));
            if (!matches(args, cwd))
                continue;
            const env = (await fs.readFile(join(p, 'environ'), 'utf8')).split('\0');
            found.push({ pid, cwd, env });
        }
        catch (e) {
            if (['ENOENT', 'ESRCH'].includes(e.code || '') && !(await birth(pid)))
                continue;
            throw LocalizedError.english('error.sameUserInspection', undefined, { cause: e });
        }
    }
    return found;
}
export async function tryLock(path, create = false, _machineWide = false) {
    const handle = await fs.open(path, constants.O_RDWR | constants.O_NOFOLLOW | (create ? constants.O_CREAT : 0), 0o600);
    if (flock(handle.fd, 2 /* LOCK_EX */ | 4 /* LOCK_NB */) === 0)
        return handle;
    const errno = koffi.errno();
    await handle.close();
    if (errno === 11 || errno === 35)
        return undefined;
    throw LocalizedError.english('error.kernelLock', { errno });
}
