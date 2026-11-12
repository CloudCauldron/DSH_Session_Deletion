import { spawn } from 'node:child_process';
import { readFile, realpath } from 'node:fs/promises';
import { resolve, dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { SUPPORTED_DSH, privateDir, stateDir } from './core.js';
import { birth } from './platform/index.js';

export interface Gate { home: string; version: string; healthy(): boolean }
export interface GateContext { provide(name: string, value: Gate): unknown }
export const name = 'session-deletion-gate';
const symbol = Symbol.for('dsh-session-deletion.guard');
const singletons = globalThis as typeof globalThis & { [symbol]?: Promise<Gate> };

export async function hostRequire() {
  return createRequire(process.versions.electron ? resolve(process.argv[1]) : await realpath(process.argv[1]));
}

async function start(): Promise<Gate> {
  const entry = process.argv[1];
  const require = await hostRequire();
  let version: string;
  try { version = require('@deepseek-ai/dsh/package.json').version; }
  catch { version = JSON.parse(await readFile(join(dirname(entry), '..', 'package.json'), 'utf8')).version; }
  if (version !== SUPPORTED_DSH) throw new Error(`Session Deletion supports DSH ${SUPPORTED_DSH}; found ${version}. Review before upgrading.`);
  const { resolveDshHome } = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-home-paths')).href);
  const home = resolveDshHome();
  await privateDir(stateDir(home));
  const started = await birth(process.pid);
  if (!started) throw new Error('Cannot identify DSH host');
  const project = resolve(dirname(fileURLToPath(import.meta.url)), '..');
  let healthy = true;
  const child = spawn(process.execPath, [join(project, 'lib', 'guard.js'), home, String(process.pid), started], {
    detached: true, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], cwd: home,
    env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  });
  child.on('exit', () => { healthy = false; });
  await new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Session Deletion guard startup timed out')), 65000);
    let text = '';
    let partial = '';
    child.on('error', e => { clearTimeout(timer); reject(e); });
    child.on('exit', code => { clearTimeout(timer); reject(new Error(`Session Deletion guard exited: ${code}; ${text.slice(0,1000)}`)); });
    child.stdout.on('data', data => {
      text += String(data); partial += String(data);
      const lines = partial.split('\n'); partial = lines.pop()!;
      for (const line of lines) {
        if (line === 'CLEANING') clearTimeout(timer);
        else if (line === 'READY') { clearTimeout(timer); accept(); }
        else if (line.startsWith('ERROR ')) { clearTimeout(timer); reject(new Error(line)); }
      }
    });
    child.stderr.on('data', data => { text += String(data); });
  });
  child.unref();
  (child.stdout as typeof child.stdout & { unref(): void }).unref();
  (child.stderr as typeof child.stderr & { unref(): void }).unref();
  return { home, version, healthy: () => healthy };
}
export async function apply(ctx: GateContext): Promise<void> {
  singletons[symbol] ??= start();
  ctx.provide('sessionDeletionGate', await singletons[symbol]);
}
