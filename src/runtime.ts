/** Version-pinned online adapter. Public lifecycle handles own teardown; a small
 * set of guarded internal cache hooks closes the missing deletion seam. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL } from 'node:url';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { digest, enqueue, familyOf, listRequests, readJSON, stateDir, sweep, planSessionDeletion, collectGarbage, garbageSize,
  type LiveSnapshot, type Receipt, type SessionHeader, type SessionMap, type GcResult } from './core.js';
import { tryLock, waitingHosts, otherHosts } from './guard.js';
import type { Lock } from './platform/index.js';
import { hostRequire, type Gate } from './gate.js';
import { LocalizedError, message, type LocalizedMessage } from './locale.js';

// Narrow contracts for the services used from the reviewed DSH release.
interface Session { id: string; header: SessionHeader }
interface Agent {
  id: string; session: Session; status: string; whenIdle(): Promise<void>;
  inbox?: { nextTurn?: readonly unknown[]; nextStep?: readonly unknown[] };
}
interface Handle { agent: Agent; dispose(): Promise<void> }
interface FactoryOptions { sessionId?: string; resumeSessionId?: string; parentAgent?: { id: string }; meta?: { parentSession?: string } }
interface SessionRequest { sessionId?: string; parentSession?: string }
interface DeletionCache { delete(id: string): unknown }
interface Schedule {
  catalog(): Promise<Array<{ sessionId: string; id: string }>>;
  delete(request: { sessionId: string; id: string }): Promise<unknown>;
}
interface Terminals { list(agent: Agent): Array<{ status?: { kind: string } }> }
interface UploadRecord { scope: string; attachmentId: string; variantId: string; fileId: string }
export interface UploadIndex {
  load(): Promise<{ records: UploadRecord[] }>;
  remove(scope: string, records: Array<Pick<UploadRecord, 'variantId' | 'fileId'>>): Promise<unknown>;
}
export interface RuntimeContext {
  sessionDeletionGate: Gate;
  attachments: { root: string; cacheRoot: string; requestInflight: { size: number } };
  fileUploads: { stagedFiles: WeakMap<object, Map<string, { attachment: unknown }>> };
  agents: { get(id: string): Agent | undefined; requireFactory(): { target: object }; setFactory(...args: unknown[]): unknown; factory?: { target: object } };
  sessions: { list(): Session[]; get(id: string): Session | undefined };
  sessionPersistence: {
    list(): Promise<Array<{ header: SessionHeader }>>;
    stat(id: string): Promise<{ sizeBytes: number } | undefined>;
    flush(): Promise<void>;
    coldLogMemo?: DeletionCache;
  };
  sessionProjectionCache: { table: DeletionCache; put(id: string, ...args: unknown[]): unknown };
  sessionQuery: {
    observeSession(id: string, options: { projectionMode: 'none' }): Promise<LiveSnapshot & Disposable>;
    _observations?: { cache?: DeletionCache };
  };
  workspaceRegistry: {
    archivedSessionIds: string[];
    pinSession(id: string): unknown;
    archiveSession(id: string): Promise<unknown>;
    unarchiveSession(id: string): Promise<void>;
    unpinSession(id: string): Promise<unknown>;
    list(): Array<{ sessionIds: string[]; detachSession(id: string): Promise<unknown> }>;
    headers?: DeletionCache; sessionPaths?: DeletionCache; missingSessionPaths?: DeletionCache; invalidSessionPaths?: DeletionCache;
  };
  sessionController: object;
  schedule: Schedule;
  terminals: Terminals;
  on(name: 'agent/created' | 'agent/disposed', listener: (event: { agent: Agent }) => unknown): () => void;
  on(name: 'agent/pre-step', listener: (event: { agent: Agent }, next: () => Promise<unknown>) => unknown): () => void;
  on(name: 'session/created' | 'session/disposed' | 'session/event', listener: () => unknown): () => void;
  inject(names: string[], callback: (ctx: RuntimeContext) => void): unknown;
  effect(callback: () => () => void, label?: string): unknown;
  provide(name: string, value: unknown): unknown;
  emit(name: 'api-session/removed', id: string): unknown;
  waterfall(name: 'workspace/session-activity', request: { sessionId: string }, fallback: () => Promise<unknown[]>): Promise<Array<{ kind?: string }>>;
  logger: { warn(message: string, error: unknown): unknown };
}
type Method = (this: unknown, ...args: unknown[]) => unknown;
export interface Activity { busy: boolean; reasons: LocalizedMessage[] }
export class DeletionRefused extends LocalizedError { readonly status = 409; }

/** Briefly serialize input/attachment publication while collecting references.
 * Reentrant service calls keep their lease, avoiding nested-call deadlocks. */
export class PublicationBarrier {
  private context = new AsyncLocalStorage<{ open: boolean }>();
  private active = 0;
  private blocked = false;
  private waiters: (() => void)[] = [];
  assertSynchronousPublication(): void {
    if (this.blocked && !this.context.getStore()?.open) throw new DeletionRefused('error.publicationBlocked');
  }
  async read<T>(work: () => Promise<T> | T): Promise<T> {
    // Detached tasks inherit ALS, but must not inherit an already returned
    // caller's permission. Count nested work too, even when it is not awaited.
    if (!this.context.getStore()?.open) {
      while (this.blocked) await new Promise<void>(resolve => this.waiters.push(resolve));
    }
    const lease = { open: true };
    this.active++;
    try { return await this.context.run(lease, work); }
    finally { lease.open = false; this.active--; }
  }
  async exclusive<T>(work: () => Promise<T>, timeoutMs = 15000): Promise<T> {
    if (this.blocked) throw new DeletionRefused('error.cleanupBusy');
    this.blocked = true;
    try {
      const deadline = Date.now() + timeoutMs;
      while (this.active) {
        if (Date.now() > deadline) throw new DeletionRefused('error.publicationTimeout');
        await delay(10);
      }
      return await work();
    } finally {
      this.blocked = false;
      for (const resume of this.waiters.splice(0)) resume();
    }
  }
}

export class DeletionRuntime {
  readonly locked = new Set<string>();
  readonly barrier = new PublicationBarrier();
  private handles = new Map<string, Handle>();
  private operations = new Map<string, number>();
  private deleted = new Set<string>();
  private receiptRevision = '';
  private cacheWrites = new Map<string, Set<Promise<unknown>>>();
  private restorers: (() => void)[] = [];
  private agentRestorers = new Map<Agent, (() => void)[]>();
  private wrapped = new WeakMap<object, Set<string>>();
  private controller?: object;
  private schedule?: Schedule;
  private terminals?: Terminals;
  private unarchiveForCleanup!: (id: string) => Promise<void>;
  private maintenance?: 'delete' | 'gc';
  get gcRunning(): boolean { return this.maintenance === 'gc'; }
  get deletionRunning(): boolean { return this.maintenance === 'delete'; }
  constructor(readonly ctx: RuntimeContext, private unwrap: <T extends object>(value: T) => T, private UploadIndex: new(path: string) => UploadIndex) {}
  get home(): string { return (this.ctx.sessionDeletionGate as Gate).home; }
  get receiptSummary() { return { revision: this.receiptRevision, count: this.deleted.size }; }
  get receipt() { return { revision: this.receiptRevision, deletedIdHashes: [...this.deleted] }; }
  isLocked(id: string): boolean { return this.locked.has(id) || this.deleted.has(digest(id)); }
  private assertAllowed(ids: string[]): void {
    if (ids.some(id => this.isLocked(id))) throw new DeletionRefused('error.sessionLocked');
  }
  private operation<T>(ids: string[], work: () => Promise<T> | T): Promise<T> {
    this.assertAllowed(ids);
    return this.barrier.read(async () => {
      this.assertAllowed(ids);
      // Queued submissions have not published anything and must not make the
      // GC's idle check fail merely because they arrived behind its barrier.
      for (const id of ids) this.operations.set(id, (this.operations.get(id) || 0) + 1);
      try { return await work(); }
      finally { for (const id of ids) {
        const count = (this.operations.get(id) || 1) - 1;
        if (count) this.operations.set(id, count); else this.operations.delete(id);
      } }
    });
  }
  private patch(object: object, key: string, wrap: (original: Method) => Method, required = true, restorers = this.restorers): void {
    const target = this.unwrap(object) as Record<string, unknown>;
    const names = this.wrapped.get(target) || new Set<string>();
    if (names.has(key)) return;
    const original = target[key];
    if (typeof original !== 'function') {
      if (required) throw new Error(`Unsupported DSH capability: ${key}`);
      return;
    }
    const own = Object.getOwnPropertyDescriptor(target, key);
    const replacement = wrap(original as Method);
    target[key] = replacement; names.add(key); this.wrapped.set(target, names);
    restorers.push(() => {
      if (target[key] !== replacement) return;
      if (own) Object.defineProperty(target, key, own); else delete target[key];
    });
  }
  private trackAgent(agent: Agent): void {
    const runtime = this;
    const restorers = this.agentRestorers.get(agent) || [];
    this.agentRestorers.set(agent, restorers);
    for (const name of ['send', 'followup', 'steer', 'inject', 'runMaintenance']) {
      this.patch(agent, name, original => function (...args) {
        runtime.assertAllowed([(this as Agent).id]);
        runtime.barrier.assertSynchronousPublication();
        return Reflect.apply(original, this, args);
      }, false, restorers);
    }
  }
  private captureFactory(factory: object): void {
    const runtime = this;
    for (const name of ['createAgent', 'resume']) this.patch(factory, name, original => function (owner, options) {
      const input = options as FactoryOptions;
      const ids = [input.sessionId, input.resumeSessionId, input.parentAgent?.id, input.meta?.parentSession].filter((x): x is string => typeof x === 'string');
      return runtime.operation(ids, async () => {
        const handle = await Reflect.apply(original, this, [owner, options]) as Handle;
        runtime.handles.set(handle.agent.id, handle);
        runtime.trackAgent(handle.agent);
        if (ids.some(id => runtime.isLocked(id))) {
          await handle.dispose();
          throw new DeletionRefused('error.sessionReopen');
        }
        return handle;
      });
    });
  }
  private installReceipt(receipt: Receipt): void {
    this.deleted = new Set(receipt.deletedIdHashes);
    this.receiptRevision = receipt.revision;
  }
  private async loadReceipt(): Promise<void> {
    this.installReceipt(await readJSON<Receipt>(join(stateDir(this.home), 'receipt.json'), { schema: 1, revision: '', deletedIdHashes: [] }));
  }
  async initialize(): Promise<void> {
    await this.loadReceipt();
    const runtime = this;
    if (this.ctx.attachments.root !== join(this.home, 'attachments', 'v1')
      || this.ctx.attachments.cacheRoot !== join(this.home, 'cache', 'attachments')) throw new Error('Unsupported attachment storage');
    const workspaces = this.unwrap(this.ctx.workspaceRegistry);
    const unarchive = workspaces.unarchiveSession;
    this.unarchiveForCleanup = id => Reflect.apply(unarchive, workspaces, [id]);
    for (const name of ['pinSession', 'unarchiveSession', 'archiveSession']) this.patch(workspaces, name, original => function (id, ...args) {
      return runtime.operation([id as string], () => Reflect.apply(original, this, [id, ...args]));
    });
    const registry = this.unwrap(this.ctx.agents);
    if (typeof registry.requireFactory !== 'function') throw new Error('Unsupported AgentRegistry lifecycle');
    this.patch(registry, 'setFactory', original => function (...args) {
      const disposer = Reflect.apply(original, this, args);
      runtime.captureFactory((this as RuntimeContext['agents']).requireFactory().target);
      return disposer;
    });
    if (registry.factory?.target) this.captureFactory(registry.factory.target);
    const cache = this.unwrap(this.ctx.sessionProjectionCache);
    if (!cache.table || typeof cache.table.delete !== 'function') throw new Error('Projection cache deletion capability is missing');
    this.patch(cache, 'put', original => function (key, ...args) {
      const id = key as string;
      if (runtime.isLocked(id)) return Promise.resolve();
      const promise = Promise.resolve(Reflect.apply(original, this, [id, ...args]));
      const writes = runtime.cacheWrites.get(id) || new Set<Promise<unknown>>();
      writes.add(promise); runtime.cacheWrites.set(id, writes);
      return promise.finally(() => { writes.delete(promise); if (!writes.size) runtime.cacheWrites.delete(id); });
    });
    for (const method of ['saveImage', 'saveImages', 'saveFile', 'saveFileStream', 'readImageRequest']) {
      this.patch(this.ctx.attachments, method, original => function (...args) {
        return runtime.barrier.read(() => Reflect.apply(original, this, args));
      });
    }
    const uploads = this.unwrap(this.ctx.fileUploads);
    if (!(uploads.stagedFiles instanceof WeakMap)) throw new Error('Unsupported staged file ownership');
    for (const method of ['upload', 'uploadStream', 'uploadImageStream']) this.patch(uploads, method, original => async function (owner, ...args) {
      const input = owner as { id?: string; sessionId?: string };
      return runtime.operation([(input.id ?? input.sessionId)!], () => Reflect.apply(original, this, [owner, ...args]));
    });
    this.patch(uploads, 'bindPrompt', original => function (agent, ...args) {
      runtime.assertAllowed([(agent as Agent).id]); runtime.barrier.assertSynchronousPublication();
      return Reflect.apply(original, this, [agent, ...args]);
    });
    this.ctx.on('agent/created', ({ agent }: { agent: Agent }) => {
      // The creation callback may reject publication; the factory rolls it back.
      runtime.assertAllowed([agent.id, agent.session.header.parentSession].filter((x): x is string => !!x));
      runtime.trackAgent(agent);
    });
    this.ctx.on('agent/disposed', ({ agent }: { agent: Agent }) => {
      runtime.handles.delete(agent.id);
      // Do not retain a deleted transcript through adapter restoration closures.
      runtime.agentRestorers.delete(agent);
    });
    this.ctx.on('agent/pre-step', async ({ agent }: { agent: Agent }, next: () => Promise<unknown>) =>
      runtime.barrier.read(() => runtime.isLocked(agent.id) ? { kind: 'reject' } : next()));
    this.ctx.inject(['sessionController'], (ctx: RuntimeContext) => {
      runtime.controller = ctx.sessionController;
      for (const name of ['prompt', 'attachment', 'updateQueue', 'fork', 'rename', 'selectModel', 'create']) {
        runtime.patch(ctx.sessionController, name, original => function (request, ...args) {
          const input = request as SessionRequest | undefined;
          const ids = [input?.sessionId, input?.parentSession].filter((x): x is string => typeof x === 'string');
          return runtime.operation(ids, () => Reflect.apply(original, this, [request, ...args]));
        });
      }
      for (const name of ['resolveAgent', 'inspect', 'page', 'projections']) {
        runtime.patch(ctx.sessionController, name, original => function (request, ...args) {
          const id = typeof request === 'string' ? request : (request as SessionRequest | undefined)?.sessionId;
          return runtime.operation(id ? [id] : [], async () => {
            const result = await Reflect.apply(original, this, [request, ...args]);
            if (id) runtime.assertAllowed([id]);
            return result;
          });
        });
      }
      runtime.patch(ctx.sessionController, 'list', original => async function (...args) {
        const result = await Reflect.apply(original, this, args) as { items: Array<{ sessionId: string }> };
        if (!Array.isArray(result?.items)) throw new Error('Unsupported session list response');
        return { ...result, items: result.items.filter((row: { sessionId: string }) => !runtime.deleted.has(digest(row.sessionId))) };
      });
    });
    this.ctx.inject(['schedule'], (ctx: RuntimeContext) => {
      runtime.schedule = ctx.schedule;
      runtime.patch(ctx.schedule, 'create', original => function (id, ...args) { return runtime.operation([id as string], () => Reflect.apply(original, this, [id, ...args])); });
      runtime.patch(ctx.schedule, 'update', original => function (request, ...args) { return runtime.operation([(request as { sessionId: string }).sessionId], () => Reflect.apply(original, this, [request, ...args])); });
    });
    this.ctx.inject(['terminals'], (ctx: RuntimeContext) => {
      runtime.terminals = ctx.terminals;
      for (const name of ['spawn', 'send', 'signal']) runtime.patch(ctx.terminals, name, original => function (owner, ...args) {
        runtime.assertAllowed([(owner as { id: string }).id]); runtime.barrier.assertSynchronousPublication(); return Reflect.apply(original, this, [owner, ...args]);
      }, false);
    });
    this.ctx.effect(() => () => {
      for (const restorers of runtime.agentRestorers.values()) for (const restore of restorers.reverse()) restore();
      runtime.agentRestorers.clear();
      for (const restore of runtime.restorers.reverse()) restore();
    }, 'session-deletion runtime adapters');
  }
  async headers(): Promise<Map<string, SessionHeader>> {
    const map = new Map<string, SessionHeader>((await this.ctx.sessionPersistence.list()).map((s) => [s.header.id, s.header]));
    for (const session of this.ctx.sessions.list()) map.set(session.id, session.header);
    return map;
  }
  family(headers: Map<string, SessionHeader>, id: string): string[] {
    const sessions = new Map([...headers].map(([key, header]) => [key, { header }])) as SessionMap;
    return [...familyOf(sessions, id)].sort();
  }
  /** One final check after native archival, never a continuous activity monitor. */
  private async quiescence(ids: string[], global = false): Promise<Activity> {
    const reasons: LocalizedMessage[] = [];
    if (!this.controller || !this.schedule) reasons.push(message('activity.initializing'));
    const targets = new Set(ids);
    const all = new Set(global ? this.ctx.sessions.list().map((session) => session.id) as string[] : ids);
    for (const id of all) {
      if (targets.has(id)) {
        const stored = await this.ctx.sessionPersistence.stat(id);
        if (!stored || !(stored.sizeBytes > 0)) reasons.push(message('activity.unsaved'));
      }
      if (this.operations.get(id)) reasons.push(message('activity.operations'));
      const agent = this.ctx.agents.get(id) as Agent | undefined;
      if (agent) {
        if (agent.status !== 'idle') reasons.push(message(global ? 'activity.globalAgentBusy' : 'activity.targetAgentBusy'));
        if (agent.inbox?.nextTurn?.length || agent.inbox?.nextStep?.length) reasons.push(message('activity.queuedInput'));
        if (targets.has(id) && !this.handles.has(id)) reasons.push(message('activity.missingHandle'));
        const idle = await Promise.race([agent.whenIdle().then(() => true), delay(0).then(() => false)]);
        if (!idle) reasons.push(message('activity.maintenance'));
        if (this.terminals?.list(agent).some((terminal) => terminal.status?.kind === 'running')) reasons.push(message('activity.terminal'));
      } else if (this.ctx.sessions.get(id)) reasons.push(message('activity.residentSession'));
      try {
        const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]));
        for (const item of activity) {
          // Future reminders in another conversation are not work in flight.
          if (global && item.kind === 'schedule') continue;
          reasons.push(item.kind ? message('activity.nativeBusy', { kind: item.kind }) : message('activity.nativeBusyUnknown'));
        }
      } catch { reasons.push(message('activity.unconfirmed')); }
    }
    return { busy: reasons.length > 0, reasons: [...new Map(reasons.map(reason => [JSON.stringify(reason), reason])).values()] };
  }
  get archivedIds(): string[] { return [...this.ctx.workspaceRegistry.archivedSessionIds]; }
  private async snapshots(): Promise<Map<string, LiveSnapshot>> {
    const map = new Map<string, LiveSnapshot>();
    for (const session of this.ctx.sessions.list()) {
      const observation = await this.ctx.sessionQuery.observeSession(session.id, { projectionMode: 'none' });
      try {
        const staged = this.unwrap(this.ctx.fileUploads).stagedFiles.get(session);
        map.set(session.id, { header: observation.header, events: [
          ...observation.events,
          ...[...(staged?.values() || [])].map((upload) => upload.attachment),
        ] });
      }
      finally { observation[Symbol.dispose](); }
    }
    return map;
  }
  async remove(id: string, createdAt: number, expectedIds: readonly string[]): Promise<{ deleted: number }> {
    if (this.maintenance) throw new DeletionRefused('error.cleanupBusy');
    this.maintenance = 'delete';
    try { return await this.removeOne(id, createdAt, expectedIds); }
    finally { this.maintenance = undefined; }
  }
  async garbageSize(): Promise<number> {
    if (this.maintenance) throw new DeletionRefused('error.cleanupBusy');
    let changed = false;
    const subscriptions = (['session/created', 'session/disposed', 'session/event'] as const).map(name => this.ctx.on(name, () => { changed = true; }));
    // Session events cover log/lifecycle changes; staged uploads can change without an event.
    const current = () => JSON.stringify([this.receiptRevision, this.ctx.sessions.list().map((session) => [
      session.id, [...(this.unwrap(this.ctx.fileUploads).stagedFiles.get(session)?.values() || [])].map((upload) => upload.attachment),
    ])]);
    try {
      const before = current();
      const bytes = await garbageSize(this.home, () => this.snapshots());
      if (changed || this.maintenance || before !== current()) throw new DeletionRefused('error.sizeChanged');
      return bytes;
    } finally { for (const dispose of subscriptions) dispose(); }
  }
  async gc(): Promise<GcResult> {
    if (this.maintenance) throw new DeletionRefused('error.cleanupBusy');
    if (!(this.ctx.sessionDeletionGate as Gate).healthy()) throw new DeletionRefused('error.guardUnavailable');
    this.maintenance = 'gc';
    try {
      return await this.barrier.exclusive(async () => {
        const excluded = await waitingHosts(stateDir(this.home)); excluded.add(process.pid);
        if ((await otherHosts(this.home, excluded)).length) throw new DeletionRefused('error.otherHost');
        if ((await listRequests(this.home)).length) throw new DeletionRefused('error.pendingDeletion');
        const activity = await this.quiescence([], true);
        if (activity.busy) throw new DeletionRefused(activity.reasons);
        // A canceled image caller can finish before its shared compression work.
        if (this.unwrap(this.ctx.attachments).requestInflight.size) throw new DeletionRefused('error.imageCacheBusy');
        await this.ctx.sessionPersistence.flush();
        await Promise.all([...this.cacheWrites.values()].flatMap(writes => [...writes]));
        return collectGarbage(this.home, { hooks: {
          snapshots: () => this.snapshots(), removeUploadMappings: hashes => this.removeUploadMappings(hashes),
        } });
      });
    } finally { this.maintenance = undefined; }
  }
  private async removeUploadMappings(hashes: ReadonlySet<string>): Promise<void> {
    const path = join(this.home, 'llm-deepseek/files-v3.json');
    const index = new this.UploadIndex(path); const current = await index.load();
    const groups = new Map<string, UploadRecord[]>();
    for (const record of current.records) if (hashes.has(String(record.attachmentId).replace(/^sha256:/, ''))) {
      const rows = groups.get(record.scope) || []; rows.push(record); groups.set(record.scope, rows);
    }
    for (const [scope, rows] of groups) await index.remove(scope, rows.map(r => ({ variantId: r.variantId, fileId: r.fileId })));
  }
  private async removeOne(id: string, createdAt: number, expectedIds: readonly string[]): Promise<{ deleted: number }> {
    if (!(this.ctx.sessionDeletionGate as Gate).healthy()) throw new DeletionRefused('error.guardUnavailable');
    if ((await listRequests(this.home)).length) throw new DeletionRefused('error.pendingCleanup');
    const headers = await this.headers(); const root = headers.get(id);
    if (!root || root.createdAt !== createdAt) throw new DeletionRefused('error.sessionChanged');
    const ids = this.family(headers, id);
    if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) throw new DeletionRefused('error.familyChanged');
    // Reuse DSH's own admission and durable archive write. Do not reimplement
    // its running-turn/job/subagent/schedule monitor or force-stop active work.
    try { await this.ctx.workspaceRegistry.archiveSession(id); }
    catch (e) { throw new DeletionRefused('error.archiveIncomplete', { detail: e instanceof Error ? e.message : '' }); }
    if (!this.ctx.workspaceRegistry.archivedSessionIds.includes(id)) throw new DeletionRefused('error.archiveUnconfirmed');
    this.assertAllowed(ids);
    // No await between publishing these locks: other tabs and background input
    // are rejected before the asynchronous authoritative activity checks begin.
    for (const member of ids) this.locked.add(member);
    let journaled = false; let committed = false;
    const writerLocks: Lock[] = [];
    try {
      const excluded = await waitingHosts(stateDir(this.home)); excluded.add(process.pid);
      if ((await otherHosts(this.home, excluded)).length) throw new DeletionRefused('error.otherHost');
      const again = await this.quiescence(ids);
      if (again.busy) throw new DeletionRefused(again.reasons);
      if (JSON.stringify(this.family(await this.headers(), id)) !== JSON.stringify(ids)) throw new DeletionRefused('error.familyChanged');
      // Commit only private paths. No attachment reference snapshot is needed.
      const request = await enqueue(this.home, root, await planSessionDeletion(this.home, headers, id));
      journaled = true;
      for (const member of [...ids].reverse()) {
        const agent = this.ctx.agents.get(member);
        if (agent) {
          const handle = this.handles.get(member);
          if (!handle || handle.agent !== agent) throw new Error('Lifecycle changed before disposal');
          await handle.dispose();
        }
        if (this.ctx.sessions.get(member) || this.ctx.agents.get(member)) throw new Error('Session did not leave its live stores');
        const writes = this.cacheWrites.get(member);
        if (writes?.size) await Promise.all(writes);
        await this.unwrap(this.ctx.sessionProjectionCache).table.delete(member);
      }
      for (const record of request.plan.directories) {
        const lock = await tryLock(join(this.home, record.path, 'session.lock'));
        if (!lock) throw new Error('A session writer is still active');
        writerLocks.push(lock);
      }
      const result = await sweep(this.home, { hooks: {
        onlySessionId: id,
        receiptCommitted: receipt => { this.installReceipt(receipt); committed = true; },
        applyEdit: async (edit, targets) => {
          const path = relative(this.home, edit.path);
          if (path === join('storages', 'workspace.json')) {
            for (const workspace of this.ctx.workspaceRegistry.list()) for (const member of targets) {
              if (workspace.sessionIds.includes(member)) await workspace.detachSession(member);
            }
            const registry = this.unwrap(this.ctx.workspaceRegistry);
            for (const member of targets) {
              await registry.unpinSession(member); await this.unarchiveForCleanup(member);
              for (const key of ['headers', 'sessionPaths', 'missingSessionPaths', 'invalidSessionPaths'] as const) registry[key]?.delete(member);
            }
          } else if (path === join('storages', 'schedule.json')) {
            for (const task of await this.schedule!.catalog()) if (targets.has(task.sessionId)) await this.schedule!.delete({ sessionId: task.sessionId, id: task.id });
          } else throw new Error('Unsupported live storage edit: ' + path);
        },
      } });
      return { deleted: result.reduce((n, value) => n + value.sessions, 0) };
    } finally {
      await Promise.all(writerLocks.map(lock => lock.close()));
      if (journaled) {
        // A request unlink/fsync or diagnostic write can fail after commit.
        // Install every tombstone before notifying fallible downstream listeners.
        // A rename may have succeeded even when its directory sync failed before the commit notification.
        if (!committed) await this.loadReceipt();
        const completed = ids.filter(member => this.deleted.has(digest(member)));
        for (const member of completed) {
          this.unwrap(this.ctx.sessionPersistence).coldLogMemo?.delete(member);
          this.unwrap(this.ctx.sessionQuery)._observations?.cache?.delete(member);
          try { this.ctx.emit('api-session/removed', member); }
          catch (error) { this.ctx.logger.warn('Session removal notification failed', error); }
        }
      }
      // A partial deletion remains locked until journal recovery; never reopen
      // a transcript whose private files or metadata may already have been removed.
      if (!journaled || !(await listRequests(this.home)).some(r => r.sessionId === id)) for (const member of ids) this.locked.delete(member);
    }
  }
}

export const name = 'session-deletion-runtime';
export const inject = ['sessionDeletionGate', 'agents', 'sessions', 'sessionPersistence', 'sessionProjectionCache', 'sessionQuery', 'workspaceRegistry', 'attachments', 'fileUploads'];
export async function apply(ctx: RuntimeContext): Promise<void> {
  const require = await hostRequire();
  const cordis = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const provider = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-deepseek')).href);
  const runtime = new DeletionRuntime(ctx, object => ((object as Record<symbol, unknown> | undefined)?.[cordis.symbols.original] ?? object) as typeof object, provider.DeepSeekUploadIndex);
  await runtime.initialize(); ctx.provide('sessionDeletionRuntime', runtime);
}
