import * as fs from 'node:fs/promises';
import { readFileSync, realpathSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { userInfo } from 'node:os';
import { LocalizedError } from './locale/errors.js';
import { safePath } from './core.js';
import { processes, tryLock as lock, usesLockFiles, homeVariable, resolvePath } from './platform/index.js';
function isDshEntry(entry) {
    const path = entry.replaceAll('\\', '/').toLowerCase();
    if (path.endsWith('/@deepseek-ai/dsh/lib/bin.js') || /\/@deepseek-ai\/dsh-desktop-host\/lib\/(?:index|cli)\.js$/.test(path)
        || /\/dsh(?:\.exe)?$/.test(path))
        return true;
    if (/\/apps\/cli\/(?:src\/bin\.ts|lib\/bin\.js)$/.test(path)) {
        // Source checkouts can have any name. Read the CLI package's identity.
        try {
            if (JSON.parse(readFileSync(join(entry, '../../package.json'), 'utf8')).name === '@deepseek-ai/dsh')
                return true;
        }
        catch {
            return true;
        } // A moved or unreadable checkout could still own this home.
    }
    return false;
}
function dshEntryIndex(args, cwd) {
    for (const [index, arg] of args.entries()) {
        if (/^(?:-e|-p|--eval|--print)(?:=|$)/.test(arg))
            return -1;
        if (arg.startsWith('-'))
            continue;
        const entry = resolve(cwd, arg);
        if (isDshEntry(entry))
            return index;
        if (index > 0) {
            try {
                const actual = realpathSync.native(entry);
                if (actual !== entry && isDshEntry(actual))
                    return index;
            }
            catch (error) {
                // A loader or preload specifier need not be a path in the target cwd.
                if (!['ENOENT', 'ENOTDIR', 'EINVAL', 'ENAMETOOLONG'].includes(error.code ?? ''))
                    throw error;
            }
        }
        // Stop at the script. Only an option with a separate operand could put
        // another positional before it. Node exposes boolean options' --no- forms.
        const previous = args[index - 1];
        if (previous && (!previous.startsWith('-') || previous === '--' || previous.includes('=') || previous === '--expose-internals'
            || previous.startsWith('--no-') || process.allowedNodeEnvironmentFlags.has('--no-' + previous.slice(2))))
            break;
    }
    return -1;
}
export async function sameHomeHosts(home, excludePid) {
    const actual = await fs.realpath(home);
    const hosts = await processes(excludePid, ['node', 'nodejs', 'dsh', 'electron', 'dsh-desktop', 'deepseek-harness', 'deepseek harness'], dshEntryIndex);
    const found = [];
    for (const host of hosts) {
        const env = (name) => {
            const value = host.env.find(row => row.startsWith(name + '='))?.slice(name.length + 1);
            if (value === undefined && host.envFile)
                throw new LocalizedError('error.hostHomeUnknown', { pid: host.pid });
            return value;
        };
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
