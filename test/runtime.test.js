import {test}from'node:test';
import assert from'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import{setTimeout as delay}from'node:timers/promises';
import{PublicationBarrier,DeletionRuntime}from'../lib/runtime.js';
import { fixture } from './fixtures.js';
import { listRequests, stateDir } from '../lib/core.js';

test('publication barrier drains existing work, permits reentrant calls and queues new work',async()=>{
 const gate=new PublicationBarrier();const order=[];
 let release;const hold=new Promise(r=>release=r);
 const first=gate.read(async()=>{order.push('first');await hold;await gate.read(()=>order.push('nested'));order.push('drained')});
 const exclusive=gate.exclusive(async()=>{order.push('delete');await delay(10);order.push('deleted')});
 const next=gate.read(()=>order.push('next'));
 release();await Promise.all([first,exclusive,next]);
 assert.deepEqual(order,['first','nested','drained','delete','deleted','next']);
});

test('publication timeout releases queued work and never starts cleanup',async()=>{
 const gate=new PublicationBarrier();let release;let deleted=false;
 const reader=gate.read(()=>new Promise(r=>release=r));
 const exclusive=gate.exclusive(async()=>{deleted=true},20);
 const queued=gate.read(()=>42);
 await assert.rejects(exclusive,/未结束/);assert.equal(deleted,false);assert.equal(await queued,42);
 release();await reader;
});

test('detached tasks cannot reuse a returned caller lease during deletion', async () => {
 const gate = new PublicationBarrier();
 let wake, finish, child;
 const ready = new Promise(resolve => { wake = resolve; });
 await gate.read(() => { child = (async () => { await ready; return gate.read(() => 'published'); })(); });
 const exclusive = gate.exclusive(() => new Promise(resolve => { finish = resolve; }));
 wake();
 assert.equal(await Promise.race([child, delay(20).then(() => 'blocked')]), 'blocked');
 finish(); await exclusive;
 assert.equal(await child, 'published');
});

test('unawaited nested publication still drains before deletion starts', async () => {
 const gate = new PublicationBarrier();
 let finish, nested, deleted = false;
 await gate.read(() => { nested = gate.read(() => new Promise(resolve => { finish = resolve; })); });
 const exclusive = gate.exclusive(async () => { deleted = true; });
 await delay(20); assert.equal(deleted, false);
 finish(); await nested; await exclusive;
 assert.equal(deleted, true);
});

test('synchronous publications reject during deletion but an existing lease can finish', async () => {
 const gate = new PublicationBarrier();
 let finish;
 const reader = gate.read(async () => { await new Promise(resolve => { finish = resolve; }); gate.assertSynchronousPublication(); });
 const exclusive = gate.exclusive(async () => { assert.throws(() => gate.assertSynchronousPublication(), /正在清理/); });
 assert.throws(() => gate.assertSynchronousPublication(), /正在清理/);
 finish(); await reader; await exclusive;
 gate.assertSynchronousPublication();
});

test('a child created after HTTP validation requires renewed confirmation before archival', async () => {
 const f = await fixture();
 try {
  let archived = false;
  const runtime = new DeletionRuntime({
   sessionDeletionGate: { home: f.home, healthy: () => true },
   workspaceRegistry: { archiveSession: async () => { archived = true; } },
  }, value => value, class {});
  runtime.headers = async () => new Map(Object.entries(f.headers));
  await assert.rejects(runtime.remove(f.ids.main, 1234, [f.ids.main]), /子代理集合已变化/);
  assert.equal(archived, false);
  assert.deepEqual(await listRequests(f.home), []);
 } finally { await f.cleanup(); }
});

test('submissions queued behind GC do not make its global idle check fail', async () => {
 const runtime = new DeletionRuntime({
  sessions: { list: () => [{ id: 'other' }] },
  agents: { get: () => ({ status: 'idle', inbox: { nextTurn: [], nextStep: [] }, whenIdle: async () => {} }) },
  waterfall: async () => [],
 }, value => value, class {});
 runtime.controller = {}; runtime.schedule = {};
 let release, published = false;
 const exclusive = runtime.barrier.exclusive(() => new Promise(resolve => { release = resolve; }));
 const queued = runtime.operation(['other'], () => { published = true; });
 assert.equal((await runtime.quiescence([], true)).busy, false);
 assert.equal(published, false);
 release(); await exclusive; await queued;
 assert.equal(published, true);
});

for (const failure of ['receipt-read', 'receipt-rename']) test(`deletion publishes tombstones despite ${failure} failure`, async () => {
 const f = await fixture();
 const readFile = fs.readFile, rename = fs.rename;
 try {
  await fs.mkdir(join(stateDir(f.home), 'hosts'), { recursive: true });
  // This case exercises real log removal and receipt I/O, without unrelated workspace services.
  await fs.rm(join(f.home, 'storages/workspace.json'));
  await fs.rm(join(f.home, 'storages/schedule.json'));
  const runtime = new DeletionRuntime({
   sessionDeletionGate: { home: f.home, healthy: () => true },
   workspaceRegistry: { archiveSession: async () => {}, archivedSessionIds: [f.ids.main] },
   agents: { get: () => undefined }, sessions: { get: () => undefined },
   sessionProjectionCache: { table: { delete: async () => {} } },
   sessionPersistence: {}, sessionQuery: {}, emit() {},
  }, value => value, class {});
  const headers = new Map(Object.entries(f.headers));
  runtime.headers = async () => headers;
  runtime.quiescence = async () => ({ busy: false, reasons: [] });
  const path = join(stateDir(f.home), 'receipt.json');
  let receiptReads = 0;
  fs.readFile = async function (file, ...args) {
   if (file === path) {
    receiptReads++;
    if (failure === 'receipt-read') throw Object.assign(new Error('Injected receipt read failure'), { code: 'EIO' });
   }
   return readFile.call(this, file, ...args);
  };
  fs.rename = async function (from, to) {
   await rename.call(this, from, to);
   if (to === path && failure === 'receipt-rename') throw Object.assign(new Error('Injected post-rename failure'), { code: 'EIO' });
  };
  syncBuiltinESMExports();
  const ids = runtime.family(headers, f.ids.main);
  const removal = runtime.remove(f.ids.main, f.headers[f.ids.main].createdAt, ids);
  if (failure === 'receipt-read') assert.deepEqual(await removal, { deleted: 3 });
  else await assert.rejects(removal, /Injected post-rename failure/);
  const persisted = JSON.parse(await readFile.call(fs, path, 'utf8'));
  assert.equal(persisted.deletedIdHashes.length, 3);
  assert.deepEqual(runtime.receipt, { revision: persisted.revision, deletedIdHashes: persisted.deletedIdHashes });
  assert.ok(ids.every(id => runtime.isLocked(id)));
  assert.equal(receiptReads, failure === 'receipt-read' ? 0 : 1);
  assert.equal((await listRequests(f.home)).length, failure === 'receipt-read' ? 0 : 1);
 } finally {
  fs.readFile = readFile; fs.rename = rename; syncBuiltinESMExports();
  await f.cleanup();
 }
});
