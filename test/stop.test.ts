import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { syncBuiltinESMExports } from 'node:module';
import { spawn, type ChildProcess } from 'node:child_process';
import { once } from 'node:events';
import { join } from 'node:path';
import { hash } from 'node:crypto';
import { zstdCompressSync } from 'node:zlib';
import { setTimeout as delay } from 'node:timers/promises';
import { fixture, trackContentHashes } from './fixtures.ts';
import { makeRuntime } from './runtime-fixture.ts';
import { familyOf, exists, listRequests, stateDir, requestPath } from '../lib/core.js';
import { tryLock } from '../lib/locks.js';
import type { RuntimeContext } from '../lib/runtime.js';
import type { DeletionRuntime } from '../src/runtime.ts';

type Agent = NonNullable<ReturnType<RuntimeContext['agents']['get']>>;
type Manager = ReturnType<DeletionRuntime['manager']>;
type Activation = Parameters<Manager['dispose']>[0];
type Job = ReturnType<RuntimeContext['jobs']['list']>[number];
type JobEvent = Parameters<RuntimeContext['jobs']['events']['subscribe']>[1];
type Listener = (...args: unknown[]) => unknown;
function deferred() {
  let resolve!: () => void, reject!: (error: unknown) => void;
  const promise = new Promise<void>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

async function stoppingFixture() {
  const f = await fixture();
  // These tests run real private-file deletion; metadata behavior has separate native coverage.
  await fs.rm(join(f.home, 'storages/workspace.json'));
  await fs.rm(join(f.home, 'storages/schedule.json'));
  const agents = new Map<string, Agent>(), listeners = new Map<string, Set<Listener>>();
  const jobs = new Map<string, Job>(), jobListeners = new Set<JobEvent>();
  const terminals = new Map<Agent, string[]>();
  const disposed: string[] = [], cancelled: string[] = [], removed: string[] = [];
  const emit = (name: string, ...args: unknown[]) => { for (const listener of listeners.get(name) ?? []) listener(...args); };
  const manager: Manager = {
    resident: new Map(), materializations: new Set(), rootOf: agent => agent, assertAdmitting() {},
    dispose(activation) {
      if (activation.closing) return activation.closing;
      activation.closing = (async () => {
        if (activation.kind === 'local') await activation.handle!.dispose();
        else { activation.controller!.abort(); await activation.run!.dispose(); await activation.run!.result; }
        manager.resident.delete(activation.childId);
      })();
      return activation.closing;
    },
  };
  const subagents = { manager };
  const runtime = makeRuntime({
    dshHomePath: () => f.home, subagents,
    agents: { get: id => agents.get(id) },
    sessions: { get: id => agents.get(id)?.session, list: () => [...agents.values()].map(agent => agent.session) },
    sessionPersistence: { stat: f.stat },
    sessionProjectionCache: { table: new Map() },
    sessionQuery: { listSessions: async () => Object.values(f.headers).map(header => ({ header, persisted: true })) },
    workspaceRegistry: { archivedSessionIds: [], archiveSession: async () => { assert.fail('deletion must not archive'); } },
    jobs: {
      start() {}, list: () => [...jobs.values()], kill() {},
      events: { subscribe(_filter, listener) { jobListeners.add(listener); return () => { jobListeners.delete(listener); }; } },
    },
    on: ((name: string, listener: Listener) => {
      const group = listeners.get(name) ?? new Set<Listener>(); listeners.set(name, group); group.add(listener);
      return () => { group.delete(listener); };
    }) as RuntimeContext['on'],
    waterfall: async () => [], emit: (_name, id) => { removed.push(id); }, logger: { warn() {} },
  });
  runtime.schedule = { catalog: async () => [], create: async () => {}, edit: async () => {} };
  runtime.terminals = {
    list: agent => (terminals.get(agent) ?? []).map(sessionId => ({ sessionId, status: { kind: 'running' } })),
    hasOwnerActivity: agent => (terminals.get(agent)?.length ?? 0) > 0,
    kill: async (agent, id) => { terminals.set(agent, terminals.get(agent)!.filter(value => value !== id)); return true; },
  };
  const addAgent = (id: string, options: { work?: Promise<void>; cancel?: () => void; dispose?: () => Promise<void> } = {}) => {
    const session = { id, header: f.headers[id] };
    const agent: Agent = {
      id, session, status: options.work ? 'running' : 'idle', inbox: { nextTurn: [], nextStep: [] },
      cancel() { cancelled.push(id); agent.inbox = { nextTurn: [], nextStep: [] }; options.cancel?.(); },
      whenIdle: () => options.work ?? Promise.resolve(),
    };
    if (options.work) void options.work.then(() => { agent.status = 'idle'; }, () => {});
    agents.set(id, agent);
    runtime.handles.set(id, { agent, dispose: async () => {
      disposed.push(id);
      await options.dispose?.(); agents.delete(id);
    } });
    return agent;
  };
  const root = addAgent(f.ids.main);
  const ids = familyOf(new Map(Object.entries(f.headers)), f.ids.main);
  const confirmed = new Map(ids.map(id => [id, f.headers[id].createdAt]));
  const remove = () => runtime.remove(f.ids.main, confirmed);
  const settleJob = (job: Job, proof: boolean | undefined) => {
    job.status = 'killed';
    if (proof !== undefined) emit('session/event', agents.get(job.owner!)!.session,
      { type: 'job/settled', data: { jobId: job.id, owner: job.owner, producerReported: proof } });
    for (const listener of jobListeners) listener({ type: 'settled', job });
  };
  const drained = async () => {
    for (let i = 0; i < 100 && (runtime.deletionRunning || runtime.locked.size); i++) await delay(5);
    assert.equal(runtime.deletionRunning, false);
    assert.equal(runtime.locked.size, 0);
  };
  return { f, runtime, root, agents, manager, subagents, ids, jobs, terminals, disposed, cancelled, removed,
    emit, addAgent, settleJob, remove, drained,
    listeners: () => [...listeners.values()].reduce((count, group) => count + group.size, 0) + jobListeners.size,
  };
}

void test('live deletion stops the active root and hashes each confirmed transcript once', async t => {
  const s = await stoppingFixture();
  try {
    const idle = deferred(); s.root.status = 'running'; s.root.whenIdle = () => idle.promise;
    s.root.cancel = () => { s.cancelled.push(s.root.id); s.root.status = 'idle'; idle.resolve(); };
    const contentHashes = trackContentHashes(t);
    assert.deepEqual(await s.remove(), { deleted: 3 });
    assert.equal(contentHashes(), s.ids.length);
    assert.deepEqual(s.cancelled, [s.root.id]);
    assert.deepEqual(s.disposed, [s.root.id]);
    assert.equal(s.removed.length, 3); assert.equal(s.listeners(), 0);
    assert.deepEqual(await listRequests(s.f.home), []);
  } finally { await s.f.cleanup(); }
});

for (const kind of ['local', 'external', 'closing'] as const) void test(`joins native ${kind} Activation cleanup, including cold-resumed children without a receipt registry`, async () => {
  const s = await stoppingFixture(), cleanup = deferred();
  try {
    let activation: Activation;
    if (kind === 'external') activation = {
      childId: 'external-child', kind, root: s.root, controller: new AbortController(),
      run: { id: 'external-child', result: cleanup.promise, dispose: () => cleanup.promise },
    };
    else {
      const child = s.addAgent(s.f.ids.child, { dispose: () => cleanup.promise });
      activation = { childId: child.id, kind: 'local', root: s.root, handle: s.runtime.handles.get(child.id)! };
    }
    s.manager.resident.set(activation.childId, activation);
    if (kind === 'closing') void s.manager.dispose(activation);
    const removing = s.remove();
    for (let i = 0; i < 100 && !s.runtime.locked.has(s.root.id); i++) await delay(5);
    assert.equal(typeof activation.closing?.then, 'function', 'native closing starts before another turn can run');
    assert(s.agents.has(s.root.id)); assert.equal(s.disposed.includes(s.root.id), false);
    assert.deepEqual(await listRequests(s.f.home), []);
    cleanup.resolve(); assert.deepEqual(await removing, { deleted: 3 });
    assert.equal(s.manager.resident.size, 0); assert.equal(s.listeners(), 0);
  } finally { cleanup.resolve(); await s.f.cleanup(); }
});

for (const phase of ['agent work', 'writer drain']) void test(`the shared deadline keeps protection until late ${phase} settles`, async () => {
  const s = await stoppingFixture(), cleanup = deferred();
  try {
    s.runtime.stopTimeoutMs = 200;
    if (phase === 'agent work') s.root.whenIdle = () => cleanup.promise; // maintenance is publicly idle
    else {
      const handle = s.runtime.handles.get(s.root.id)!, dispose = handle.dispose;
      handle.dispose = async () => { await cleanup.promise; await dispose(); };
    }
    await assert.rejects(s.remove(), /did not stop within 30 seconds/);
    assert(s.runtime.isLocked(s.root.id)); assert.equal(s.runtime.deletionRunning, true);
    assert(s.agents.has(s.root.id)); assert.deepEqual(await listRequests(s.f.home), []);
    await assert.rejects(s.remove(), /Another cleanup is already in progress/);
    const unloading = s.runtime.closeAdmission();
    assert.ok(unloading);
    await assert.rejects(s.remove(), /no longer active/);
    cleanup.resolve(); await unloading;
    assert.equal(s.runtime.isLocked(s.root.id), false); assert.equal(s.agents.has(s.root.id), phase === 'agent work');
    assert.deepEqual(await listRequests(s.f.home), []);
    assert.equal(await exists(join(s.f.sessionProject, s.root.id)), true, 'late completion never enters enqueue or sweep');
    assert.equal(s.listeners(), 0);
  } finally { cleanup.resolve(); await s.drained(); await s.f.cleanup(); }
});

for (const change of ['manager', 'method', 'pending', 'identity', 'startup', 'missing-handle'] as const) void test(`refuses unsafe ${change} before stopping visible work`, async () => {
  const s = await stoppingFixture(); let operation: Promise<unknown> | undefined; const pending = deferred();
  try {
    if (change === 'missing-handle') s.runtime.handles.delete(s.root.id);
    if (change === 'manager') s.subagents.manager = {} as Manager;
    if (change === 'method') s.manager.dispose = undefined as unknown as Manager['dispose'];
    if (change === 'pending') s.manager.materializations.add({ root: s.root });
    if (change === 'identity') s.manager.resident.set('bad', { childId: 'bad', kind: 'external', root: { ...s.root, session: { ...s.root.session, header: { ...s.root.session.header, createdAt: 0 } } } });
    if (change === 'startup') operation = s.runtime.operation([s.root.id], () => pending.promise, true);
    await assert.rejects(s.remove(), change === 'missing-handle' ? /Missing full lifecycle handle/ : Error);
    assert.deepEqual(s.cancelled, []); assert.deepEqual(s.disposed, []);
    assert.deepEqual(await listRequests(s.f.home), []); assert.equal(s.listeners(), 0);
  } finally { pending.resolve(); await operation; await s.f.cleanup(); }
});

void test('manager replacement during stopping prevents commit without dropping the main row', async () => {
  const s = await stoppingFixture();
  try {
    s.root.cancel = () => { s.subagents.manager = { ...s.manager, resident: new Map() }; };
    await assert.rejects(s.remove(), /confirm/);
    assert(s.agents.has(s.root.id)); assert.deepEqual(s.disposed, []);
    assert.deepEqual(await listRequests(s.f.home), []);
  } finally { await s.f.cleanup(); }
});

for (const proof of [true, false, undefined]) void test(`job resource-release acknowledgement ${String(proof)} gates commit and ignores unowned jobs`, async () => {
  const s = await stoppingFixture();
  try {
    const job = { id: 'owned-job', owner: s.root.id, status: 'running' };
    const other = { id: 'other-job', status: 'running' };
    s.jobs.set(job.id, job); s.jobs.set(other.id, other);
    const killed: string[] = [];
    s.runtime.ctx.jobs.kill = id => { killed.push(id); s.settleJob(job, proof); };
    if (proof === true) assert.deepEqual(await s.remove(), { deleted: 3 });
    else {
      await assert.rejects(s.remove(), /Unable to confirm/);
      assert(s.agents.has(s.root.id)); assert.deepEqual(await listRequests(s.f.home), []);
    }
    assert.deepEqual(killed, [job.id]); assert.equal(other.status, 'running'); assert.equal(s.listeners(), 0);
  } finally { await s.f.cleanup(); }
});

void test('cleanup failures wait for sibling disposal and never become a successful deletion', async () => {
  const s = await stoppingFixture(), sibling = deferred();
  try {
    s.runtime.stopTimeoutMs = 200;
    for (const [id, dispose] of [[s.f.ids.child, async () => { throw Error('cleanup failed'); }], [s.f.ids.grand, () => sibling.promise]] as const) {
      s.addAgent(id, { dispose });
      s.manager.resident.set(id, { childId: id, kind: 'local', root: s.root, handle: s.runtime.handles.get(id)! });
    }
    await assert.rejects(s.remove(), /did not stop within 30 seconds/);
    assert(s.runtime.isLocked(s.root.id)); assert(s.agents.has(s.root.id));
    sibling.resolve(); await s.drained();
    assert.deepEqual(await listRequests(s.f.home), []); assert.equal(s.disposed.includes(s.root.id), false);
    assert.equal(s.listeners(), 0);
  } finally { sibling.resolve(); await s.drained(); await s.f.cleanup(); }
});

void test('PTY cleanup must remove every owned record and report no retained owner activity', async () => {
  const s = await stoppingFixture();
  try {
    s.terminals.set(s.root, ['pty-one', 'pty-two']);
    s.runtime.terminals!.kill = async () => true; // backend falsely reports success without releasing
    await assert.rejects(s.remove(), /Interactive terminal is still open/);
    assert(s.agents.has(s.root.id)); assert.deepEqual(await listRequests(s.f.home), []);
    s.runtime.terminals!.kill = async (agent, id) => { s.terminals.set(agent, s.terminals.get(agent)!.filter(value => value !== id)); return true; };
    assert.deepEqual(await s.remove(), { deleted: 3 });
  } finally { await s.f.cleanup(); }
});

void test('duplicate operation identities drain once and do not wedge stopping', async () => {
  const s = await stoppingFixture(), publication = deferred();
  try {
    const work = s.runtime.operation([s.root.id, s.root.id, s.root.id], () => publication.promise);
    const removing = s.remove();
    for (let i = 0; i < 100 && !s.runtime.locked.has(s.root.id); i++) await delay(5);
    publication.resolve(); await work;
    assert.deepEqual(await removing, { deleted: 3 });
  } finally { publication.resolve(); await s.f.cleanup(); }
});

void test('a request rename committed before a post-rename error preserves the journal and locks', async () => {
  const s = await stoppingFixture(); const rm = fs.rm;
  try {
    const handle = s.runtime.handles.get(s.root.id)!, dispose = handle.dispose;
    const { location } = await s.f.stat(s.root.id);
    handle.dispose = async () => {
      assert.deepEqual(await listRequests(s.f.home), []);
      await fs.appendFile(location.path, zstdCompressSync('{"type":"final-drain"}\n'));
      await dispose();
    };
    fs.rm = async function (path, ...args) {
      await rm.call(this, path, ...args);
      if (String(path).includes('.session-deletion-write-') && await exists(requestPath(s.f.home, s.root.id))) throw Error('post-rename cleanup failure');
    };
    syncBuiltinESMExports();
    await assert.rejects(s.remove(), /post-rename/);
    const [request] = await listRequests(s.f.home);
    const bytes = await fs.readFile(location.path);
    const transcript = request.plan.directories.find(row => row.id === s.root.id)!.transcript;
    assert.equal(transcript.sha256, hash('sha256', bytes)); assert.equal(transcript.sizeBytes, bytes.length);
    assert(s.runtime.isLocked(s.root.id)); assert.deepEqual(s.disposed, [s.root.id]);
  } finally { fs.rm = rm; syncBuiltinESMExports(); await s.f.cleanup(); }
});

for (const failure of ['writer', 'missing', 'identity', 'path', 'size', 'journal'] as const) void test(`${failure} failure before publication preserves every transcript and projection`, async () => {
  const s = await stoppingFixture(), open = fs.open;
  const competingWriter = failure === 'writer' && await tryLock(join(s.f.sessionProject, s.f.ids.grand, 'session.lock'));
  try {
    const paths = s.ids.flatMap(id => [join(s.f.sessionProject, id, 'session.v4.jsonl.zstd'),
      join(s.f.home, 'storages/session_projcache/sessions', id + '.json')]);
    const contents = () => Promise.all(paths.map(path => fs.readFile(path)));
    const before = await contents();
    let projectionDeletes = 0;
    s.runtime.ctx.sessionProjectionCache.table.delete = () => { projectionDeletes++; };
    s.runtime.ctx.sessionPersistence.stat = async id => {
      const stored = await s.f.stat(id);
      if (id !== s.root.id || s.agents.has(id)) return stored;
      for (const target of s.ids) {
        const lock = await tryLock(join(s.f.sessionProject, target, 'session.lock'));
        if (lock) { await lock.close(); assert.fail('Every family writer must be excluded during transcript capture'); }
      }
      if (failure === 'missing') return { header: stored.header };
      if (failure === 'identity') return { ...stored, header: { ...stored.header, createdAt: 0 } };
      if (failure === 'path') return { ...stored, location: (await s.f.stat(s.f.ids.other)).location };
      if (failure === 'size') return { ...stored, sizeBytes: stored.sizeBytes + 1 };
      return stored;
    };
    if (failure === 'journal') {
      fs.open = async (file, ...args) => {
        if (String(file).startsWith(join(stateDir(s.f.home), 'pending', '.session-deletion-write-'))) throw Error('journal write failed');
        return open(file, ...args);
      };
      syncBuiltinESMExports();
    }
    const reason = { writer: /writer is still active/, missing: /session has changed/, identity: /session has changed/,
      path: /Invalid deletion plan path/, size: /session has changed/, journal: /journal write failed/ };
    await assert.rejects(s.remove(), reason[failure]);
    assert.deepEqual(await listRequests(s.f.home), []); assert.equal(projectionDeletes, 0);
    assert.deepEqual(await contents(), before); assert.equal(s.runtime.locked.size, 0);
    assert.deepEqual(s.runtime.receipt.deletedIdHashes, []);
  } finally { fs.open = open; syncBuiltinESMExports(); if (competingWriter) await competingWriter.close(); await s.f.cleanup(); }
});

void test('a second same-home host started during transcript capture prevents journal publication', async () => {
  const s = await stoppingFixture();
  let host: ChildProcess | undefined;
  try {
    const entry = join(s.f.base, '@deepseek-ai/dsh/lib/bin.js');
    await s.f.write(entry, "process.send('ready'); setInterval(() => {}, 1000)");
    s.runtime.ctx.sessionPersistence.stat = async id => {
      if (!s.agents.has(s.root.id) && !host) {
        host = spawn(process.execPath, [entry], { env: { ...process.env, DSH_HOME: s.f.home }, stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
        await once(host, 'message');
      }
      return s.f.stat(id);
    };
    await assert.rejects(s.remove(), /Another DSH process/);
    assert.deepEqual(await listRequests(s.f.home), []);
    assert.equal(s.runtime.locked.size, 0);
    for (const id of s.ids) assert.ok(await s.f.stat(id));
  } finally {
    if (host) { const done = once(host, 'exit'); host.kill(); await done; }
    await s.f.cleanup();
  }
});

for (const change of ['new child', 'delivery reservation']) void test(`a ${change} published during capture invalidates the request`, async () => {
  const s = await stoppingFixture();
  try {
    s.runtime.ctx.sessionPersistence.stat = async id => {
      if (id === s.root.id && !s.agents.has(id)) {
        if (change === 'new child') await s.f.session('late-child', { parentSession: id, origin: 'subagent' });
        else await s.f.write(join(s.f.home, 'storages/schedule.json'), JSON.stringify({
          unit: { name: 'schedule', version: 2 }, tables: { tasks: { reminder: { target: { kind: 'new' }, pendingDelivery: { targetSessionId: id } } } },
        }));
      }
      return s.f.stat(id);
    };
    await assert.rejects(s.remove(), change === 'new child' ? /subagent group has changed/ : /Message submissions or session operations/);
    assert.deepEqual(await listRequests(s.f.home), []);
    assert.equal(s.runtime.locked.size, 0);
    for (const id of s.ids) assert.ok(await s.f.stat(id));
  } finally { await s.f.cleanup(); }
});

void test('a long transcript read leaves time for the final family and schedule checks', async t => {
  const s = await stoppingFixture();
  try {
    const now = performance.now.bind(performance);
    s.runtime.ctx.sessionPersistence.stat = async id => {
      if (id === s.root.id && !s.agents.has(id)) t.mock.method(performance, 'now', () => now() + 60_000);
      return s.f.stat(id);
    };
    const headers = s.runtime.headers.bind(s.runtime);
    s.runtime.headers = async () => {
      if (!s.agents.has(s.root.id)) await delay(10);
      return headers();
    };
    assert.deepEqual(await s.remove(), { deleted: 3 });
  } finally { await s.f.cleanup(); }
});

void test('directory fsync failure after journal rename cannot reopen the target', { skip: process.platform !== 'linux' }, async () => {
  const s = await stoppingFixture(); const open = fs.open; let failed = false;
  try {
    fs.open = async (path, ...args) => {
      const handle = await open(path, ...args);
      if (String(path) === join(stateDir(s.f.home), 'pending')) {
        const sync = handle.sync.bind(handle);
        handle.sync = async () => {
          if (await exists(requestPath(s.f.home, s.root.id))) { failed = true; throw Error('journal directory fsync failure'); }
          await sync();
        };
      }
      return handle;
    };
    syncBuiltinESMExports();
    await assert.rejects(s.remove(), /directory fsync/);
    assert.equal(failed, true); assert.equal((await listRequests(s.f.home)).length, 1);
    assert(s.runtime.isLocked(s.root.id)); assert.deepEqual(s.disposed, [s.root.id]);
  } finally { fs.open = open; syncBuiltinESMExports(); await s.f.cleanup(); }
});

void test('a final read crossing the deadline cannot enqueue after it eventually returns', async () => {
  const s = await stoppingFixture(), read = deferred();
  try {
    s.runtime.stopTimeoutMs = 200;
    const headers = s.runtime.headers.bind(s.runtime); let reads = 0;
    s.runtime.headers = async () => { if (++reads > 1) await read.promise; return headers(); };
    await assert.rejects(s.remove(), /did not stop within 30 seconds/);
    assert.deepEqual(s.cancelled, [s.root.id]); assert.deepEqual(s.disposed, [s.root.id]);
    assert.deepEqual(await listRequests(s.f.home), []);
    read.resolve(); await delay(10);
    assert.deepEqual(await listRequests(s.f.home), []); assert.equal(await exists((await s.f.stat(s.root.id)).location.path), true);
  } finally { read.resolve(); await s.f.cleanup(); }
});

void test('slow read-only preflight expires before sending any stop signal', async () => {
  const s = await stoppingFixture(), read = deferred();
  try {
    s.runtime.stopTimeoutMs = 30;
    const headers = s.runtime.headers.bind(s.runtime);
    s.runtime.headers = async () => { await read.promise; return headers(); };
    await assert.rejects(s.remove(), /did not stop within 30 seconds/);
    assert.deepEqual(s.cancelled, []); assert.deepEqual(s.disposed, []);
    read.resolve(); await delay(10);
    assert.deepEqual(await listRequests(s.f.home), []);
    assert.equal(s.runtime.deletionRunning, false);
  } finally { read.resolve(); await s.f.cleanup(); }
});

void test('a preparation timeout never waits for a second pending-directory inspection', async () => {
  const s = await stoppingFixture(), read = deferred(), entered = deferred(), journalRead = deferred(); const lstat = fs.lstat;
  let inspections = 0, rejected = false, rejection: Promise<void> | undefined;
  try {
    s.runtime.stopTimeoutMs = 200;
    const headers = s.runtime.headers.bind(s.runtime); let reads = 0;
    s.runtime.headers = async () => { if (++reads > 1) { entered.resolve(); await read.promise; } return headers(); };
    fs.lstat = (async (...args: Parameters<typeof lstat>) => {
      if (String(args[0]) === join(stateDir(s.f.home), 'pending') && ++inspections > 1) await journalRead.promise;
      return lstat(...args);
    }) as typeof lstat;
    syncBuiltinESMExports();
    rejection = assert.rejects(s.remove(), /did not stop within 30 seconds/).then(() => { rejected = true; });
    await Promise.race([entered.promise, rejection.then(() => { throw Error('The test never reached the locked preparation stage'); })]);
    await delay(250);
    assert.equal(rejected, true, 'a finalizer read must not extend an already-expired, uncommitted attempt');
    assert.equal(inspections, 1); assert.deepEqual(s.cancelled, [s.root.id]);
  } finally {
    read.resolve(); journalRead.resolve(); fs.lstat = lstat; syncBuiltinESMExports();
    await rejection; await s.f.cleanup();
  }
});

for (const state of ['pending', 'late-pending', 'completed', 'other'] as const) void test(`new-session reminder ${state} preserves its delivery reservation`, async () => {
  const s = await stoppingFixture();
  try {
    const pending = state === 'pending' || state === 'late-pending';
    const task = {
      record: { id: 'schedule-new', kind: 'after', title: 'Reminder', prompt: 'Offline', afterSeconds: 3600, scheduledAt: '2030-01-01T00:00:00.000Z' },
      target: { kind: 'new', create: {} }, status: 'active',
      ...state === 'completed' ? { lastDelivery: { targetSessionId: s.root.id } }
        : { pendingDelivery: { targetSessionId: state === 'other' ? s.f.ids.other : s.root.id } },
    };
    const path = join(s.f.home, 'storages/schedule.json');
    const write = () => s.f.write(path, JSON.stringify({ unit: { name: 'schedule', version: 2 }, tables: { tasks: { 'schedule-new': task } } }));
    if (state === 'late-pending') {
      let writing: Promise<void> | undefined;
      s.root.whenIdle = () => writing ??= write();
    }
    else await write();
    if (pending) {
      await assert.rejects(s.remove(), /Message submissions or session operations/);
      assert(s.agents.has(s.root.id)); assert.deepEqual(s.disposed, []); assert.deepEqual(await listRequests(s.f.home), []);
      assert.deepEqual(s.cancelled, state === 'pending' ? [] : [s.root.id]);
    } else assert.deepEqual(await s.remove(), { deleted: 3 });
    assert.deepEqual(JSON.parse(await fs.readFile(path, 'utf8')).tables.tasks['schedule-new'], task, 'neither historical deliveries nor another pending destination justify deleting the reminder');
  } finally { await s.f.cleanup(); }
});
