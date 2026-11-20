import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { basename, dirname, join, toNamespacedPath } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { runGuard } from '../lib/guard.js';
import { tryLock, sameHomeHosts } from '../lib/locks.js';
import { exists, listRequests, stateDir, atomicJSON, readJSON } from '../lib/core.js';
import { birth, homeVariable } from '../lib/platform/index.js';
import { fixture } from './fixtures.ts';
import type { ChildProcess } from 'node:child_process';

interface GuardStatus { state: string; completed: number; checkedAt?: string; error?: string }
function pid(child: ChildProcess): number { assert(child.pid !== undefined, 'fixture process started'); return child.pid; }
async function identity(child: ChildProcess): Promise<string> { const value = await birth(pid(child)); assert(value); return value; }

function finished(child: ChildProcess): Promise<{ code: number | null; signal: NodeJS.Signals | null }> {
  return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal })));
}
void test('kernel writer lock defers all cleanup and preserves pending request', async () => {
  const f=await fixture(); let lock;
  try {
    await f.queue();
    lock=await tryLock(join(f.home,'sessions/project',f.ids.main,'session.lock'));
    assert.ok(lock);
    const guard=spawn(process.execPath,['lib/guard.js',f.home],{stdio:'ignore'});
    assert.equal((await finished(guard)).code,1);
    assert.equal(await exists(join(f.home,'sessions/project',f.ids.main)),true);
    assert.equal((await listRequests(f.home)).length,1);
    await lock.close();lock=undefined;
    const installed=join(f.base,'installed-plugin');
    await fs.symlink(process.cwd(),installed,'junction');
    const retry=spawn(process.execPath,[join(installed,'lib/guard.js'),f.home],{stdio:'ignore'});
    assert.equal((await finished(retry)).code,0);
    assert.deepEqual(await listRequests(f.home),[]);
    assert.equal(await exists(join(f.home,'sessions/project',f.ids.main)),false);
  } finally {await lock?.close();await f.cleanup();}
});

void test('a competing offline run neither deletes data nor overwrites the active owner status', async () => {
  const f=await fixture();let lock;
  try {
    await f.queue();
    const statusPath=join(stateDir(f.home),'status.json');
    await atomicJSON(statusPath,{state:'owner-active'});
    lock=await tryLock(join(stateDir(f.home),'lifecycle.lock'),true,true);
    await assert.rejects(runGuard(f.home),/Another cleanup/);
    assert.deepEqual(await readJSON(statusPath),{state:'owner-active'});
    assert.equal((await listRequests(f.home)).length,1);
    assert.equal(await exists(join(f.home,'sessions/project',f.ids.main)),true);
  } finally {await lock?.close();await f.cleanup();}
});

for (const desktop of [false, true]) void test(`an empty recovery queue refuses another ${desktop ? 'Desktop' : 'CLI'} host using the same home`, async () => {
  const f = await fixture();
  // The process has DSH-shaped argv and never accesses the fixture’s session files.
  const entry = desktop ? 'app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js' : '@deepseek-ai/dsh/lib/bin.js';
  let executable = process.execPath;
  if (desktop && process.platform === 'win32') {
    executable = join(f.base, 'DeepSeek Harness.exe');
    await fs.copyFile(process.execPath, executable);
  }
  const script = join(f.base, entry);
  await f.write(script, 'setInterval(() => {}, 1000)');
  const host = spawn(executable, ['--no-warnings', basename(script)], {
    argv0: desktop ? 'DeepSeek Harness' : executable, cwd: dirname(script), env: { ...process.env, DSH_HOME: f.home }, stdio: 'ignore',
  });
  const done = finished(host);
  try {
    await once(host, 'spawn');
    const temp = join(stateDir(f.home), `.session-deletion-write-${process.pid}-0-${'a'.repeat(24)}`);
    await f.write(temp, 'uncommitted');
    assert.deepEqual(await listRequests(f.home), []);
    assert.ok((await sameHomeHosts(f.home)).includes(pid(host)));
    await assert.rejects(runGuard(f.home), /Another DSH process/);
    assert.equal(await exists(join(f.home, 'sessions/project', f.ids.main)), true);
    assert.equal(await exists(temp), true, 'refused recovery must not sweep temporary files');
    assert.equal(await exists(join(stateDir(f.home), 'status.json')), false);
  } finally {
    host.kill('SIGTERM');
    await done;
    await f.cleanup();
  }
});

void test('empty recovery refreshes blocked diagnostics and safely reclaims only abandoned atomic writes', async () => {
  const f = await fixture();
  const writer = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
  const done = finished(writer);
  try {
    const started = await identity(writer);
    assert.ok(started);
    const status = join(stateDir(f.home), 'status.json');
    await atomicJSON(status, { state: 'blocked', error: 'old failure' });
    const alive = `.session-deletion-write-${pid(writer)}-${started}-${'b'.repeat(24)}`;
    const reused = `.session-deletion-write-${pid(writer)}-${BigInt(started) + 1n}-${'c'.repeat(24)}`;
    const directories = [stateDir(f.home), join(stateDir(f.home), 'pending'), join(f.home, 'storages')];
    for (const directory of directories) {
      for (const name of [alive, reused]) await f.write(join(directory, name), 'uncommitted');
    }
    const link = join(stateDir(f.home), `.session-deletion-write-${process.pid}-0-${'d'.repeat(24)}`);
    await fs.symlink(f.base, link, 'junction');
    await runGuard(f.home);
    const clean = await readJSON<GuardStatus>(status);
    assert.equal(clean.state, 'clean');
    assert.equal(clean.completed, 0);
    assert.ok(clean.checkedAt);
    assert.equal(clean.error, undefined);
    for (const directory of directories) {
      assert.equal(await exists(join(directory, alive)), true, 'a live atomic writer must survive');
      assert.equal(await exists(join(directory, reused)), false, 'PID reuse must not protect an abandoned write');
    }
    assert.equal((await fs.lstat(link)).isSymbolicLink(), true);
    assert.equal(await fs.readFile(f.projectFile, 'utf8'), 'user project must survive');
    writer.kill('SIGKILL'); await done;
    await runGuard(f.home);
    for (const directory of directories) assert.equal(await exists(join(directory, alive)), false);
    assert.equal((await readJSON<GuardStatus>(status)).state, 'clean');
  } finally { writer.kill(); await done; await f.cleanup(); }
});

void test('DSH processes using another home do not block cleanup', async () => {
  const f = await fixture();
  const script = join(f.base, '@deepseek-ai/dsh/lib/bin.js'), otherHome = join(f.base, 'another-home');
  await f.write(script, 'setInterval(() => {}, 1000)');
  await fs.mkdir(otherHome);
  const envFile = join(f.base, 'boot.env');
  await f.write(envFile, 'DSH_HOME=' + f.home + '\n');
  const host = spawn(process.execPath, ['--env-file-if-exists=' + envFile, script], { env: { ...process.env, DSH_HOME: otherHome }, stdio: 'ignore' });
  const done = finished(host);
  try {
    await once(host, 'spawn');
    assert.deepEqual(await sameHomeHosts(f.home), []);
    await f.queue();
    await runGuard(f.home);
    assert.equal((await listRequests(f.home)).length, 0);
  } finally { host.kill(); await done; await f.cleanup(); }
});


void test('a filesystem alias to the installed CLI entry still identifies a competing host', async () => {
  const f = await fixture();
  const scope = join(f.base, 'node_modules/@deepseek-ai');
  const entry = join(scope, 'dsh/lib/bin.js');
  await f.write(entry, 'console.log("READY");setInterval(() => {}, 1000)');
  const alias = join(f.base, 'scope-alias');
  await fs.symlink(scope, alias, 'junction');
  const child = spawn(process.execPath, [join(alias, 'dsh/lib/bin.js')], {
    cwd: f.base, env: { ...process.env, DSH_HOME: f.home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const done = finished(child);
  try {
    await once(child.stdout, 'data');
    assert.ok((await sameHomeHosts(f.home)).includes(pid(child)));
  } finally { child.kill(); await done; await f.cleanup(); }
});

for (const name of ['@deepseek-ai/dsh', 'other-cli']) void test(`source CLI detection reads the package identity: ${name}`, async () => {
  const f = await fixture(), entry = 'apps/cli/src/bin.ts';
  await f.write(join(f.base, entry), 'console.log("READY");setInterval(() => {}, 1000)');
  await f.write(join(f.base, 'apps/cli/package.json'), JSON.stringify({ name }));
  await f.write(join(f.base, 'preload.mjs'), '');
  const child = spawn(process.execPath, ['--import', './preload.mjs', entry, 'web'], {
    cwd: f.base, env: { ...process.env, DSH_HOME: f.home }, stdio: ['ignore', 'pipe', 'pipe'],
  });
  const done = finished(child);
  try {
    await once(child.stdout, 'data');
    assert.equal((await sameHomeHosts(f.home)).includes(pid(child)), name === '@deepseek-ai/dsh');
  } finally { child.kill(); await done; await f.cleanup(); }
});

void test('a Node tool receiving a DSH entry path as data is not a second host', async () => {
  const f = await fixture();
  const tool = join(f.base, 'tool.js');
  await f.write(tool, 'setInterval(() => {}, 1000)');
  const child = spawn(process.execPath, ['--no-warnings', tool, '@deepseek-ai/dsh/lib/bin.js'], {
    cwd: f.base, env: { ...process.env, DSH_HOME: f.home }, stdio: 'ignore',
  });
  const done = finished(child);
  try {
    await once(child, 'spawn');
    assert.deepEqual(await sameHomeHosts(f.home), []);
  } finally { child.kill(); await done; await f.cleanup(); }
});

void test('closing an old lock repeatedly cannot release its successor', async () => {
  const f = await fixture(); let successor, contender;
  try {
    const path = join(f.home, 'sessions/project', f.ids.main, 'session.lock');
    const previous = await tryLock(path);
    assert.ok(previous);
    await previous.close();
    successor = await tryLock(path);
    assert.ok(successor);
    await previous.close();
    await previous.close();
    contender = await tryLock(path);
    assert.equal(contender, undefined, 'an old close must not act on a reused native handle');
  } finally { await contender?.close(); await successor?.close(); await f.cleanup(); }
});

void test('mkdir rejects an unavailable Windows root without hanging', { skip: process.platform !== 'win32' }, async t => {
  let root;
  for (const drive of 'ZYXWVUTSRQPONMLKJIHGFED') {
    const path = drive + ':\\';
    if (!(await exists(path))) { root = path; break; }
  }
  if (!root) return t.skip('No unused drive letter');
  const program = 'import assert from "node:assert/strict"; import { mkdir } from '
    + JSON.stringify(new URL('../lib/platform/index.js', import.meta.url).href)
    + '; await assert.rejects(mkdir(process.argv[1]), { code: "ENOENT" });';
  const child = spawn(process.execPath, ['--input-type=module', '-e', program, root], { timeout: 3000, stdio: ['ignore', 'pipe', 'pipe'] });
  let error = ''; child.stderr.on('data', chunk => { error += chunk; });
  assert.equal((await finished(child)).code, 0, error || 'mkdir did not reject the missing root promptly');
});


for (const mode of ['relative', 'default', 'long-argv', 'blank', 'tilde', 'tilde-root', 'tilde-backslash', ...(process.platform === 'win32' ? ['namespaced', 'mixed-env', 'drive-relative', 'drive-relative-ns', 'drive-relative-lower'] : [])])
void test('host detection uses target process metadata: ' + mode, async () => {
  const f = await fixture(); let host: ChildProcess | undefined, done: ReturnType<typeof finished> | undefined;
  try {
    const env: NodeJS.ProcessEnv = { ...process.env, DSH_HOME: f.home };
    let expected = f.home;
    if (mode === 'relative') env.DSH_HOME = 'home';
    if (['default', 'blank', 'tilde', 'tilde-root', 'tilde-backslash'].includes(mode)) {
      delete env.DSH_HOME;
      env[homeVariable] = join(f.base, 'profile');
      expected = join(env[homeVariable]!, '.dsh');
      await fs.mkdir(expected, { recursive: true });
    }
    if (mode === 'blank') env.DSH_HOME = '   ';
    if (mode === 'tilde') env.DSH_HOME = '~/.dsh';
    if (mode === 'tilde-root') { env.DSH_HOME = '~'; expected = env[homeVariable]!; }
    if (mode === 'tilde-backslash') env.DSH_HOME = '~\\.dsh';
    if (mode === 'mixed-env') { delete env.DSH_HOME; env.dsh_home = f.home; }
    if (mode === 'namespaced') env.DSH_HOME = toNamespacedPath(f.home);
    if (mode.startsWith('drive-relative')) {
      const drive = f.base.slice(0, 2).toUpperCase();
      const saved = join(f.base, 'saved-drive-cwd');
      expected = join(saved, 'home'); await fs.mkdir(expected, { recursive: true });
      for (const name of Object.keys(env)) if (name.toUpperCase() === '=' + drive) delete env[name];
      env['=' + (mode === 'drive-relative-lower' ? drive.toLowerCase() : drive)] = saved;
      env.DSH_HOME = drive + 'home';
    }
    const flags = mode === 'long-argv' ? ['--no-warnings', '--trace-warnings', '--enable-source-maps'] : [];
    const script = join(f.base, '@deepseek-ai/dsh/lib/bin.js');
    await f.write(script, 'console.log("READY");setInterval(() => {}, 1000)');
    host = spawn(process.execPath, [...flags, script], {
      env, cwd: mode === 'drive-relative-ns' ? toNamespacedPath(f.base) : f.base, stdio: ['ignore', 'pipe', 'pipe'],
    });
    done = finished(host); await once(host.stdout!, 'data');
    assert.ok((await sameHomeHosts(expected)).includes(pid(host)));
  } finally { host?.kill(); await done; await f.cleanup(); }
});

void test('lifecycle ownership spans Windows path aliases', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture();
  let lock;
  try {
    await f.queue();
    lock = await tryLock(join(await fs.realpath(stateDir(f.home)), 'lifecycle.lock'), true, true);
    assert.ok(lock);
    await assert.rejects(runGuard(toNamespacedPath(f.home)), /Another cleanup/);
  } finally { await lock?.close(); await f.cleanup(); }
});
