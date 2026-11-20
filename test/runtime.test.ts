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
import { familyOf, listRequests, stateDir } from '../lib/core.js';

void test('upload coordination covers importer replacement and preserves synchronous prompt bindings', async () => {
 const f = await fixture(); let dispose: (() => void | Promise<void>) | undefined, maintenance: Promise<unknown> | undefined;
 const flushing = Promise.withResolvers<void>(), release = Promise.withResolvers<void>();
 try {
  let uploadsCalled = 0, retired = 0;
  const binding = { [Symbol.dispose]() {} };
  const uploads = { stagedFiles: new WeakMap<object, Map<string, { attachment: unknown }>>(),
   upload: async (_owner?: { sessionId: string }) => { uploadsCalled++; }, uploadStream: async (_owner?: { sessionId: string }) => { uploadsCalled++; }, uploadImageStream: async (_owner?: { sessionId: string }) => { uploadsCalled++; },
   bindPrompt: (_agent: { id: string }, _files: unknown[], _request: string) => binding, retirePrompt: (_agent: { id: string }, _request: string) => { retired++; },
  };
  const attachments: Record<string, unknown> & Pick<RuntimeContext['attachments'], 'root' | 'cacheRoot'> = { root: join(f.home, 'attachments/v1'), cacheRoot: join(f.home, 'cache/attachments'), requestInflight: new Map() };
  for (const name of ['saveImage', 'saveImages', 'saveFile', 'saveFileStream', 'readImageRequest']) attachments[name] = async () => {};
  let bindImporter!: (ctx: RuntimeContext) => void;
  const runtime = makeRuntime({
   dshHomePath: () => f.home, attachments, fileUploads: uploads,
   sessions: { list: () => [] }, sessionPersistence: { name: 'session-persistence-jsonl', root: join(f.home, 'sessions'), async flush() { flushing.resolve(); await release.promise; } },
   workspaceRegistry: { pinSession() {}, async archiveSession() {}, async unarchiveSession() {} },
   agents: { list: () => [], requireFactory: () => ({ target: {} }), setFactory() {} }, sessionProjectionCache: { table: new Map<string, unknown>(), put() {} },
   sessionController: Object.fromEntries(['prompt', 'attachment', 'updateQueue', 'fork', 'rename', 'selectModel', 'create', 'resolveAgent', 'state', 'page', 'projections', 'list'].map(name => [name, () => {}])),
   schedule: { create: async () => {}, edit: async () => {}, catalog: async () => [] },
   on() { return () => {}; }, inject(names, bind) { if (names.includes('deepseekChatImport')) bindImporter = bind; }, effect(callback) { dispose = callback(); },
  });
  await runtime.initialize();
  let settle!: () => void;
  const outgoing = { active: { settled: new Promise<void>(done => { settle = done; }) }, claim() {} };
  bindImporter({ ...runtime.ctx, deepseekChatImport: outgoing });
  await assert.rejects(runtime.garbageSize(), /DeepSeek chat import/);
  await assert.rejects(runtime.gc(), /DeepSeek chat import/);
  const nativeClaim = () => ({ release() {} });
  const next = { active: undefined, claim: nativeClaim };
  bindImporter({ ...runtime.ctx, deepseekChatImport: next });
  assert.equal(runtime.barrier.idleRevision, undefined, 'the outgoing native import still owns its images during reload');
  settle(); await new Promise(setImmediate);
  assert.notEqual(runtime.barrier.idleRevision, undefined);
  assert.equal(uploads.bindPrompt({ id: f.ids.main }, [], 'request'), binding);
  runtime.locked.add(f.ids.main);
  await assert.rejects(uploads.uploadImageStream({ sessionId: f.ids.main }), /This session is being deleted/);
  assert.throws(() => uploads.bindPrompt({ id: f.ids.main }, [], 'request'), /This session is being deleted/);
  uploads.retirePrompt({ id: f.ids.main }, 'request');
  assert.equal(retired, 1, 'retirement only removes references and must remain available during disposal');
  runtime.locked.clear();
  maintenance = runtime.gc();
  await flushing.promise;
  const upload = uploads.uploadStream({ sessionId: f.ids.main });
  assert.throws(() => uploads.bindPrompt({ id: f.ids.main }, [], 'request'), /Session cleanup is in progress/);
  assert(dispose);
  const unloading = runtime.closeAdmission();
  await new Promise(setImmediate);
  assert.equal(uploadsCalled, 0);
  assert.equal(next.claim(), undefined, 'the importer stays excluded while GC drains during unload');
  await assert.rejects(runtime.gc(), /no longer active/);
  release.resolve();
  await maintenance; await upload; await unloading; await dispose(); dispose = undefined;
  assert.equal(uploadsCalled, 1);
  assert.equal(next.claim, nativeClaim, 'provider method is restored after cleanup');
 } finally { release.resolve(); await maintenance; await dispose?.(); await f.cleanup(); }
});

void test('a live-only native session listing cannot authorize deletion', async () => {
 const runtime = makeRuntime({ sessionQuery: { listSessions: async () => [
  { header: { id: 'live', createdAt: 1, version: 4 }, persisted: false },
 ] } });
 await assert.rejects(runtime.headers(), /no logs to delete/);
});

void test('GC snapshots retain staged upload references', async () => {
 const session = { id: 'session', header: { type: 'session' as const, id: 'session', version: 4, createdAt: 1 } };
 const attachment = { attachmentId: 'sha256:' + 'a'.repeat(64) };
 const stagedFiles = new WeakMap([[session, new Map([['receipt', { attachment }]])]]);
 let disposed = false;
 const runtime = makeRuntime({
  sessions: { list: () => [session] }, fileUploads: { stagedFiles },
  sessionQuery: { observeSession: async () => ({ header: session.header, events: ['live event'], [Symbol.dispose]() { disposed = true; } }) },
 });
 const { snapshots: [snapshot] } = await runtime.gcSources();
 assert.ok(disposed);
 assert(snapshot);
 assert.deepEqual(snapshot.events, ['live event']);
 assert.deepEqual(snapshot.staged, [attachment]);
});

for (const change of ['staged', 'session/event', 'transient-session', 'publication', 'maintenance', 'read-failure']) void test(`size preview rejects ${change} changes and releases its subscriptions`, async () => {
 const f = await fixture(); const readdir = fs.readdir;
 try {
  const hash = 'c'.repeat(64), attachment = { attachmentId: 'sha256:' + hash };
  await f.write(join(f.home, 'attachments/v1/objects', 'cc', hash), Buffer.alloc(2048));
  const session = { id: 'unsaved', header: { id: 'unsaved', version: 4, createdAt: 1 } };
  const stagedFiles = new WeakMap<object, Map<string, { attachment: unknown }>>(), events: unknown[] = [], listeners = new Map<string, Set<(...args: never[]) => unknown>>();
  const emit = (name: string) => { for (const listener of listeners.get(name) || []) listener(); };
  const runtime = makeRuntime({
   dshHomePath: () => f.home, sessions: { list: () => [session] }, fileUploads: { stagedFiles },
   sessionQuery: { observeSession: async () => ({ header: session.header, events, [Symbol.dispose]() {} }) },
   attachments: { requestInflight: new Map() },
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
    if (change === 'publication') await runtime.barrier.read(() => {});
    if (change === 'maintenance') runtime.maintenance = { kind: 'gc', settled: Promise.resolve() };
    if (change === 'read-failure') throw new Error('Injected preview read failure');
   }
   return readdir(...args);
  }) as typeof readdir;
  syncBuiltinESMExports();
  await assert.rejects(runtime.garbageSize(), change === 'read-failure' ? /Injected preview read failure/ : change === 'maintenance' ? /Another cleanup/ : /Sessions or attachments have changed/);
  assert.equal([...listeners.values()].reduce((count, group) => count + group.size, 0), 0, 'both success and failure must release the temporary observers');
  runtime.maintenance = undefined;
  assert.equal(await runtime.garbageSize(), ['publication', 'maintenance', 'read-failure'].includes(change) ? 2061 : 13);
  assert.equal([...listeners.values()].reduce((count, group) => count + group.size, 0), 0);
 } finally { fs.readdir = readdir; syncBuiltinESMExports(); await f.cleanup(); }
});

void test('a GC that finishes during the last size read invalidates the estimate', async () => {
 const f = await fixture(), lstat = fs.lstat;
 try {
  const runtime = makeRuntime({
   dshHomePath: () => f.home, sessions: { list: () => [] }, fileUploads: { stagedFiles: new WeakMap() },
   attachments: { requestInflight: new Map() }, sessionPersistence: { async flush() {} },
  });
  const cache = join(f.home, 'cache/attachments/request-images/ab/cache');
  let collected = false;
  fs.lstat = (async (path, options) => {
   const stat = await lstat(path, options);
   if (path === cache && options?.bigint && !collected) {
    collected = true;
    assert.equal((await runtime.gc()).cacheFiles, 1);
   }
   return stat;
  }) as typeof fs.lstat;
  syncBuiltinESMExports();
  await assert.rejects(runtime.garbageSize(), /Sessions or attachments have changed/);
  assert.ok(collected);
  assert.equal(await runtime.garbageSize(), 0);
 } finally { fs.lstat = lstat; syncBuiltinESMExports(); await f.cleanup(); }
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
 await assert.rejects(exclusive,/attachment operations are still in progress/);assert.equal(deleted,false);assert.equal(await queued,42);
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
 const exclusive = gate.exclusive(async () => { assert.throws(() => gate.assertSynchronousPublication(), /Session cleanup is in progress/); });
 assert.throws(() => gate.assertSynchronousPublication(), /Session cleanup is in progress/);
 finish(); await reader; await exclusive;
 gate.assertSynchronousPublication();
});

void test('a child created after HTTP validation requires renewed confirmation before stopping', async () => {
 const f = await fixture();
 try {
  let archived = false;
  const runtime = makeRuntime({
   dshHomePath: () => f.home,
   workspaceRegistry: { archiveSession: async () => { archived = true; } },
  });
  runtime.headers = async () => new Map(Object.entries(f.headers));
  await assert.rejects(runtime.remove(f.ids.main, 1234, [f.ids.main]), /The subagent group has changed/);
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
  // This case exercises real log removal and receipt I/O, without unrelated workspace services.
  await fs.rm(join(f.home, 'storages/workspace.json'));
  await fs.rm(join(f.home, 'storages/schedule.json'));
  const runtime = makeRuntime({
   dshHomePath: () => f.home,
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
  const ids = familyOf(headers, f.ids.main);
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
