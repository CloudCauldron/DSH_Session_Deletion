/** Version-pinned online adapter. Public lifecycle handles own teardown; a small
 * set of guarded internal cache hooks closes rc.5's missing deletion seam. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { digest, enqueue, familyOf, listRequests, readJSON, stateDir, sweep, planSessionDeletion, collectGarbage,
  type LiveSnapshot, type Receipt, type SessionHeader, type SessionMap, type GcResult } from './core.js';
import { tryLock, otherHosts, waitingHosts } from './guard.js';
import type { Gate } from './gate.js';
import type { FileHandle } from 'node:fs/promises';
import { realpath } from 'node:fs/promises';

// These dynamic boundaries are intentionally confined to this rc.5 adapter.
type Dynamic = Record<string, any>;
type Method = (this: any, ...args: any[]) => any;
interface Agent extends Dynamic { id: string; session: { id: string; header: SessionHeader }; status: string; whenIdle(): Promise<void> }
interface Handle { agent: Agent; dispose(): Promise<void> }
export interface Activity { busy: boolean; reasons: string[] }
export class DeletionRefused extends Error { readonly status = 409; }

/** Briefly serialize input/attachment publication while collecting references.
 * Reentrant service calls keep their lease, avoiding nested-call deadlocks. */
export class PublicationBarrier {
  private context = new AsyncLocalStorage<{ open: boolean }>();
  private active = 0;
  private blocked = false;
  private waiters: (() => void)[] = [];
  assertSynchronousPublication(): void {
    if (this.blocked && !this.context.getStore()?.open) throw new DeletionRefused('正在清理会话，请稍后重试输入或后台操作。');
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
    if (this.blocked) throw new DeletionRefused('另一项清理正在进行，请稍后重试。');
    this.blocked = true;
    try {
      const deadline = Date.now() + timeoutMs;
      while (this.active) {
        if (Date.now() > deadline) throw new DeletionRefused('仍有消息提交或附件操作未结束，请稍后重试。');
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
  private controller?: Dynamic;
  private schedule?: Dynamic;
  private terminals?: Dynamic;
  private unarchiveForCleanup!: (id: string) => Promise<void>;
  private maintenance?: 'delete' | 'gc';
  get gcRunning(): boolean { return this.maintenance === 'gc'; }
  get deletionRunning(): boolean { return this.maintenance === 'delete'; }
  constructor(readonly ctx: Dynamic, private unwrap: (value: any) => any, private UploadIndex: new(path: string) => Dynamic) {}
  get home(): string { return (this.ctx.sessionDeletionGate as Gate).home; }
  get receiptSummary() { return { revision: this.receiptRevision, count: this.deleted.size }; }
  get receipt() { return { revision: this.receiptRevision, deletedIdHashes: [...this.deleted] }; }
  isLocked(id: string): boolean { return this.locked.has(id) || this.deleted.has(digest(id)); }
  private assertAllowed(ids: string[]): void {
    if (ids.some(id => this.isLocked(id))) throw new DeletionRefused('此会话正在删除或已经删除，不能再接收输入。');
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
  private patch(object: Dynamic, key: string, wrap: (original: Method) => Method, required = true, restorers = this.restorers): void {
    object = this.unwrap(object);
    const names = this.wrapped.get(object) || new Set<string>();
    if (names.has(key)) return;
    const original = object[key];
    if (typeof original !== 'function') {
      if (required) throw new Error(`Unsupported rc.5 capability: ${key}`);
      return;
    }
    const own = Object.getOwnPropertyDescriptor(object, key);
    const replacement = wrap(original);
    object[key] = replacement; names.add(key); this.wrapped.set(object, names);
    restorers.push(() => {
      if (object[key] !== replacement) return;
      if (own) Object.defineProperty(object, key, own); else delete object[key];
    });
  }
  private trackAgent(agent: Agent): void {
    const runtime = this;
    const restorers = this.agentRestorers.get(agent) || [];
    this.agentRestorers.set(agent, restorers);
    for (const name of ['send', 'followup', 'steer', 'inject', 'runMaintenance']) {
      this.patch(agent, name, original => function (...args) {
        runtime.assertAllowed([this.id]);
        runtime.barrier.assertSynchronousPublication();
        return Reflect.apply(original, this, args);
      }, false, restorers);
    }
  }
  private captureFactory(factory: Dynamic): void {
    const runtime = this;
    for (const name of ['createAgent', 'resume']) this.patch(factory, name, original => function (owner, options) {
      const ids = [options.sessionId, options.resumeSessionId, options.parentAgent?.id, options.meta?.parentSession].filter((x): x is string => typeof x === 'string');
      return runtime.operation(ids, async () => {
        const handle: Handle = await Reflect.apply(original, this, [owner, options]);
        runtime.handles.set(handle.agent.id, handle);
        runtime.trackAgent(handle.agent);
        if (ids.some(id => runtime.isLocked(id))) {
          await handle.dispose();
          throw new DeletionRefused('会话已进入删除流程，不能重新打开。');
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
      return runtime.operation([id], () => Reflect.apply(original, this, [id, ...args]));
    });
    const registry = this.unwrap(this.ctx.agents);
    if (typeof registry.requireFactory !== 'function') throw new Error('Unsupported AgentRegistry lifecycle');
    this.patch(registry, 'setFactory', original => function (...args) {
      const disposer = Reflect.apply(original, this, args);
      runtime.captureFactory(this.requireFactory().target);
      return disposer;
    });
    if (registry.factory?.target) this.captureFactory(registry.factory.target);
    const cache = this.unwrap(this.ctx.sessionProjectionCache);
    if (!cache.table || typeof cache.table.delete !== 'function') throw new Error('Projection cache deletion capability is missing');
    this.patch(cache, 'put', original => function (id, ...args) {
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
    this.patch(uploads, 'commit', original => function (agent, ...args) {
      return runtime.operation([agent.id], () => Reflect.apply(original, this, [agent, ...args]));
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
    this.ctx.inject(['sessionController'], (ctx: Dynamic) => {
      runtime.controller = ctx.sessionController;
      for (const name of ['prompt', 'attachment', 'updateQueue', 'fork', 'rename', 'selectModel', 'create']) {
        runtime.patch(ctx.sessionController, name, original => function (request, ...args) {
          const ids = [request?.sessionId, request?.parentSession].filter((x): x is string => typeof x === 'string');
          return runtime.operation(ids, () => Reflect.apply(original, this, [request, ...args]));
        });
      }
      for (const name of ['resolveAgent', 'inspect', 'page', 'projections']) {
        runtime.patch(ctx.sessionController, name, original => function (request, ...args) {
          const id = typeof request === 'string' ? request : request?.sessionId;
          return runtime.operation(id ? [id] : [], async () => {
            const result = await Reflect.apply(original, this, [request, ...args]);
            if (id) runtime.assertAllowed([id]);
            return result;
          });
        });
      }
      runtime.patch(ctx.sessionController, 'list', original => async function (...args) {
        const result = await Reflect.apply(original, this, args);
        if (!Array.isArray(result?.items)) throw new Error('Unsupported session list response');
        return { ...result, items: result.items.filter((row: Dynamic) => !runtime.deleted.has(digest(row.sessionId))) };
      });
    });
    this.ctx.inject(['schedule'], (ctx: Dynamic) => {
      runtime.schedule = ctx.schedule;
      runtime.patch(ctx.schedule, 'create', original => function (id, ...args) { return runtime.operation([id], () => Reflect.apply(original, this, [id, ...args])); });
      runtime.patch(ctx.schedule, 'update', original => function (request, ...args) { return runtime.operation([request.sessionId], () => Reflect.apply(original, this, [request, ...args])); });
    });
    this.ctx.inject(['terminals'], (ctx: Dynamic) => {
      runtime.terminals = ctx.terminals;
      for (const name of ['spawn', 'send', 'signal']) runtime.patch(ctx.terminals, name, original => function (owner, ...args) {
        runtime.assertAllowed([owner.id]); runtime.barrier.assertSynchronousPublication(); return Reflect.apply(original, this, [owner, ...args]);
      }, false);
    });
    this.ctx.effect(() => () => {
      for (const restorers of runtime.agentRestorers.values()) for (const restore of restorers.reverse()) restore();
      runtime.agentRestorers.clear();
      for (const restore of runtime.restorers.reverse()) restore();
    }, 'session-deletion runtime adapters');
  }
  async headers(): Promise<Map<string, SessionHeader>> {
    const map = new Map<string, SessionHeader>((await this.ctx.sessionPersistence.list()).map((s: Dynamic) => [s.header.id, s.header]));
    for (const session of this.ctx.sessions.list()) map.set(session.id, session.header);
    return map;
  }
  family(headers: Map<string, SessionHeader>, id: string): string[] {
    const sessions = new Map([...headers].map(([key, header]) => [key, { header }])) as SessionMap;
    return [...familyOf(sessions, id)].sort();
  }
  /** One final check after native archival, never a continuous activity monitor. */
  private async quiescence(ids: string[], global = false): Promise<Activity> {
    const reasons: string[] = [];
    if (!this.controller || !this.schedule) reasons.push('会话服务仍在初始化');
    const targets = new Set(ids);
    const all = new Set(global ? this.ctx.sessions.list().map((session: Dynamic) => session.id) as string[] : ids);
    for (const id of all) {
      if (targets.has(id)) {
        const stored = await this.ctx.sessionPersistence.stat(id);
        if (!stored || !(stored.sizeBytes > 0)) reasons.push('尚未保存的空白会话没有可删除的日志；空白子代理请在重启后再清理');
      }
      if (this.operations.get(id)) reasons.push('仍有消息提交或会话操作未结束');
      const agent = this.ctx.agents.get(id) as Agent | undefined;
      if (agent) {
        if (agent.status !== 'idle') reasons.push(global ? '仍有 AI 在工作或等待交互，请全部空闲后再清理附件' : '目标会话或子代理仍在工作或等待交互');
        if (agent.inbox?.nextTurn?.length || agent.inbox?.nextStep?.length) reasons.push('仍有排队输入');
        if (targets.has(id) && !this.handles.has(id)) reasons.push('缺少完整生命周期句柄，请重启 DSH');
        const idle = await Promise.race([agent.whenIdle().then(() => true), delay(0).then(() => false)]);
        if (!idle) reasons.push('会话后台维护尚未结束');
        if (this.terminals?.list(agent).some((terminal: Dynamic) => terminal.status?.kind === 'running')) reasons.push('交互终端仍打开，请先关闭');
      } else if (this.ctx.sessions.get(id)) reasons.push('存在无法安全释放的驻留会话');
      try {
        const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]));
        for (const item of activity) {
          // Future reminders in another conversation are not work in flight.
          if (global && item.kind === 'schedule') continue;
          reasons.push(`官方归档状态仍有活动：${item.kind || '后台任务'}`);
        }
      } catch { reasons.push('无法确认全部后台活动已结束'); }
    }
    return { busy: reasons.length > 0, reasons: [...new Set(reasons)] };
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
          ...[...(staged?.values() || [])].map((upload: Dynamic) => upload.file),
        ] });
      }
      finally { observation[Symbol.dispose](); }
    }
    return map;
  }
  async remove(id: string, createdAt: number, expectedIds: readonly string[]): Promise<{ deleted: number }> {
    if (this.maintenance) throw new DeletionRefused('另一项清理正在进行，请稍后重试。');
    this.maintenance = 'delete';
    try { return await this.removeOne(id, createdAt, expectedIds); }
    finally { this.maintenance = undefined; }
  }
  async gc(): Promise<GcResult> {
    if (this.maintenance) throw new DeletionRefused('另一项清理正在进行，请稍后重试。');
    if (!(this.ctx.sessionDeletionGate as Gate).healthy()) throw new DeletionRefused('恢复监测不可用，请重启 DSH。');
    this.maintenance = 'gc';
    try {
      return await this.barrier.exclusive(async () => {
        const excluded = await waitingHosts(stateDir(this.home)); excluded.add(process.pid);
        if ((await otherHosts(this.home, excluded)).length) throw new DeletionRefused('另一个 DSH 进程正在使用相同目录，请先关闭它。');
        if ((await listRequests(this.home)).length) throw new DeletionRefused('有未完成的会话删除，请先重启 DSH 恢复。');
        const activity = await this.quiescence([], true);
        if (activity.busy) throw new DeletionRefused(activity.reasons.join('；'));
        // A canceled image caller can finish before its shared compression work.
        if (this.unwrap(this.ctx.attachments).requestInflight.size) throw new DeletionRefused('图片缓存仍在生成，请稍后重试。');
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
    const groups = new Map<string, Dynamic[]>();
    for (const record of current.records) if (hashes.has(String(record.attachmentId).replace(/^sha256:/, ''))) {
      const rows = groups.get(record.scope) || []; rows.push(record); groups.set(record.scope, rows);
    }
    for (const [scope, rows] of groups) await index.remove(scope, rows.map(r => ({ variantId: r.variantId, fileId: r.fileId })));
  }
  private async removeOne(id: string, createdAt: number, expectedIds: readonly string[]): Promise<{ deleted: number }> {
    if (!(this.ctx.sessionDeletionGate as Gate).healthy()) throw new DeletionRefused('恢复监测不可用，请重启 DSH。');
    if ((await listRequests(this.home)).length) throw new DeletionRefused('有未完成的清理，请先重启 DSH 恢复。');
    const headers = await this.headers(); const root = headers.get(id);
    if (!root || root.createdAt !== createdAt) throw new DeletionRefused('会话已变化，请重新确认。');
    const ids = this.family(headers, id);
    if (JSON.stringify(ids) !== JSON.stringify(expectedIds)) throw new DeletionRefused('子代理集合已变化，请重新确认。');
    // Reuse DSH's own admission and durable archive write. Do not reimplement
    // its running-turn/job/subagent/schedule monitor or force-stop active work.
    try { await this.ctx.workspaceRegistry.archiveSession(id); }
    catch (e) { throw new DeletionRefused('官方归档未完成，未执行删除。' + (e instanceof Error ? e.message : '')); }
    if (!this.ctx.workspaceRegistry.archivedSessionIds.includes(id)) throw new DeletionRefused('未能确认归档完成，未执行删除。');
    this.assertAllowed(ids);
    // No await between publishing these locks: other tabs and background input
    // are rejected before the asynchronous authoritative activity checks begin.
    for (const member of ids) this.locked.add(member);
    let journaled = false; let committed = false;
    const writerLocks: FileHandle[] = [];
    try {
      const excluded = await waitingHosts(stateDir(this.home)); excluded.add(process.pid);
      if ((await otherHosts(this.home, excluded)).length) throw new DeletionRefused('另一个 DSH 进程正在使用相同目录，请先关闭它。');
      const again = await this.quiescence(ids);
      if (again.busy) throw new DeletionRefused(again.reasons.join('；'));
      if (JSON.stringify(this.family(await this.headers(), id)) !== JSON.stringify(ids)) throw new DeletionRefused('子代理集合已变化，请重新确认。');
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
          if (path === 'storages/workspace.json') {
            for (const workspace of this.ctx.workspaceRegistry.list()) for (const member of targets) {
              if (workspace.sessionIds.includes(member)) await workspace.detachSession(member);
            }
            const registry = this.unwrap(this.ctx.workspaceRegistry);
            for (const member of targets) {
              await registry.unpinSession(member); await this.unarchiveForCleanup(member);
              for (const key of ['headers', 'sessionPaths', 'missingSessionPaths', 'invalidSessionPaths']) registry[key]?.delete(member);
            }
          } else if (path === 'storages/schedule.json') {
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
export async function apply(ctx: Dynamic): Promise<void> {
  const require = createRequire(await realpath(process.argv[1]));
  const cordis = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const provider = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-deepseek')).href);
  const runtime = new DeletionRuntime(ctx, object => object?.[cordis.symbols.original] ?? object, provider.DeepSeekUploadIndex);
  await runtime.initialize(); ctx.provide('sessionDeletionRuntime', runtime);
}
