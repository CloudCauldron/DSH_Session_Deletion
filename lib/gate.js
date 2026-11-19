import { spawn } from 'node:child_process';
import { realpath } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { SUPPORTED_DSH, STATE_NAME, privateDir, stateDir } from './core.js';
import { birth } from './platform/index.js';
import { LocalizedError } from './locale.js';
export const name = 'session-deletion-gate';
const symbol = Symbol.for(STATE_NAME + '.guard');
const singletons = globalThis;
export async function hostRequire() {
    return createRequire(process.versions.electron ? resolve(process.argv[1]) : await realpath(process.argv[1]));
}
async function start() {
    const require = await hostRequire();
    const { version } = require('@deepseek-ai/dsh/package.json');
    if (version !== SUPPORTED_DSH)
        throw LocalizedError.english('error.incompatibleDsh', { supported: SUPPORTED_DSH, found: version });
    const { resolveDshHome } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-home-paths')).href);
    const home = resolveDshHome();
    await privateDir(stateDir(home));
    const started = await birth(process.pid);
    if (!started)
        throw LocalizedError.english('error.hostIdentity');
    const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    let healthy = true;
    const child = spawn(process.execPath, [join(project, 'lib', 'guard.js'), home, String(process.pid), started], {
        detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: home,
        env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
    });
    child.on('exit', () => { healthy = false; });
    await new Promise((accept, reject) => {
        const timer = setTimeout(() => reject(LocalizedError.english('error.guardStartTimeout')), 65000);
        let text = '';
        let partial = '';
        child.on('error', e => { clearTimeout(timer); reject(e); });
        child.on('exit', code => {
            clearTimeout(timer);
            reject(LocalizedError.english('error.guardExit', { code: String(code) }, { failures: text ? [text.slice(0, 1000)] : [] }));
        });
        child.stdout.on('data', data => {
            text += String(data);
            partial += String(data);
            const lines = partial.split('\n');
            partial = lines.pop();
            for (const line of lines) {
                if (line === 'CLEANING')
                    clearTimeout(timer);
                else if (line === 'READY') {
                    clearTimeout(timer);
                    accept();
                }
                else if (line.startsWith('ERROR ')) {
                    clearTimeout(timer);
                    reject(new Error(line));
                }
            }
        });
        child.stderr.on('data', data => { text += String(data); });
    });
    child.unref();
    child.stdout.unref();
    child.stderr.unref();
    return { home, version, healthy: () => healthy };
}
export async function apply(ctx) {
    singletons[symbol] ??= start();
    ctx.provide('sessionDeletionGate', await singletons[symbol]);
}
