import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join, toNamespacedPath } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { tryLock, runGuard, otherHosts, waitingHosts } from '../lib/guard.js';
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
async function ready(child: ChildProcess) {
  let text = '';
  assert(child.stdout);
  const stdout = child.stdout;
  return new Promise<void>((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Guard handshake timeout: '+text)), 10000);
    stdout.on('data', chunk => { text += chunk; if (text.includes('READY')) { clearTimeout(timer); accept(); } if (text.includes('ERROR')) { clearTimeout(timer); reject(new Error(text)); } });
    child.on('exit', code => { clearTimeout(timer); reject(new Error('Guard exited '+code+': '+text)); });
  });
}
void test('no deletion while host lives; automatic cleanup after process termination', async () => {
  const f = await fixture(); let host: ChildProcess | undefined; let guard: ChildProcess | undefined;
  try {
    host = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const hostDone = finished(host);
    guard = spawn(process.execPath, ['lib/guard.js', f.home, String(pid(host)), await identity(host)], { stdio: ['ignore','pipe','pipe'] });
    const guardDone = finished(guard);
    await ready(guard);
    await f.queue();
    await delay(500);
    assert.equal(await exists(join(f.home,'sessions/project',f.ids.main)),true);
    host.kill('SIGTERM'); await hostDone;
    assert.equal((await guardDone).code,0);
    assert.equal(await exists(join(f.home,'sessions/project',f.ids.main)),false);
    assert.equal((await listRequests(f.home)).length,0);
    assert.equal(await exists(join(f.home,'attachments/v1/objects',f.exclusive.slice(0,2),f.exclusive)),true,'automatic recovery never performs attachment GC');
  } finally { host?.kill(); guard?.kill(); await f.cleanup(); }
});

void test('SIGKILL host still triggers deletion, PID identity is checked', async () => {
  const f = await fixture(); let host: ChildProcess | undefined; let guard: ChildProcess | undefined;
  try {
    host=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    const hostDone=finished(host);
    guard=spawn(process.execPath,['lib/guard.js',f.home,String(pid(host)),await identity(host)],{stdio:['ignore','pipe','pipe']});
    const done=finished(guard);await ready(guard);
    await f.queue();
    host.kill('SIGKILL');await hostDone;
    assert.equal((await done).code,0);
    assert.equal((await listRequests(f.home)).length,0);
  } finally {host?.kill();guard?.kill();await f.cleanup();}
});

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
    const retry=spawn(process.execPath,['lib/guard.js',f.home],{stdio:'ignore'});
    assert.equal((await finished(retry)).code,0);
  } finally {await lock?.close();await f.cleanup();}
});

void test('second guarded host waits until predecessor exits and cleanup completes', async () => {
  const f=await fixture();let first: ChildProcess | undefined, second: ChildProcess | undefined, a: ChildProcess | undefined, b: ChildProcess | undefined;
  try {
    first=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    const firstDone=finished(first);
    a=spawn(process.execPath,['lib/guard.js',f.home,String(pid(first)),await identity(first)],{stdio:['ignore','pipe','pipe']});
    const aDone=finished(a);await ready(a);
    await f.queue();
    second=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    const secondDone=finished(second);
    b=spawn(process.execPath,['lib/guard.js',f.home,String(pid(second)),await identity(second)],{stdio:['ignore','pipe','pipe']});
    const bDone=finished(b);const bReady=ready(b);
    await delay(200);assert.equal(await exists(join(f.home,'sessions/project',f.ids.main)),true);
    first.kill('SIGTERM');await firstDone;await aDone;await bReady;
    assert.equal(await exists(join(f.home,'sessions/project',f.ids.main)),false);
    second.kill('SIGTERM');await secondDone;assert.equal((await bDone).code,0);
  } finally {first?.kill();second?.kill();a?.kill();b?.kill();await f.cleanup();}
});

void test('terminating both the supervisor and host preserves the request for the next startup', async () => {
  const f=await fixture();let host: ChildProcess | undefined, guard: ChildProcess | undefined;
  try {
    host=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    const hostDone=finished(host);
    guard=spawn(process.execPath,['lib/guard.js',f.home,String(pid(host)),await identity(host)],{stdio:['ignore','pipe','pipe']});
    const guardDone=finished(guard);await ready(guard);
    await f.queue();
    guard.kill('SIGKILL');await guardDone;
    host.kill('SIGKILL');await hostDone;
    assert.equal(await exists(join(f.home,'sessions/project',f.ids.main)),true);
    assert.equal((await listRequests(f.home)).length,1);
    const recovered=spawn(process.execPath,['lib/guard.js',f.home],{stdio:'ignore'});
    assert.equal((await finished(recovered)).code,0);
    assert.equal((await listRequests(f.home)).length,0);
    assert.equal(await exists(join(f.home,'sessions/project',f.ids.main)),false);
  } finally {host?.kill();guard?.kill();await f.cleanup();}
});

void test('startup lock timeout neither deletes data nor overwrites the active owner status', async () => {
  const f=await fixture();let lock;
  try {
    await f.queue();
    const statusPath=join(stateDir(f.home),'status.json');
    await atomicJSON(statusPath,{state:'owner-active'});
    lock=await tryLock(join(stateDir(f.home),'lifecycle.lock'),true,true);
    await assert.rejects(runGuard({home:f.home,startupTimeoutMs:30},()=>{}),/Another DSH host/);
    assert.deepEqual(await readJSON(statusPath),{state:'owner-active'});
    assert.equal((await listRequests(f.home)).length,1);
    assert.equal(await exists(join(f.home,'sessions/project',f.ids.main)),true);
  } finally {await lock?.close();await f.cleanup();}
});

for (const desktop of [false, true]) void test(`an empty recovery queue refuses another ${desktop ? 'Desktop' : 'CLI'} host using the same home`, async () => {
  const f = await fixture();
  // A disposable Node process with DSH-shaped argv models a host whose guard
  // has exited. It never imports DSH or accesses the fixture's session files.
  const entry = desktop ? 'app.asar/dsh/node_modules/@deepseek-ai/dsh-desktop-host/lib/index.js' : '@deepseek-ai/dsh/lib/bin.js';
  let executable = process.execPath;
  if (desktop && process.platform === 'win32') {
    executable = join(f.base, 'DeepSeek Harness.exe');
    await fs.copyFile(process.execPath, executable);
  }
  const host = spawn(executable, ['-e', 'setInterval(()=>{},1000)', entry], {
    argv0: desktop ? 'DeepSeek Harness' : executable, cwd: f.base, env: { ...process.env, DSH_HOME: f.home }, stdio: 'ignore',
  });
  const done = finished(host);
  try {
    await once(host, 'spawn');
    const temp = join(stateDir(f.home), `.session-deletion-write-${process.pid}-0-${'a'.repeat(24)}`);
    await f.write(temp, 'uncommitted');
    assert.deepEqual(await listRequests(f.home), []);
    assert.ok((await otherHosts(f.home, new Set([process.pid]))).includes(pid(host)));
    const announced: string[] = [];
    await assert.rejects(runGuard({ home: f.home }, line => announced.push(line)), /Another DSH process/);
    assert.ok(!announced.includes('READY') && !announced.includes('Cleanup verified'));
    assert.equal(await exists(join(f.home, 'sessions/project', f.ids.main)), true);
    assert.equal(await exists(temp), true, 'refused startup must not sweep temporary files');
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
    const directories = [stateDir(f.home), join(stateDir(f.home), 'pending'), join(stateDir(f.home), 'hosts'), join(f.home, 'storages')];
    for (const directory of directories) {
      for (const name of [alive, reused]) await f.write(join(directory, name), 'uncommitted');
    }
    const link = join(stateDir(f.home), `.session-deletion-write-${process.pid}-0-${'d'.repeat(24)}`);
    await fs.symlink(f.base, link, 'junction');
    await runGuard({ home: f.home }, () => {});
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
    await runGuard({ home: f.home }, () => {});
    for (const directory of directories) assert.equal(await exists(join(directory, alive)), false);
    assert.equal((await readJSON<GuardStatus>(status)).state, 'clean');
  } finally { writer.kill(); await done; await f.cleanup(); }
});

void test('DSH processes using another home do not block cleanup', async () => {
  const f = await fixture();
  const host = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '/tmp/@deepseek-ai/dsh/lib/bin.js'], {
    env: { ...process.env, DSH_HOME: join(f.base, 'another-home') }, stdio: 'ignore',
  });
  const done = finished(host);
  try {
    await once(host, 'spawn');
    assert.deepEqual(await otherHosts(f.home, new Set([process.pid])), []);
    await f.queue();
    await runGuard({ home: f.home }, () => {});
    assert.equal((await listRequests(f.home)).length, 0);
  } finally { host.kill(); await done; await f.cleanup(); }
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
    host = spawn(process.execPath, [...flags, '-e', 'console.log("READY");setInterval(()=>{},1000)', join(f.base, '@deepseek-ai/dsh/lib/bin.js')], {
      env, cwd: mode === 'drive-relative-ns' ? toNamespacedPath(f.base) : f.base, stdio: ['ignore', 'pipe', 'pipe'],
    });
    done = finished(host); await ready(host);
    assert.ok((await otherHosts(expected, new Set([process.pid]))).includes(pid(host)));
  } finally { host?.kill(); await done; await f.cleanup(); }
});

void test('lifecycle ownership spans Windows path aliases', { skip: process.platform !== 'win32' }, async () => {
  const f = await fixture(); let host: ChildProcess | undefined, guard: ChildProcess | undefined, hostDone: ReturnType<typeof finished> | undefined, guardDone: ReturnType<typeof finished> | undefined;
  try {
    host = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    hostDone = finished(host);
    guard = spawn(process.execPath, ['lib/guard.js', f.home, String(pid(host)), await identity(host)], { stdio: ['ignore', 'pipe', 'pipe'] });
    guardDone = finished(guard); await ready(guard);
    await assert.rejects(runGuard({ home: toNamespacedPath(f.home), startupTimeoutMs: 30 }, () => {}), /Another DSH host/);
    host.kill(); await hostDone; host = undefined;
    assert.equal((await guardDone).code, 0); guard = undefined;
  } finally { host?.kill(); guard?.kill(); await hostDone; await guardDone; await f.cleanup(); }
});


void test('marker removal failure still releases lifecycle ownership', async () => {
  const f = await fixture(); const rm = fs.rm; let held;
  try {
    const started = await birth(process.pid); assert(started);
    const marker = join(stateDir(f.home), 'hosts', process.pid + '-' + started + '.json');
    fs.rm = async (path, ...args) => {
      if (path === marker) throw Object.assign(new Error('Injected marker removal failure'), { code: 'EIO' });
      return rm(path, ...args);
    };
    syncBuiltinESMExports();
    await assert.rejects(runGuard({ home: f.home, hostPid: process.pid, hostBirth: started }, line => {
      if (line === 'CLEANING') throw new Error('Injected startup interruption');
    }), /Injected marker removal failure/);
    fs.rm = rm; syncBuiltinESMExports();
    held = await tryLock(join(await fs.realpath(stateDir(f.home)), 'lifecycle.lock'), true, true);
    assert.ok(held, 'failed marker cleanup must not leak the kernel lifecycle lock');
  } finally { fs.rm = rm; syncBuiltinESMExports(); await held?.close(); await f.cleanup(); }
});


void test('a stale marker disappearing after its read is already cleaned up', async () => {
  const f = await fixture(); const readFile = fs.readFile;
  try {
    const stale = String(BigInt((await birth(process.pid))!) + 1n);
    const marker = join(stateDir(f.home), 'hosts', process.pid + '-' + stale + '.json');
    await atomicJSON(marker, { pid: process.pid, birth: stale, phase: 'waiting' });
    let removed = false;
    fs.readFile = (async (...[path, ...args]: Parameters<typeof readFile>) => {
      const contents = await readFile(path, ...args);
      if (path === marker) { await fs.rm(marker, { force: true }); removed = true; }
      return contents;
    }) as typeof readFile;
    syncBuiltinESMExports();
    assert.equal((await waitingHosts(stateDir(f.home))).size, 0);
    assert.equal(removed, true, 'model the other guard removing its own marker after this read');
    assert.equal(await exists(marker), false);
  } finally { fs.readFile = readFile; syncBuiltinESMExports(); await f.cleanup(); }
});
