import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { birth, tryLock, runGuard, otherHosts } from '../lib/guard.js';
import { exists, listRequests, stateDir, atomicJSON, readJSON } from '../lib/core.js';
import { fixture } from './fixtures.js';

function finished(child) { return new Promise(resolve => child.once('exit', (code, signal) => resolve({ code, signal }))); }
async function ready(child) {
  let text = '';
  return new Promise((accept, reject) => {
    const timer = setTimeout(() => reject(new Error('Guard handshake timeout: '+text)), 10000);
    child.stdout.on('data', chunk => { text += chunk; if (text.includes('READY')) { clearTimeout(timer); accept(); } if (text.includes('ERROR')) { clearTimeout(timer); reject(new Error(text)); } });
    child.on('exit', code => { clearTimeout(timer); reject(new Error('Guard exited '+code+': '+text)); });
  });
}
test('no deletion while host lives; automatic cleanup after process termination', async () => {
  const f = await fixture(); let host; let guard;
  try {
    host = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)'], { stdio: 'ignore' });
    const hostDone = finished(host);
    guard = spawn(process.execPath, ['lib/guard.js', f.home, String(host.pid), await birth(host.pid)], { stdio: ['ignore','pipe','pipe'] });
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

test('SIGKILL host still triggers deletion, PID identity is checked', async () => {
  const f = await fixture(); let host; let guard;
  try {
    host=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    const hostDone=finished(host);
    guard=spawn(process.execPath,['lib/guard.js',f.home,String(host.pid),await birth(host.pid)],{stdio:['ignore','pipe','pipe']});
    const done=finished(guard);await ready(guard);
    await f.queue();
    host.kill('SIGKILL');await hostDone;
    assert.equal((await done).code,0);
    assert.equal((await listRequests(f.home)).length,0);
  } finally {host?.kill();guard?.kill();await f.cleanup();}
});

test('kernel writer lock defers all cleanup and preserves pending request', async () => {
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

test('second guarded host waits until predecessor exits and cleanup completes', async () => {
  const f=await fixture();let first,second,a,b;
  try {
    first=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    const firstDone=finished(first);
    a=spawn(process.execPath,['lib/guard.js',f.home,String(first.pid),await birth(first.pid)],{stdio:['ignore','pipe','pipe']});
    const aDone=finished(a);await ready(a);
    await f.queue();
    second=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    const secondDone=finished(second);
    b=spawn(process.execPath,['lib/guard.js',f.home,String(second.pid),await birth(second.pid)],{stdio:['ignore','pipe','pipe']});
    const bDone=finished(b);const bReady=ready(b);
    await delay(200);assert.equal(await exists(join(f.home,'sessions/project',f.ids.main)),true);
    first.kill('SIGTERM');await firstDone;await aDone;await bReady;
    assert.equal(await exists(join(f.home,'sessions/project',f.ids.main)),false);
    second.kill('SIGTERM');await secondDone;assert.equal((await bDone).code,0);
  } finally {first?.kill();second?.kill();a?.kill();b?.kill();await f.cleanup();}
});

test('terminating both the supervisor and host preserves the request for the next startup', async () => {
  const f=await fixture();let host,guard;
  try {
    host=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore'});
    const hostDone=finished(host);
    guard=spawn(process.execPath,['lib/guard.js',f.home,String(host.pid),await birth(host.pid)],{stdio:['ignore','pipe','pipe']});
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

test('startup lock timeout neither deletes data nor overwrites the active owner status', async () => {
  const f=await fixture();let lock;
  try {
    await f.queue();
    const statusPath=join(stateDir(f.home),'status.json');
    await atomicJSON(statusPath,{state:'owner-active'});
    lock=await tryLock(join(stateDir(f.home),'lifecycle.lock'),true);
    await assert.rejects(runGuard({home:f.home,startupTimeoutMs:30},()=>{}),/Another DSH host/);
    assert.deepEqual(await readJSON(statusPath),{state:'owner-active'});
    assert.equal((await listRequests(f.home)).length,1);
    assert.equal(await exists(join(f.home,'sessions/project',f.ids.main)),true);
  } finally {await lock?.close();await f.cleanup();}
});

test('an empty recovery queue still refuses another DSH host using the same home', async () => {
  const f = await fixture();
  // A disposable Node process with DSH-shaped argv models a host whose guard
  // has exited. It never imports DSH or accesses the fixture's session files.
  const host = spawn(process.execPath, ['-e', 'setInterval(()=>{},1000)', '/tmp/@deepseek-ai/dsh/lib/bin.js'], {
    env: { ...process.env, DSH_HOME: f.home }, stdio: 'ignore',
  });
  const done = finished(host);
  try {
    await once(host, 'spawn');
    assert.deepEqual(await listRequests(f.home), []);
    assert.ok((await otherHosts(f.home, new Set([process.pid]))).includes(host.pid));
    const announced = [];
    await assert.rejects(runGuard({ home: f.home }, line => announced.push(line)), /Another DSH process/);
    assert.ok(!announced.includes('READY') && !announced.includes('Cleanup verified'));
    assert.equal(await exists(join(f.home, 'sessions/project', f.ids.main)), true);
  } finally {
    host.kill('SIGTERM');
    await done;
    await f.cleanup();
  }
});
