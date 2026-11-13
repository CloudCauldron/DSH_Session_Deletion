/** Version-pinned online adapter. Public lifecycle handles own teardown; a small
 * set of guarded internal cache hooks closes the missing deletion seam. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL } from 'node:url';
import { join, relative } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { digest, enqueue, familyOf, listRequests, readJSON, stateDir, sweep, planSessionDeletion, collectGarbage, garbageSize } from './core.js';
import { tryLock, waitingHosts, otherHosts } from './guard.js';
import { hostRequire } from './gate.js';
import { LocalizedError, message } from './locale.js';
export class DeletionRefused extends LocalizedError {
    status = 409;
}
/** Briefly serialize input/attachment publication while collecting references.
 * Reentrant service calls keep their lease, avoiding nested-call deadlocks. */
export class PublicationBarrier {
    context = new AsyncLocalStorage();
    active = 0;
    blocked = false;
    waiters = [];
    assertSynchronousPublication() {
        if (this.blocked && !this.context.getStore()?.open)
            throw new DeletionRefused('error.publicationBlocked');
    }
    async read(work) {
        // Detached tasks inherit ALS, but must not inherit an already returned
        // caller's permission. Count nested work too, even when it is not awaited.
        if (!this.context.getStore()?.open) {
            while (this.blocked)
                await new Promise(resolve => this.waiters.push(resolve));
        }
        const lease = { open: true };
        this.active++;
        try {
            return await this.context.run(lease, work);
        }
        finally {
            lease.open = false;
            this.active--;
        }
    }
    async exclusive(work, timeoutMs = 15000) {
        if (this.blocked)
            throw new DeletionRefused('error.cleanupBusy');
        this.blocked = true;
        try {
            const deadline = Date.now() + timeoutMs;
            while (this.active) {
                if (Date.now() > deadline)
                    throw new DeletionRefused('error.publicationTimeout');
                await delay(10);
            }
            return await work();
        }
        finally {
            this.blocked = false;
            for (const resume of this.waiters.splice(0))
                resume();
        }
    }
}
export class DeletionRuntime {
    ctx;
    unwrap;
    UploadIndex;
    locked = new Set();
    barrier = new PublicationBarrier();
    handles = new Map();
    operations = new Map();
    deleted = new Set();
    receiptRevision = '';
    cacheWrites = new Map();
    restorers = [];
    agentRestorers = new Map();
    wrapped = new WeakMap();
    controller;
    schedule;
    terminals;
    unarchiveForCleanup;
    maintenance;
    get gcRunning() { return this.maintenance === 'gc'; }
    get deletionRunning() { return this.maintenance === 'delete'; }
    constructor(ctx, unwrap, UploadIndex) {
        this.ctx = ctx;
        this.unwrap = unwrap;
        this.UploadIndex = UploadIndex;
    }
    get home() { return this.ctx.sessionDeletionGate.home; }
    get receiptSummary() { return { revision: this.receiptRevision, count: this.deleted.size }; }
    get receipt() { return { revision: this.receiptRevision, deletedIdHashes: [...this.deleted] }; }
    isLocked(id) { return this.locked.has(id) || this.deleted.has(digest(id)); }
    assertAllowed(ids) {
        if (ids.some(id => this.isLocked(id)))
            throw new DeletionRefused('error.sessionLocked');
    }
    operation(ids, work) {
        this.assertAllowed(ids);
        return this.barrier.read(async () => {
            this.assertAllowed(ids);
            // Queued submissions have not published anything and must not make the
            // GC's idle check fail merely because they arrived behind its barrier.
            for (const id of ids)
                this.operations.set(id, (this.operations.get(id) || 0) + 1);
            try {
                return await work();
            }
            finally {
                for (const id of ids) {
                    const count = (this.operations.get(id) || 1) - 1;
                    if (count)
                        this.operations.set(id, count);
                    else
                        this.operations.delete(id);
                }
            }
        });
    }
    patch(object, key, wrap, required = true, restorers = this.restorers) {
        const target = this.unwrap(object);
        const names = this.wrapped.get(target) || new Set();
        if (names.has(key))
            return;
        const original = target[key];
        if (typeof original !== 'function') {
            if (required)
                throw new Error(`Unsupported DSH capability: ${key}`);
            return;
        }
        const own = Object.getOwnPropertyDescriptor(target, key);
        const replacement = wrap(original);
        target[key] = replacement;
        names.add(key);
        this.wrapped.set(target, names);
        restorers.push(() => {
            if (target[key] !== replacement)
                return;
            if (own)
                Object.defineProperty(target, key, own);
            else
                delete target[key];
        });
    }
    trackAgent(agent) {
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
    captureFactory(factory) {
        const runtime = this;
        for (const name of ['createAgent', 'resume'])
            this.patch(factory, name, original => function (owner, options) {
                const input = options;
                const ids = [input.sessionId, input.resumeSessionId, input.parentAgent?.id, input.meta?.parentSession].filter((x) => typeof x === 'string');
                return runtime.operation(ids, async () => {
                    const handle = await Reflect.apply(original, this, [owner, options]);
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
    installReceipt(receipt) {
        this.deleted = new Set(receipt.deletedIdHashes);
        this.receiptRevision = receipt.revision;
    }
    async loadReceipt() {
        this.installReceipt(await readJSON(join(stateDir(this.home), 'receipt.json'), { schema: 1, revision: '', deletedIdHashes: [] }));
    }
    async initialize() {
        await this.loadReceipt();
        const runtime = this;
        if (this.ctx.attachments.root !== join(this.home, 'attachments', 'v1')
            || this.ctx.attachments.cacheRoot !== join(this.home, 'cache', 'attachments'))
            throw new Error('Unsupported attachment storage');
        const workspaces = this.unwrap(this.ctx.workspaceRegistry);
        const unarchive = workspaces.unarchiveSession;
        this.unarchiveForCleanup = id => Reflect.apply(unarchive, workspaces, [id]);
        for (const name of ['pinSession', 'unarchiveSession', 'archiveSession'])
            this.patch(workspaces, name, original => function (id, ...args) {
                return runtime.operation([id], () => Reflect.apply(original, this, [id, ...args]));
            });
        const registry = this.unwrap(this.ctx.agents);
        if (typeof registry.requireFactory !== 'function')
            throw new Error('Unsupported AgentRegistry lifecycle');
        this.patch(registry, 'setFactory', original => function (...args) {
            const disposer = Reflect.apply(original, this, args);
            runtime.captureFactory(this.requireFactory().target);
            return disposer;
        });
        if (registry.factory?.target)
            this.captureFactory(registry.factory.target);
        const cache = this.unwrap(this.ctx.sessionProjectionCache);
        if (!cache.table || typeof cache.table.delete !== 'function')
            throw new Error('Projection cache deletion capability is missing');
        this.patch(cache, 'put', original => function (key, ...args) {
            const id = key;
            if (runtime.isLocked(id))
                return Promise.resolve();
            const promise = Promise.resolve(Reflect.apply(original, this, [id, ...args]));
            const writes = runtime.cacheWrites.get(id) || new Set();
            writes.add(promise);
            runtime.cacheWrites.set(id, writes);
            return promise.finally(() => { writes.delete(promise); if (!writes.size)
                runtime.cacheWrites.delete(id); });
        });
        for (const method of ['saveImage', 'saveImages', 'saveFile', 'saveFileStream', 'readImageRequest']) {
            this.patch(this.ctx.attachments, method, original => function (...args) {
                return runtime.barrier.read(() => Reflect.apply(original, this, args));
            });
        }
        const uploads = this.unwrap(this.ctx.fileUploads);
        if (!(uploads.stagedFiles instanceof WeakMap))
            throw new Error('Unsupported staged file ownership');
        for (const method of ['upload', 'uploadStream', 'uploadImageStream'])
            this.patch(uploads, method, original => async function (owner, ...args) {
                const input = owner;
                return runtime.operation([(input.id ?? input.sessionId)], () => Reflect.apply(original, this, [owner, ...args]));
            });
        this.patch(uploads, 'bindPrompt', original => function (agent, ...args) {
            runtime.assertAllowed([agent.id]);
            runtime.barrier.assertSynchronousPublication();
            return Reflect.apply(original, this, [agent, ...args]);
        });
        this.ctx.on('agent/created', ({ agent }) => {
            // The creation callback may reject publication; the factory rolls it back.
            runtime.assertAllowed([agent.id, agent.session.header.parentSession].filter((x) => !!x));
            runtime.trackAgent(agent);
        });
        this.ctx.on('agent/disposed', ({ agent }) => {
            runtime.handles.delete(agent.id);
            // Do not retain a deleted transcript through adapter restoration closures.
            runtime.agentRestorers.delete(agent);
        });
        this.ctx.on('agent/pre-step', async ({ agent }, next) => runtime.barrier.read(() => runtime.isLocked(agent.id) ? { kind: 'reject' } : next()));
        this.ctx.inject(['sessionController'], (ctx) => {
            runtime.controller = ctx.sessionController;
            for (const name of ['prompt', 'attachment', 'updateQueue', 'fork', 'rename', 'selectModel', 'create']) {
                runtime.patch(ctx.sessionController, name, original => function (request, ...args) {
                    const input = request;
                    const ids = [input?.sessionId, input?.parentSession].filter((x) => typeof x === 'string');
                    return runtime.operation(ids, () => Reflect.apply(original, this, [request, ...args]));
                });
            }
            for (const name of ['resolveAgent', 'inspect', 'page', 'projections']) {
                runtime.patch(ctx.sessionController, name, original => function (request, ...args) {
                    const id = typeof request === 'string' ? request : request?.sessionId;
                    return runtime.operation(id ? [id] : [], async () => {
                        const result = await Reflect.apply(original, this, [request, ...args]);
                        if (id)
                            runtime.assertAllowed([id]);
                        return result;
                    });
                });
            }
            runtime.patch(ctx.sessionController, 'list', original => async function (...args) {
                const result = await Reflect.apply(original, this, args);
                if (!Array.isArray(result?.items))
                    throw new Error('Unsupported session list response');
                return { ...result, items: result.items.filter((row) => !runtime.deleted.has(digest(row.sessionId))) };
            });
        });
        this.ctx.inject(['schedule'], (ctx) => {
            runtime.schedule = ctx.schedule;
            runtime.patch(ctx.schedule, 'create', original => function (id, ...args) { return runtime.operation([id], () => Reflect.apply(original, this, [id, ...args])); });
            runtime.patch(ctx.schedule, 'update', original => function (request, ...args) { return runtime.operation([request.sessionId], () => Reflect.apply(original, this, [request, ...args])); });
        });
        this.ctx.inject(['terminals'], (ctx) => {
            runtime.terminals = ctx.terminals;
            for (const name of ['spawn', 'send', 'signal'])
                runtime.patch(ctx.terminals, name, original => function (owner, ...args) {
                    runtime.assertAllowed([owner.id]);
                    runtime.barrier.assertSynchronousPublication();
                    return Reflect.apply(original, this, [owner, ...args]);
                }, false);
        });
        this.ctx.effect(() => () => {
            for (const restorers of runtime.agentRestorers.values())
                for (const restore of restorers.reverse())
                    restore();
            runtime.agentRestorers.clear();
            for (const restore of runtime.restorers.reverse())
                restore();
        }, 'session-deletion runtime adapters');
    }
    async headers() {
        const map = new Map((await this.ctx.sessionPersistence.list()).map((s) => [s.header.id, s.header]));
        for (const session of this.ctx.sessions.list())
            map.set(session.id, session.header);
        return map;
    }
    family(headers, id) {
        const sessions = new Map([...headers].map(([key, header]) => [key, { header }]));
        return [...familyOf(sessions, id)].sort();
    }
    /** One final check after native archival, never a continuous activity monitor. */
    async quiescence(ids, global = false) {
        const reasons = [];
        if (!this.controller || !this.schedule)
            reasons.push(message('activity.initializing'));
        const targets = new Set(ids);
        const all = new Set(global ? this.ctx.sessions.list().map((session) => session.id) : ids);
        for (const id of all) {
            if (targets.has(id)) {
                const stored = await this.ctx.sessionPersistence.stat(id);
                if (!stored || !(stored.sizeBytes > 0))
                    reasons.push(message('activity.unsaved'));
            }
            if (this.operations.get(id))
                reasons.push(message('activity.operations'));
            const agent = this.ctx.agents.get(id);
            if (agent) {
                if (agent.status !== 'idle')
                    reasons.push(message(global ? 'activity.globalAgentBusy' : 'activity.targetAgentBusy'));
                if (agent.inbox?.nextTurn?.length || agent.inbox?.nextStep?.length)
                    reasons.push(message('activity.queuedInput'));
                if (targets.has(id) && !this.handles.has(id))
                    reasons.push(message('activity.missingHandle'));
                const idle = await Promise.race([agent.whenIdle().then(() => true), delay(0).then(() => false)]);
                if (!idle)
                    reasons.push(message('activity.maintenance'));
                if (this.terminals?.list(agent).some((terminal) => terminal.status?.kind === 'running'))
                    reasons.push(message('activity.terminal'));
            }
            else if (this.ctx.sessions.get(id))
                reasons.push(message('activity.residentSession'));
            try {
                const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]));
                for (const item of activity) {
                    // Future reminders in another conversation are not work in flight.
                    if (global && item.kind === 'schedule')
                        continue;
                    reasons.push(item.kind ? message('activity.nativeBusy', { kind: item.kind }) : message('activity.nativeBusyUnknown'));
                }
            }
            catch {
                reasons.push(message('activity.unconfirmed'));
            }
        }
        return { busy: reasons.length > 0, reasons: [...new Map(reasons.map(reason => [JSON.stringify(reason), reason])).values()] };
    }
    get archivedIds() { return [...this.ctx.workspaceRegistry.archivedSessionIds]; }
    async snapshots() {
        const map = new Map();
        for (const session of this.ctx.sessions.list()) {
            const observation = await this.ctx.sessionQuery.observeSession(session.id, { projectionMode: 'none' });
            try {
                const staged = this.unwrap(this.ctx.fileUploads).stagedFiles.get(session);
                map.set(session.id, { header: observation.header, events: [
                        ...observation.events,
                        ...[...(staged?.values() || [])].map((upload) => upload.attachment),
                    ] });
            }
            finally {
                observation[Symbol.dispose]();
            }
        }
        return map;
    }
    async remove(id, createdAt, expectedIds) {
        if (this.maintenance)
            throw new DeletionRefused('error.cleanupBusy');
        this.maintenance = 'delete';
        try {
            return await this.removeOne(id, createdAt, expectedIds);
        }
        finally {
            this.maintenance = undefined;
        }
    }
    async garbageSize() {
        if (this.maintenance)
            throw new DeletionRefused('error.cleanupBusy');
        let changed = false;
        const subscriptions = ['session/created', 'session/disposed', 'session/event'].map(name => this.ctx.on(name, () => { changed = true; }));
        // Session events cover log/lifecycle changes; staged uploads can change without an event.
        const current = () => JSON.stringify([this.receiptRevision, this.ctx.sessions.list().map((session) => [
                session.id, [...(this.unwrap(this.ctx.fileUploads).stagedFiles.get(session)?.values() || [])].map((upload) => upload.attachment),
            ])]);
        try {
            const before = current();
            const bytes = await garbageSize(this.home, () => this.snapshots());
            if (changed || this.maintenance || before !== current())
                throw new DeletionRefused('error.sizeChanged');
            return bytes;
        }
        finally {
            for (const dispose of subscriptions)
                dispose();
        }
    }
    async gc() {
        if (this.maintenance)
            throw new DeletionRefused('error.cleanupBusy');
        if (!this.ctx.sessionDeletionGate.healthy())
            throw new DeletionRefused('error.guardUnavailable');
        this.maintenance = 'gc';
        try {
            return await this.barrier.exclusive(async () => {
                const excluded = await waitingHosts(stateDir(this.home));
                excluded.add(process.pid);
                if ((await otherHosts(this.home, excluded)).length)
                    throw new DeletionRefused('error.otherHost');
                if ((await listRequests(this.home)).length)
                    throw new DeletionRefused('error.pendingDeletion');
                const activity = await this.quiescence([], true);
                if (activity.busy)
                    throw new DeletionRefused(activity.reasons);
                // A canceled image caller can finish before its shared compression work.
                if (this.unwrap(this.ctx.attachments).requestInflight.size)
                    throw new DeletionRefused('error.imageCacheBusy');
                await this.ctx.sessionPersistence.flush();
                await Promise.all([...this.cacheWrites.values()].flatMap(writes => [...writes]));
                return collectGarbage(this.home, { hooks: {
                        snapshots: () => this.snapshots(), removeUploadMappings: hashes => this.removeUploadMappings(hashes),
                    } });
            });
        }
        finally {
            this.maintenance = undefined;
        }
    }
    async removeUploadMappings(hashes) {
        const path = join(this.home, 'llm-deepseek/files-v3.json');
        const index = new this.UploadIndex(path);
        const current = await index.load();
        const groups = new Map();
        for (const record of current.records)
            if (hashes.has(String(record.attachmentId).replace(/^sha256:/, ''))) {
                const rows = groups.get(record.scope) || [];
                rows.push(record);
                groups.set(record.scope, rows);
            }
        for (const [scope, rows] of groups)
            await index.remove(scope, rows.map(r => ({ variantId: r.variantId, fileId: r.fileId })));
    }
    async removeOne(id, createdAt, expectedIds) {
        if (!this.ctx.sessionDeletionGate.healthy())
            throw new DeletionRefused('error.guardUnavailable');
        if ((await listRequests(this.home)).length)
            throw new DeletionRefused('error.pendingCleanup');
        const headers = await this.headers();
        const root = headers.get(id);
        if (!root || root.createdAt !== createdAt)
            throw new DeletionRefused('error.sessionChanged');
        const ids = this.family(headers, id);
        if (JSON.stringify(ids) !== JSON.stringify(expectedIds))
            throw new DeletionRefused('error.familyChanged');
        // Reuse DSH's own admission and durable archive write. Do not reimplement
        // its running-turn/job/subagent/schedule monitor or force-stop active work.
        try {
            await this.ctx.workspaceRegistry.archiveSession(id);
        }
        catch (e) {
            throw new DeletionRefused('error.archiveIncomplete', { detail: e instanceof Error ? e.message : '' });
        }
        if (!this.ctx.workspaceRegistry.archivedSessionIds.includes(id))
            throw new DeletionRefused('error.archiveUnconfirmed');
        this.assertAllowed(ids);
        // No await between publishing these locks: other tabs and background input
        // are rejected before the asynchronous authoritative activity checks begin.
        for (const member of ids)
            this.locked.add(member);
        let journaled = false;
        let committed = false;
        const writerLocks = [];
        try {
            const excluded = await waitingHosts(stateDir(this.home));
            excluded.add(process.pid);
            if ((await otherHosts(this.home, excluded)).length)
                throw new DeletionRefused('error.otherHost');
            const again = await this.quiescence(ids);
            if (again.busy)
                throw new DeletionRefused(again.reasons);
            if (JSON.stringify(this.family(await this.headers(), id)) !== JSON.stringify(ids))
                throw new DeletionRefused('error.familyChanged');
            // Commit only private paths. No attachment reference snapshot is needed.
            const request = await enqueue(this.home, root, await planSessionDeletion(this.home, headers, id));
            journaled = true;
            for (const member of [...ids].reverse()) {
                const agent = this.ctx.agents.get(member);
                if (agent) {
                    const handle = this.handles.get(member);
                    if (!handle || handle.agent !== agent)
                        throw new Error('Lifecycle changed before disposal');
                    await handle.dispose();
                }
                if (this.ctx.sessions.get(member) || this.ctx.agents.get(member))
                    throw new Error('Session did not leave its live stores');
                const writes = this.cacheWrites.get(member);
                if (writes?.size)
                    await Promise.all(writes);
                await this.unwrap(this.ctx.sessionProjectionCache).table.delete(member);
            }
            for (const record of request.plan.directories) {
                const lock = await tryLock(join(this.home, record.path, 'session.lock'));
                if (!lock)
                    throw new Error('A session writer is still active');
                writerLocks.push(lock);
            }
            const result = await sweep(this.home, { hooks: {
                    onlySessionId: id,
                    receiptCommitted: receipt => { this.installReceipt(receipt); committed = true; },
                    applyEdit: async (edit, targets) => {
                        const path = relative(this.home, edit.path);
                        if (path === join('storages', 'workspace.json')) {
                            for (const workspace of this.ctx.workspaceRegistry.list())
                                for (const member of targets) {
                                    if (workspace.sessionIds.includes(member))
                                        await workspace.detachSession(member);
                                }
                            const registry = this.unwrap(this.ctx.workspaceRegistry);
                            for (const member of targets) {
                                await registry.unpinSession(member);
                                await this.unarchiveForCleanup(member);
                                for (const key of ['headers', 'sessionPaths', 'missingSessionPaths', 'invalidSessionPaths'])
                                    registry[key]?.delete(member);
                            }
                        }
                        else if (path === join('storages', 'schedule.json')) {
                            for (const task of await this.schedule.catalog())
                                if (targets.has(task.sessionId))
                                    await this.schedule.delete({ sessionId: task.sessionId, id: task.id });
                        }
                        else
                            throw new Error('Unsupported live storage edit: ' + path);
                    },
                } });
            return { deleted: result.reduce((n, value) => n + value.sessions, 0) };
        }
        finally {
            await Promise.all(writerLocks.map(lock => lock.close()));
            if (journaled) {
                // A request unlink/fsync or diagnostic write can fail after commit.
                // Install every tombstone before notifying fallible downstream listeners.
                // A rename may have succeeded even when its directory sync failed before the commit notification.
                if (!committed)
                    await this.loadReceipt();
                const completed = ids.filter(member => this.deleted.has(digest(member)));
                for (const member of completed) {
                    this.unwrap(this.ctx.sessionPersistence).coldLogMemo?.delete(member);
                    this.unwrap(this.ctx.sessionQuery)._observations?.cache?.delete(member);
                    try {
                        this.ctx.emit('api-session/removed', member);
                    }
                    catch (error) {
                        this.ctx.logger.warn('Session removal notification failed', error);
                    }
                }
            }
            // A partial deletion remains locked until journal recovery; never reopen
            // a transcript whose private files or metadata may already have been removed.
            if (!journaled || !(await listRequests(this.home)).some(r => r.sessionId === id))
                for (const member of ids)
                    this.locked.delete(member);
        }
    }
}
export const name = 'session-deletion-runtime';
export const inject = ['sessionDeletionGate', 'agents', 'sessions', 'sessionPersistence', 'sessionProjectionCache', 'sessionQuery', 'workspaceRegistry', 'attachments', 'fileUploads'];
export async function apply(ctx) {
    const require = await hostRequire();
    const cordis = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
    const provider = await import(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-deepseek')).href);
    const runtime = new DeletionRuntime(ctx, object => (object?.[cordis.symbols.original] ?? object), provider.DeepSeekUploadIndex);
    await runtime.initialize();
    ctx.provide('sessionDeletionRuntime', runtime);
}
