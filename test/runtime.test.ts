import {test}from'node:test';
import assert from'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { join } from 'node:path';
import{setTimeout as delay}from'node:timers/promises';
import{PublicationBarrier}from'../lib/runtime.js';
import { makeRuntime } from './runtime-fixture.ts';
import type { RuntimeContext } from '../lib/runtime.js';
import { fixture } from './fixtures.ts';
import { listRequests, stateDir, SUPPORTED_DSH } from '../lib/core.js';

void test('uploads wait for GC and prompt bindings remain synchronous', async () => {
 const f = await fixture(); let dispose: (() => void) | undefined, finish!: () => void, maintenance: Promise<void> | undefined;
 try {
  let uploadsCalled = 0, retired = 0;
  const binding = { [Symbol.dispose]() {} };
  const uploads = { stagedFiles: new WeakMap<object, Map<string, { attachment: unknown }>>(),
   upload: async (_owner?: { sessionId: string }) => { uploadsCalled++; }, uploadStream: async (_owner?: { sessionId: string }) => { uploadsCalled++; }, uploadImageStream: async (_owner?: { sessionId: string }) => { uploadsCalled++; },
   bindPrompt: (_agent: { id: string }, _files: unknown[], _request: string) => binding, retirePrompt: (_agent: { id: string }, _request: string) => { retired++; },
  };
  const attachments: Record<string, unknown> & Pick<RuntimeContext['attachments'], 'root' | 'cacheRoot'> = { root: join(f.home, 'attachments/v1'), cacheRoot: join(f.home, 'cache/attachments') };
  for (const name of ['saveImage', 'saveImages', 'saveFile', 'saveFileStream', 'readImageRequest']) attachments[name] = async () => {};
  const runtime = makeRuntime({
   sessionDeletionGate: { home: f.home, version: SUPPORTED_DSH, healthy: () => true }, attachments, fileUploads: uploads,
   workspaceRegistry: { pinSession() {}, async archiveSession() {}, async unarchiveSession() {} },
   agents: { requireFactory: () => ({ target: {} }), setFactory() {} }, sessionProjectionCache: { table: new Map<string, unknown>(), put() {} },
   on() { return () => {}; }, inject() {}, effect(callback) { dispose = callback(); },
  });
  await runtime.initialize();
  assert.equal(uploads.bindPrompt({ id: f.ids.main }, [], 'request'), binding);
  maintenance = runtime.barrier.exclusive(() => new Promise<void>(resolve => { finish = resolve; }));
  const upload = uploads.uploadStream({ sessionId: f.ids.main });
  await delay(20); assert.equal(uploadsCalled, 0);
  assert.throws(() => uploads.bindPrompt({ id: f.ids.main }, [], 'request'), /正在清理/);
  finish(); await maintenance; await upload; assert.equal(uploadsCalled, 1);
  runtime.locked.add(f.ids.main);
  await assert.rejects(uploads.uploadImageStream({ sessionId: f.ids.main }), /此会话/);
  assert.throws(() => uploads.bindPrompt({ id: f.ids.main }, [], 'request'), /此会话/);
  uploads.retirePrompt({ id: f.ids.main }, 'request');
  assert.equal(retired, 1, 'retirement only removes references and must remain available during disposal');
 } finally { finish?.(); await maintenance; dispose?.(); await f.cleanup(); }
});

void test('GC snapshots retain staged upload references', async () => {
 const session = { id: 'session', header: { type: 'session' as const, id: 'session', version: 4, createdAt: 1 } };
 const attachment = { attachmentId: 'sha256:' + 'a'.repeat(64) };
 const stagedFiles = new WeakMap([[session, new Map([['receipt', { attachment }]])]]);
 let disposed = false;
 const runtime = makeRuntime({
  sessions: { list: () => [session] }, fileUploads: { stagedFiles },
  sessionQuery: { observeSession: async () => ({ header: session.header, events: [], [Symbol.dispose]() { disposed = true; } }) },
 });
 const snapshot = (await runtime.snapshots()).get(session.id);
 assert(snapshot);
 assert.deepEqual(snapshot.events, [attachment]);
 assert.equal(disposed, true);
});

for (const change of ['staged', 'session/event', 'transient-session', 'maintenance', 'read-failure']) void test(`size preview rejects ${change} changes and releases its subscriptions`, async () => {
 const f = await fixture(); const readdir = fs.readdir;
 try {
  const hash = 'c'.repeat(64), attachment = { attachmentId: 'sha256:' + hash };
  await f.write(join(f.home, 'attachments/v1/objects', 'cc', hash), Buffer.alloc(2048));
  const session = { id: 'unsaved', header: { id: 'unsaved', version: 4, createdAt: 1 } };
  const stagedFiles = new WeakMap<object, Map<string, { attachment: unknown }>>(), events: unknown[] = [], listeners = new Map<string, Set<(...args: never[]) => unknown>>();
  const emit = (name: string) => { for (const listener of listeners.get(name) || []) listener(); };
  const runtime = makeRuntime({
   sessionDeletionGate: { home: f.home }, sessions: { list: () => [session] }, fileUploads: { stagedFiles },
   sessionQuery: { observeSession: async () => ({ header: session.header, events, [Symbol.dispose]() {} }) },
   on(name, listener) { const group = listeners.get(name) || new Set<(...args: never[]) => unknown>(); listeners.set(name, group); group.add(listener); return () => group.delete(listener); },
  });
  let injected = false;
  fs.readdir = (async (...args: Parameters<typeof readdir>) => {
   const path = args[0];
   if (path === join(f.home, 'attachments/v1/objects') && !injected) {
    injected = true;
    if (change === 'staged') stagedFiles.set(session, new Map([['receipt', { attachment }]]));
    if (change === 'session/event') { events.push(attachment); emit('session/event'); }
    if (change === 'transient-session') {
     emit('session/created'); await f.session('transient', {}, [attachment]); emit('session/event'); emit('session/disposed');
    }
    if (change === 'maintenance') runtime.maintenance = 'gc';
    if (change === 'read-failure') throw new Error('Injected preview read failure');
   }
   return readdir(...args);
  }) as typeof readdir;
  syncBuiltinESMExports();
  await assert.rejects(runtime.garbageSize(), change === 'read-failure' ? /Injected preview read failure/ : /已变化/);
  assert.equal([...listeners.values()].reduce((count, group) => count + group.size, 0), 0, 'both success and failure must release the temporary observers');
  runtime.maintenance = undefined;
  assert.equal(await runtime.garbageSize(), ['maintenance', 'read-failure'].includes(change) ? 2061 : 13);
  assert.equal([...listeners.values()].reduce((count, group) => count + group.size, 0), 0);
 } finally { fs.readdir = readdir; syncBuiltinESMExports(); await f.cleanup(); }
});

void test('publication barrier drains existing work, permits reentrant calls and queues new work',async()=>{
 const gate=new PublicationBarrier();const order: string[]=[];
 let release!: () => void;const hold=new Promise<void>(r=>release=r);
 const first=gate.read(async()=>{order.push('first');await hold;await gate.read(()=>order.push('nested'));order.push('drained')});
 const exclusive=gate.exclusive(async()=>{order.push('delete');await delay(10);order.push('deleted')});
 const next=gate.read(()=>order.push('next'));
 release();await Promise.all([first,exclusive,next]);
 assert.deepEqual(order,['first','nested','drained','delete','deleted','next']);
});

void test('publication timeout releases queued work and never starts cleanup',async()=>{
 const gate=new PublicationBarrier();let release!: () => void;let deleted=false;
 const reader=gate.read(()=>new Promise<void>(r=>release=r));
 const exclusive=gate.exclusive(async()=>{deleted=true},20);
 const queued=gate.read(()=>42);
 await assert.rejects(exclusive,/未结束/);assert.equal(deleted,false);assert.equal(await queued,42);
 release();await reader;
});

void test('detached tasks cannot reuse a returned caller lease during deletion', async () => {
 const gate = new PublicationBarrier();
 let wake!: () => void, finish!: () => void, child!: Promise<string>;
 const ready = new Promise<void>(resolve => { wake = resolve; });
 await gate.read(() => { child = (async () => { await ready; return gate.read(() => 'published'); })(); });
 const exclusive = gate.exclusive(() => new Promise<void>(resolve => { finish = resolve; }));
 wake();
 assert.equal(await Promise.race([child, delay(20).then(() => 'blocked')]), 'blocked');
 finish(); await exclusive;
 assert.equal(await child, 'published');
});

void test('unawaited nested publication still drains before deletion starts', async () => {
 const gate = new PublicationBarrier();
 let finish!: () => void, nested!: Promise<void>, deleted = false;
 await gate.read(() => { nested = gate.read(() => new Promise<void>(resolve => { finish = resolve; })); });
 const exclusive = gate.exclusive(async () => { deleted = true; });
 await delay(20); assert.equal(deleted, false);
 finish(); await nested; await exclusive;
 assert.equal(deleted, true);
});

void test('synchronous publications reject during deletion but an existing lease can finish', async () => {
 const gate = new PublicationBarrier();
 let finish!: () => void;
 const reader = gate.read(async () => { await new Promise<void>(resolve => { finish = resolve; }); gate.assertSynchronousPublication(); });
 const exclusive = gate.exclusive(async () => { assert.throws(() => gate.assertSynchronousPublication(), /正在清理/); });
 assert.throws(() => gate.assertSynchronousPublication(), /正在清理/);
 finish(); await reader; await exclusive;
 gate.assertSynchronousPublication();
});

void test('a child created after HTTP validation requires renewed confirmation before stopping', async () => {
 const f = await fixture();
 try {
  let archived = false;
  const runtime = makeRuntime({
   sessionDeletionGate: { home: f.home, healthy: () => true },
   workspaceRegistry: { archiveSession: async () => { archived = true; } },
  });
  runtime.headers = async () => new Map(Object.entries(f.headers));
  await assert.rejects(runtime.remove(f.ids.main, 1234, [f.ids.main]), /子代理集合已变化/);
  assert.equal(archived, false);
  assert.deepEqual(await listRequests(f.home), []);
 } finally { await f.cleanup(); }
});

void test('submissions queued behind GC do not make its global idle check fail', async () => {
 const session = { id: 'other', header: { id: 'other', version: 4, createdAt: 1 } };
 const runtime = makeRuntime({
  sessions: { list: () => [session] },
  agents: { get: () => ({ id: session.id, session, status: 'idle', inbox: { nextTurn: [], nextStep: [] }, whenIdle: async () => {}, cancel() {} }) },
  waterfall: async () => [],
 });
 runtime.controller = {}; runtime.schedule = { catalog: async () => [], create: async () => {}, edit: async () => {} };
 let release!: () => void, published = false;
 const exclusive = runtime.barrier.exclusive(() => new Promise<void>(resolve => { release = resolve; }));
 const queued = runtime.operation(['other'], () => { published = true; });
 assert.equal((await runtime.quiescence([], true)).busy, false);
 assert.equal(published, false);
 release(); await exclusive; await queued;
 assert.equal(published, true);
});

for (const failure of ['receipt-read', 'receipt-cleanup']) void test(`deletion publishes tombstones despite ${failure} failure`, async () => {
 const f = await fixture();
 const readFile = fs.readFile, rm = fs.rm;
 try {
  await fs.mkdir(join(stateDir(f.home), 'hosts'), { recursive: true });
  // This case exercises real log removal and receipt I/O, without unrelated workspace services.
  await fs.rm(join(f.home, 'storages/workspace.json'));
  await fs.rm(join(f.home, 'storages/schedule.json'));
  const runtime = makeRuntime({
   sessionDeletionGate: { home: f.home, healthy: () => true },
   workspaceRegistry: { archiveSession: async () => {}, archivedSessionIds: [f.ids.main] },
   agents: { get: () => undefined }, sessions: { get: () => undefined },
   sessionProjectionCache: { table: { delete: async () => {} } },
   sessionPersistence: {}, sessionQuery: {}, emit() {},
  });
  const headers = new Map(Object.entries(f.headers));
  runtime.headers = async () => headers;
  runtime.quiescence = async () => ({ busy: false, reasons: [] });
  const path = join(stateDir(f.home), 'receipt.json');
  let receiptReads = 0;
  fs.readFile = (async (...args: Parameters<typeof readFile>) => {
   const file = args[0];
   if (file === path) {
    receiptReads++;
    if (failure === 'receipt-read') throw Object.assign(new Error('Injected receipt read failure'), { code: 'EIO' });
   }
   return readFile(...args);
  }) as typeof readFile;
  fs.rm = async function (file, ...args) {
   await rm.call(this, file, ...args);
   if (failure === 'receipt-cleanup' && String(file).includes('.session-deletion-write-') && await readFile(path, 'utf8').catch(() => ''))
    throw Object.assign(new Error('Injected post-rename failure'), { code: 'EIO' });
  };
  syncBuiltinESMExports();
  const ids = runtime.family(headers, f.ids.main);
  const removal = runtime.remove(f.ids.main, f.headers[f.ids.main].createdAt, ids);
  if (failure === 'receipt-read') assert.deepEqual(await removal, { deleted: 3 });
  else await assert.rejects(removal, /Injected post-rename failure/);
  const persisted = JSON.parse(await readFile(path, 'utf8'));
  assert.equal(persisted.deletedIdHashes.length, 3);
  assert.deepEqual(runtime.receipt, { revision: persisted.revision, deletedIdHashes: persisted.deletedIdHashes });
  assert.ok(ids.every(id => runtime.isLocked(id)));
  assert.equal(receiptReads, failure === 'receipt-read' ? 0 : 1);
  assert.equal((await listRequests(f.home)).length, failure === 'receipt-read' ? 0 : 1);
 } finally {
  fs.readFile = readFile; fs.rm = rm; syncBuiltinESMExports();
  await f.cleanup();
 }
});
