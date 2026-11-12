import { spawn } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';
import { SUPPORTED_DSH, privateDir, stateDir } from './core.js';
import { birth } from './platform/index.js';
export const name = 'session-deletion-gate';
const symbol = Symbol.for('dsh-session-deletion.guard');
const singletons = globalThis;
async function start() {
    const entry = process.argv[1];
    const require = createRequire(entry);
    let version;
    try {
        version = require('@deepseek-ai/dsh/package.json').version;
    }
    catch {
        version = JSON.parse(await readFile(join(dirname(entry), '..', 'package.json'), 'utf8')).version;
    }
    if (version !== SUPPORTED_DSH)
        throw new Error(`Session Deletion supports DSH ${SUPPORTED_DSH}; found ${version}. Review before upgrading.`);
    const home = resolve(process.env.DSH_HOME || join(homedir(), '.dsh'));
    await privateDir(stateDir(home));
    const started = await birth(process.pid);
    if (!started)
        throw new Error('Cannot identify DSH host');
    const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
    let healthy = true;
    const child = spawn(process.execPath, [join(project, 'lib', 'guard.js'), home, String(process.pid), started], {
        detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: project,
    });
    child.on('exit', () => { healthy = false; });
    await new Promise((accept, reject) => {
        const timer = setTimeout(() => reject(new Error('Session Deletion guard startup timed out')), 65000);
        let text = '';
        let partial = '';
        child.on('error', e => { clearTimeout(timer); reject(e); });
        child.on('exit', code => { clearTimeout(timer); reject(new Error(`Session Deletion guard exited: ${code}; ${text.slice(0, 1000)}`)); });
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
