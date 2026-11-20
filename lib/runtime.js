var __rewriteRelativeImportExtension = (this && this.__rewriteRelativeImportExtension) || function (path, preserveJsx) {
    if (typeof path === "string" && /^\.\.?\//.test(path)) {
        return path.replace(/\.(tsx)$|((?:\.d)?)((?:\.[^./]+?)?)\.([cm]?)ts$/i, function (m, tsx, d, ext, cm) {
            return tsx ? preserveJsx ? ".jsx" : ".js" : d && (!ext || !cm) ? m : (d + ext + "." + cm.toLowerCase() + "js");
        });
    }
    return path;
};
/** Version-pinned online adapter. Public lifecycle handles own teardown; a small
 * set of guarded internal cache hooks closes the missing deletion seam. */
import { AsyncLocalStorage } from 'node:async_hooks';
import { pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { realpath } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { SUPPORTED_DSH, captureDeletionRequest, digest, enqueue, exists, familyOf, listRequests, readReceipt, readSchedule, requestPath, sweep, planSessionDeletion, collectGarbage, garbageSize, scheduledSession } from './core.js';
import { tryLock, sameHomeHosts } from './locks.js';
import { LocalizedError } from './locale/errors.js';
import { message } from './locale/shared.js';
export class DeletionRefused extends LocalizedError {
    status = 409;
}
/** Briefly serialize input/attachment publication while collecting references.
 * Reentrant service calls keep their lease, avoiding nested-call deadlocks. */
export class PublicationBarrier {
    context = new AsyncLocalStorage();
    active = 0;
    revision = 0;
    recordPublication() { this.revision++; }
    get idleRevision() { return this.active || this.blocked ? undefined : this.revision; }
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
        this.recordPublication();
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
        this.recordPublication();
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
    preexistingUploadOwners = new WeakSet();
    operations = new Map();
    deleted = new Set();
    importer;
    receiptRevision = '';
    cacheWrites = new Map();
    restorers = [];
    agentRestorers = new Map();
    wrapped = new WeakMap();
    schedule;
    terminals;
    subagentBinding;
    stopping;
    stopTimeoutMs = 30_000;
    editSchedule;
    unarchiveForCleanup;
    maintenance;
    disposed = false;
    get gcRunning() { return this.maintenance?.kind === 'gc'; }
    get deletionRunning() { return this.maintenance?.kind === 'delete'; }
    home;
    constructor(ctx, unwrap, UploadIndex) {
        this.ctx = ctx;
        this.unwrap = unwrap;
        this.UploadIndex = UploadIndex;
        this.home = ctx.dshHomePath();
    }
    get receiptSummary() { return { revision: this.receiptRevision, count: this.deleted.size }; }
    get receipt() { return { revision: this.receiptRevision, deletedIdHashes: [...this.deleted] }; }
    isLocked(id) { return this.locked.has(id) || this.deleted.has(digest(id)); }
    assertAllowed(ids) {
        if (ids.some(id => this.isLocked(id)))
            throw new DeletionRefused('error.sessionLocked');
    }
    operation(ids, work, startup = false) {
        ids = [...new Set(ids)];
        this.assertAllowed(ids);
        return this.barrier.read(async () => {
            this.assertAllowed(ids);
            // Queued submissions have not published anything and must not make the
            // GC's idle check fail merely because they arrived behind its barrier.
            let finish;
            const operation = { done: new Promise(resolve => { finish = resolve; }), startup };
            for (const id of ids) {
                const pending = this.operations.get(id) ?? new Set();
                pending.add(operation);
                this.operations.set(id, pending);
            }
            try {
                return await work();
            }
            finally {
                for (const id of ids) {
                    const pending = this.operations.get(id);
                    pending.delete(operation);
                    if (!pending.size)
                        this.operations.delete(id);
                }
                finish();
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
                throw new LocalizedError('error.unsupportedCapability', { capability: key });
            return;
        }
        const own = Object.getOwnPropertyDescriptor(target, key);
        let invoke = wrap(original);
        const replacement = function (...args) { return Reflect.apply(invoke, this, args); };
        target[key] = replacement;
        names.add(key);
        this.wrapped.set(target, names);
        restorers.push(() => {
            // A caller or another wrapper may still hold this function after withdrawal.
            invoke = original;
            names.delete(key);
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
                    if (runtime.ctx.fiber.uid === null)
                        return handle;
                    runtime.handles.set(handle.agent.id, handle);
                    runtime.trackAgent(handle.agent);
                    if (ids.some(id => runtime.isLocked(id))) {
                        await handle.dispose();
                        throw new DeletionRefused('error.sessionReopen');
                    }
                    return handle;
                }, true);
            });
    }
    installReceipt(receipt) {
        this.deleted = new Set(receipt.deletedIdHashes);
        this.receiptRevision = receipt.revision;
    }
    async loadReceipt() {
        this.installReceipt(await readReceipt(this.home));
    }
    closeAdmission() {
        this.disposed = true;
        return this.maintenance?.settled;
    }
    async initialize() {
        const persistence = this.ctx.sessionPersistence;
        if (persistence.name !== 'session-persistence-jsonl' || resolve(persistence.root) !== join(this.home, 'sessions')) {
            throw new LocalizedError('error.defaultSessionRoot');
        }
        await this.loadReceipt();
        const runtime = this;
        if (this.ctx.attachments.root !== join(this.home, 'attachments', 'v1')
            || this.ctx.attachments.cacheRoot !== join(this.home, 'cache', 'attachments'))
            throw new LocalizedError('error.attachmentStorage');
        this.ctx.effect(() => () => {
            for (const restorers of runtime.agentRestorers.values())
                for (const restore of restorers.reverse())
                    restore();
            runtime.agentRestorers.clear();
            for (const restore of runtime.restorers.reverse())
                restore();
        }, 'session-deletion runtime adapters');
        const workspaces = this.unwrap(this.ctx.workspaceRegistry);
        const unarchive = workspaces.unarchiveSession;
        this.unarchiveForCleanup = id => Reflect.apply(unarchive, workspaces, [id]);
        for (const name of ['pinSession', 'unarchiveSession', 'archiveSession'])
            this.patch(workspaces, name, original => function (id, ...args) {
                return runtime.operation([id], () => Reflect.apply(original, this, [id, ...args]));
            });
        const registry = this.unwrap(this.ctx.agents);
        if (typeof registry.requireFactory !== 'function')
            throw new LocalizedError('error.registryLifecycle');
        this.patch(registry, 'setFactory', original => function (...args) {
            const disposer = Reflect.apply(original, this, args);
            runtime.captureFactory(this.requireFactory().target);
            return disposer;
        });
        if (registry.factory?.target)
            this.captureFactory(registry.factory.target);
        for (const agent of registry.list()) {
            // A native upload started before this mount may still stage bytes for this exact owner.
            if (agent.session.header.origin !== 'subagent')
                this.preexistingUploadOwners.add(agent);
            this.trackAgent(agent);
        }
        const manager = this.manager();
        this.patch(manager, 'assertAdmitting', original => function (agent) {
            const member = agent;
            runtime.assertAllowed([member.id, manager.rootOf(member).id]);
            return Reflect.apply(original, this, [agent]);
        });
        this.subagentBinding = { manager, fields: {
                resident: manager.resident, materializations: manager.materializations,
                dispose: manager.dispose, assertAdmitting: manager.assertAdmitting, rootOf: manager.rootOf,
            } };
        this.patch(this.ctx.jobs, 'start', original => function (spec) {
            const owner = spec.owner;
            runtime.assertAllowed(owner ? [owner] : []);
            runtime.barrier.assertSynchronousPublication();
            return Reflect.apply(original, this, [spec]);
        });
        const cache = this.unwrap(this.ctx.sessionProjectionCache);
        if (!cache.table || typeof cache.table.delete !== 'function')
            throw new LocalizedError('error.projectionCacheDelete');
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
        // The importer stores images before it creates any Session. Its claim spans
        // both passes, including cancellation and the final workspace attachment.
        const importerPatch = [];
        const restoreImporter = () => importerPatch.pop()?.();
        this.restorers.push(restoreImporter);
        this.ctx.inject(['deepseekChatImport'], ctx => {
            // Cordis withdraws dependencies before the provider drains its active import.
            // Keep the outgoing claim guarded through withdrawal and release it on replacement.
            const outgoing = this.importer?.active;
            if (outgoing)
                void this.barrier.read(() => outgoing.settled);
            restoreImporter();
            const importer = this.importer = this.unwrap(ctx.deepseekChatImport);
            if (importer.active)
                this.barrier.recordPublication();
            this.patch(importer, 'claim', original => function () {
                if (runtime.gcRunning)
                    return undefined; // Native import-busy response.
                const claim = Reflect.apply(original, this, []);
                if (claim)
                    runtime.barrier.recordPublication();
                return claim;
            }, true, importerPatch);
        });
        const uploads = this.unwrap(this.ctx.fileUploads);
        if (!(uploads.stagedFiles instanceof WeakMap))
            throw new LocalizedError('error.stagedUploadOwnership');
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
            for (const restore of runtime.agentRestorers.get(agent)?.reverse() ?? [])
                restore();
            runtime.agentRestorers.delete(agent);
        });
        this.ctx.on('agent/pre-step', async ({ agent }, next) => runtime.barrier.read(() => runtime.isLocked(agent.id) ? { kind: 'reject' } : next()));
        const controller = this.ctx.sessionController;
        for (const name of ['prompt', 'attachment', 'updateQueue', 'fork', 'rename', 'selectModel', 'create']) {
            this.patch(controller, name, original => function (request, ...args) {
                const input = request;
                const ids = [input?.sessionId, input?.parentSession].filter((x) => typeof x === 'string');
                return runtime.operation(ids, () => Reflect.apply(original, this, [request, ...args]));
            });
        }
        for (const name of ['resolveAgent', 'state', 'page', 'projections']) {
            this.patch(controller, name, original => function (request, ...args) {
                const id = typeof request === 'string' ? request : request?.sessionId;
                return runtime.operation(id ? [id] : [], async () => {
                    const result = await Reflect.apply(original, this, [request, ...args]);
                    if (id)
                        runtime.assertAllowed([id]);
                    return result;
                });
            });
        }
        this.patch(controller, 'list', original => async function (...args) {
            const result = await Reflect.apply(original, this, args);
            if (!Array.isArray(result?.items))
                throw new LocalizedError('error.sessionListResponse');
            return { ...result, items: result.items.filter((row) => !runtime.deleted.has(digest(row.sessionId))) };
        });
        const service = this.unwrap(this.ctx.schedule);
        const edit = service.edit;
        if (typeof edit !== 'function')
            throw new LocalizedError('error.scheduleEdit');
        runtime.editSchedule = (...args) => Reflect.apply(edit, service, args);
        runtime.patch(service, 'create', original => function (request, actor, ...args) {
            const target = scheduledSession(request);
            const ids = [target, actor].filter((id) => typeof id === 'string');
            return runtime.operation(ids, () => Reflect.apply(original, this, [request, actor, ...args]));
        });
        runtime.patch(service, 'edit', original => async function (request, actor, ...args) {
            const input = request;
            const task = (await service.catalog()).find(task => task.id === input.id);
            const ids = [task && scheduledSession(task), input.patch?.target && scheduledSession({ target: input.patch.target }), actor]
                .filter((id) => typeof id === 'string');
            return runtime.operation(ids, () => Reflect.apply(original, this, [request, actor, ...args]));
        });
        runtime.schedule = service;
        this.ctx.inject(['terminals'], (ctx) => {
            runtime.terminals = ctx.terminals;
            runtime.patch(ctx.terminals, 'spawn', original => function (owner, ...args) {
                return runtime.operation([owner.id], () => Reflect.apply(original, this, [owner, ...args]), true);
            });
            for (const name of ['startSend', 'signal'])
                runtime.patch(ctx.terminals, name, original => function (owner, ...args) {
                    runtime.assertAllowed([owner.id]);
                    runtime.barrier.assertSynchronousPublication();
                    return Reflect.apply(original, this, [owner, ...args]);
                });
        });
    }
    async headers() {
        const records = await this.ctx.sessionQuery.listSessions();
        // SessionQuery also supports a live-only corpus when persistence is withdrawn.
        if (records.length && !records.some(record => record.persisted))
            throw new DeletionRefused('activity.unsaved');
        return new Map(records.map(({ header }) => [header.id, header]));
    }
    /** The public stop APIs do not expose cold-resumed or external Activation cleanup. */
    manager() {
        const manager = this.ctx.subagents && this.unwrap(this.ctx.subagents).manager;
        if (!manager || !(manager.resident instanceof Map) || !(manager.materializations instanceof Set)
            || ['dispose', 'assertAdmitting', 'rootOf'].some(key => typeof manager[key] !== 'function'))
            throw new DeletionRefused('activity.unconfirmed');
        const binding = this.subagentBinding;
        if (binding && (binding.manager !== manager || Object.keys(binding.fields)
            .some(key => binding.fields[key] !== manager[key])))
            throw new DeletionRefused('activity.unconfirmed');
        return manager;
    }
    activations(root, ids, manager) {
        const owned = (agent) => {
            if (!agent || typeof agent.id !== 'string' || agent.session?.id !== agent.id
                || agent.session.header?.id !== agent.id || !Number.isSafeInteger(agent.session.header.createdAt))
                throw new DeletionRefused('activity.unconfirmed');
            if (agent.id !== root.id)
                return false;
            if (agent.session.header.createdAt !== root.createdAt)
                throw new DeletionRefused('error.sessionChanged');
            const live = this.ctx.agents.get(agent.id);
            if (live && live !== agent)
                throw new DeletionRefused('error.sessionChanged');
            return true;
        };
        for (const pending of manager.materializations)
            if (owned(pending?.root))
                throw new DeletionRefused('activity.operations');
        const targets = [];
        for (const [key, activation] of manager.resident) {
            if (!activation || key !== activation.childId || !['local', 'external'].includes(activation.kind))
                throw new DeletionRefused('activity.unconfirmed');
            if (!owned(activation.root)) {
                if (ids.includes(key))
                    throw new DeletionRefused('error.familyChanged');
                continue;
            }
            if (activation.kind === 'local') {
                const agent = activation.handle?.agent;
                if (!agent || agent.id !== key || !ids.includes(key))
                    throw new DeletionRefused('error.familyChanged');
                const live = this.ctx.agents.get(key);
                if (live ? live !== agent || this.handles.get(key)?.agent !== agent
                    : typeof activation.closing?.then !== 'function')
                    throw new DeletionRefused('activity.missingHandle');
            }
            else if (activation.run?.id !== key || typeof activation.run.result?.then !== 'function'
                || typeof activation.run.dispose !== 'function' || typeof activation.controller?.abort !== 'function')
                throw new DeletionRefused('activity.unconfirmed');
            targets.push(activation);
        }
        return targets;
    }
    /** Keep the main session resident until its work and child activations have stopped. */
    stop(root, headers, ids, deadline) {
        const manager = this.manager();
        const activations = this.activations(root, ids, manager);
        const operations = [...new Set(ids.flatMap(id => [...(this.operations.get(id) ?? [])]))];
        if (operations.some(operation => operation.startup))
            throw new DeletionRefused('activity.operations');
        const agents = ids.flatMap(id => {
            const agent = this.ctx.agents.get(id);
            if (!agent) {
                if (this.ctx.sessions.get(id))
                    throw new DeletionRefused('activity.residentSession');
                return [];
            }
            if (this.handles.get(id)?.agent !== agent || agent.session.header.createdAt !== headers.get(id)?.createdAt
                || typeof agent.cancel !== 'function' || typeof agent.whenIdle !== 'function')
                throw new DeletionRefused('activity.missingHandle');
            return [agent];
        });
        const jobs = new Map(ids.flatMap(id => this.ctx.jobs.list(id).filter(job => job.owner === id
            && ['running', 'stopping'].includes(job.status))).map(job => [job.id, job]));
        const terminals = agents.flatMap(agent => (this.terminals?.list(agent) ?? []).map(terminal => ({ agent, id: terminal.sessionId })));
        if (this.terminals && (typeof this.terminals.kill !== 'function' || typeof this.terminals.hasOwnerActivity !== 'function'))
            throw new DeletionRefused('activity.unconfirmed');
        const failures = [], acknowledged = new Map(), waiting = new Set(jobs.keys());
        let jobsFinished;
        const jobsDone = new Promise(resolve => { jobsFinished = resolve; });
        const offSession = this.ctx.on('session/event', (session, event) => {
            if (event.type !== 'job/settled')
                return;
            const job = jobs.get(event.data.jobId);
            if (job && session.id === job.owner && event.data.owner === job.owner)
                acknowledged.set(job.id, event.data.producerReported === true);
        }, { global: true });
        let offJobs;
        try {
            offJobs = this.ctx.jobs.events.subscribe({ owners: 'all' }, event => {
                const job = event.job;
                if (event.type !== 'settled' || !job || !waiting.has(job.id) || jobs.get(job.id)?.owner !== job.owner)
                    return;
                if (acknowledged.get(job.id) !== true)
                    failures.push(new DeletionRefused('activity.unconfirmed'));
                waiting.delete(job.id);
                if (!waiting.size)
                    jobsFinished();
            });
        }
        catch (error) {
            offSession();
            throw error;
        }
        if (performance.now() >= deadline) {
            offJobs();
            offSession();
            throw new DeletionRefused('error.stopTimeout');
        }
        const tasks = [jobsDone, ...operations.map(operation => operation.done)];
        const run = (work) => {
            try {
                tasks.push(Promise.resolve(work()));
            }
            catch (error) {
                failures.push(error);
            }
        };
        for (const member of ids)
            this.locked.add(member);
        // Do not defer these calls to microtasks: closing must precede natural settlement watchers.
        for (const activation of activations)
            run(() => manager.dispose(activation));
        for (const agent of agents) {
            if (agent.id !== root.id) {
                if (!activations.some(activation => activation.handle?.agent === agent))
                    run(() => this.handles.get(agent.id).dispose());
            }
            else {
                run(() => agent.cancel({ kind: 'user' }));
                run(() => agent.whenIdle());
            }
        }
        for (const job of jobs.values())
            run(() => this.ctx.jobs.kill(job.id, job.owner, 'session deleted'));
        for (const terminal of terminals)
            run(() => this.terminals.kill(terminal.agent, terminal.id, 'session deleted'));
        if (!waiting.size)
            jobsFinished();
        const stopping = Promise.allSettled(tasks).then(results => {
            for (const result of results)
                if (result.status === 'rejected')
                    failures.push(result.reason);
            if (agents.some(agent => this.terminals?.hasOwnerActivity(agent)))
                failures.push(new DeletionRefused('activity.terminal'));
            if (failures.length)
                throw new DeletionRefused('error.stopIncomplete', undefined, { failures });
        }).finally(() => { offJobs(); offSession(); if (this.stopping === stopping)
            this.stopping = undefined; });
        this.stopping = stopping;
        return { done: stopping, manager };
    }
    async until(work, deadline) {
        let timer;
        try {
            return await Promise.race([work, new Promise((_, reject) => {
                    timer = setTimeout(() => { reject(new DeletionRefused('error.stopTimeout')); }, Math.max(0, deadline - performance.now()));
                })]);
        }
        finally {
            clearTimeout(timer);
        }
    }
    async checkScheduleDelivery(ids, deadline) {
        const schedule = await this.until(readSchedule(this.home), deadline);
        // A fresh-session reminder persists this reservation before creating its Agent.
        // Deleting that Agent before delivery commits would strand the future reminder.
        if (Object.values(schedule?.tables.tasks ?? {}).some(task => task.target?.kind === 'new'
            && ids.includes(task.pendingDelivery?.targetSessionId ?? '')))
            throw new DeletionRefused('activity.operations');
    }
    /** Final validation; native promises own stopping and lifecycle settlement. */
    async quiescence(ids, global = false, deleting = false) {
        const reasons = [];
        const targets = new Set(ids);
        const all = new Set(global ? this.ctx.sessions.list().map((session) => session.id) : ids);
        for (const id of all) {
            if (targets.has(id)) {
                const stored = await this.ctx.sessionPersistence.stat(id);
                if ((stored?.sizeBytes ?? 0) <= 0)
                    reasons.push(message('activity.unsaved'));
            }
            if (this.operations.get(id)?.size)
                reasons.push(message('activity.operations'));
            const agent = this.ctx.agents.get(id);
            if (agent) {
                if (agent.status !== 'idle')
                    reasons.push(message(global ? 'activity.globalAgentBusy' : 'activity.targetAgentBusy'));
                if (agent.inbox?.nextTurn?.length || agent.inbox?.nextStep?.length)
                    reasons.push(message('activity.queuedInput'));
                if (global && this.preexistingUploadOwners.has(agent))
                    reasons.push(message('activity.untrackedUploads'));
                if (targets.has(id) && !this.handles.has(id))
                    reasons.push(message('activity.missingHandle'));
                const idle = await Promise.race([agent.whenIdle().then(() => true), delay(0).then(() => false)]);
                if (!idle)
                    reasons.push(message('activity.maintenance'));
                if (deleting ? this.terminals?.hasOwnerActivity(agent) : this.terminals?.list(agent).some((terminal) => terminal.status?.kind === 'running'))
                    reasons.push(message('activity.terminal'));
            }
            else if (this.ctx.sessions.get(id))
                reasons.push(message('activity.residentSession'));
            try {
                const activity = await this.ctx.waterfall('workspace/session-activity', { sessionId: id }, () => Promise.resolve([]));
                for (const item of activity) {
                    // Future reminders in another conversation are not work in flight.
                    if ((global || deleting) && item.kind === 'schedule')
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
    async gcSources() {
        const snapshots = [];
        const staged = this.unwrap(this.ctx.fileUploads).stagedFiles;
        for (const session of this.ctx.sessions.list()) {
            const view = await this.ctx.sessionQuery.observeSession(session.id, { projectionMode: 'none' });
            try {
                snapshots.push({ header: view.header, events: view.events,
                    staged: Array.from(staged.get(session)?.values() ?? [], upload => upload.attachment) });
            }
            finally {
                view[Symbol.dispose]();
            }
        }
        return { snapshots, UploadIndex: this.UploadIndex };
    }
    async runMaintenance(kind, work) {
        this.assertAvailable(kind);
        const { promise, resolve } = Promise.withResolvers();
        this.maintenance = { kind, settled: promise };
        const finish = () => { this.maintenance = undefined; resolve(); };
        try {
            return await work();
        }
        finally {
            // A timed-out stop may still be releasing its native handles.
            if (this.stopping)
                void this.stopping.then(finish, finish);
            else
                finish();
        }
    }
    remove(id, confirmed) {
        return this.runMaintenance('delete', () => this.removeOne(id, confirmed));
    }
    async assertSoleHost() {
        if ((await sameHomeHosts(this.home, process.pid)).length)
            throw new DeletionRefused('error.otherHost');
    }
    assertAvailable(kind) {
        if (this.disposed)
            throw new DeletionRefused('error.runtimeUnavailable');
        if (this.maintenance)
            throw new DeletionRefused('error.cleanupBusy');
        if (kind === 'gc' && this.importer?.active)
            throw new DeletionRefused('activity.chatImport');
    }
    async garbageSize() {
        this.assertAvailable('gc');
        if (this.unwrap(this.ctx.attachments).requestInflight.size)
            throw new DeletionRefused('error.imageCacheBusy');
        const publication = this.barrier.idleRevision;
        if (publication === undefined)
            throw new DeletionRefused('error.sizeChanged');
        let changed = false;
        const subscriptions = ['session/created', 'session/disposed', 'session/event'].map(name => this.ctx.on(name, () => { changed = true; }));
        // Session events cover log/lifecycle changes; staged uploads can change without an event.
        const staged = this.unwrap(this.ctx.fileUploads).stagedFiles;
        const current = () => JSON.stringify([this.receiptRevision, this.ctx.sessions.list().map(session => [session.id, [...(staged.get(session)?.keys() ?? [])]])]);
        try {
            const before = current();
            await this.assertSoleHost();
            const bytes = await garbageSize(this.home, await this.gcSources());
            this.assertAvailable('gc');
            if (changed || publication !== this.barrier.idleRevision || before !== current())
                throw new DeletionRefused('error.sizeChanged');
            return bytes;
        }
        finally {
            for (const dispose of subscriptions)
                dispose();
        }
    }
    gc() {
        return this.runMaintenance('gc', async () => {
            if ((await listRequests(this.home)).length)
                throw new DeletionRefused('error.pendingDeletion');
            return this.barrier.exclusive(async () => {
                await this.assertSoleHost();
                const activity = await this.quiescence([], true);
                if (activity.busy)
                    throw new DeletionRefused(activity.reasons);
                // A canceled image caller can finish before its shared compression work.
                if (this.unwrap(this.ctx.attachments).requestInflight.size)
                    throw new DeletionRefused('error.imageCacheBusy');
                await this.ctx.sessionPersistence.flush();
                await Promise.all([...this.cacheWrites.values()].flatMap(writes => [...writes]));
                return collectGarbage(this.home, await this.gcSources());
            });
        });
    }
    async removeOne(id, confirmed) {
        const deadline = performance.now() + this.stopTimeoutMs;
        if ((await this.until(listRequests(this.home), deadline)).length)
            throw new DeletionRefused('error.pendingCleanup');
        // A preview can see an imported log before its workspace attachment settles.
        if (this.importer?.active)
            await this.until(this.importer.active.settled, deadline);
        const readConfirmedFamily = async (checkDeadline) => {
            const headers = await this.until(this.headers(), checkDeadline);
            const root = headers.get(id);
            if (!root || root.createdAt !== confirmed.get(id))
                throw new DeletionRefused('error.sessionChanged');
            if (root.origin === 'subagent' || (root.delegationDepth ?? 0) > 0)
                throw new DeletionRefused('error.mainSessionRequired');
            const ids = familyOf(headers, id);
            if (ids.length !== confirmed.size || ids.some(member => !confirmed.has(member)))
                throw new DeletionRefused('error.familyChanged');
            if (ids.some(member => headers.get(member).createdAt !== confirmed.get(member)))
                throw new DeletionRefused('error.sessionChanged');
            return { headers, root, ids };
        };
        const { headers, root, ids } = await readConfirmedFamily(deadline);
        this.assertAllowed(ids);
        await this.checkScheduleDelivery(ids, deadline);
        await this.until(this.assertSoleHost(), deadline);
        if (performance.now() >= deadline)
            throw new DeletionRefused('error.stopTimeout');
        let enqueueAttempted = false;
        let committed = false;
        const writerLocks = [];
        try {
            const stopped = this.stop(root, headers, ids, deadline);
            await this.until(stopped.done, deadline);
            if (this.manager() !== stopped.manager || this.activations(root, ids, stopped.manager).length)
                throw new DeletionRefused('activity.unconfirmed');
            const again = await this.until(this.quiescence(ids, false, true), deadline);
            if (again.busy)
                throw new DeletionRefused(again.reasons);
            const plan = await this.until(planSessionDeletion(this.home, id, confirmed), deadline);
            await this.checkScheduleDelivery(ids, deadline);
            if (performance.now() >= deadline)
                throw new DeletionRefused('error.stopTimeout');
            for (const member of [...ids].reverse()) {
                const agent = this.ctx.agents.get(member);
                if (agent) {
                    const handle = this.handles.get(member);
                    if (!handle || handle.agent !== agent || agent.session.header.createdAt !== confirmed.get(member))
                        throw new LocalizedError('error.lifecycleChanged');
                    // DSH drains the transcript and releases its writer lease during disposal.
                    this.stopping = handle.dispose();
                    await this.until(this.stopping, deadline);
                    this.stopping = undefined;
                }
                if (this.ctx.sessions.get(member) || this.ctx.agents.get(member))
                    throw new LocalizedError('error.liveStoresRetained');
            }
            for (const record of plan.directories) {
                const lock = await tryLock(join(this.home, record.path, 'session.lock'), true);
                if (!lock)
                    throw new LocalizedError('error.activeSessionWriter');
                writerLocks.push(lock);
            }
            const remaining = deadline - performance.now();
            if (remaining <= 0)
                throw new DeletionRefused('error.stopTimeout');
            const request = await captureDeletionRequest(this.home, root, plan, member => this.ctx.sessionPersistence.stat(member));
            // Keep the shared preparation budget for native checks, regardless of transcript size.
            const checkDeadline = performance.now() + remaining;
            await readConfirmedFamily(checkDeadline);
            await this.checkScheduleDelivery(ids, checkDeadline);
            if (this.manager() !== stopped.manager || this.activations(root, ids, stopped.manager).length)
                throw new DeletionRefused('activity.unconfirmed');
            // Another host can open the shared workspace and schedule tables while large logs are read.
            await this.assertSoleHost();
            enqueueAttempted = true;
            await enqueue(this.home, request);
            for (const member of ids) {
                const writes = this.cacheWrites.get(member);
                if (writes?.size)
                    await Promise.all(writes);
                await this.unwrap(this.ctx.sessionProjectionCache).table.delete(member);
            }
            const result = await sweep(this.home, { hooks: {
                    onlySessionId: id,
                    receiptCommitted: receipt => { this.installReceipt(receipt); committed = true; },
                    applyEdit: async (edit, targets) => {
                        const path = relative(this.home, edit.path);
                        if (path === join('storages', 'workspace.json')) {
                            const registry = this.unwrap(this.ctx.workspaceRegistry);
                            // The public sessionIds view hides memberships whose workspace path changed.
                            for (const [workspaceId, member] of edit.detach ?? [])
                                await registry.get(workspaceId)?.detachSession(member);
                            for (const member of targets) {
                                await registry.unpinSession(member);
                                await this.unarchiveForCleanup(member);
                            }
                        }
                        else if (path === join('storages', 'schedule.json')) {
                            for (const task of await this.schedule.catalog())
                                if (targets.has(scheduledSession(task))) {
                                    const result = await this.editSchedule({ id: task.id, action: 'delete', expectedUpdatedAt: task.updatedAt ?? null });
                                    if (!result.deleted)
                                        throw new LocalizedError('error.scheduleDeletionUnconfirmed');
                                }
                        }
                        else
                            throw new LocalizedError('error.unsupportedLiveEdit', { path });
                    },
                } });
            return { deleted: result.reduce((n, value) => n + value.sessions, 0) };
        }
        finally {
            await Promise.all(writerLocks.map(lock => lock.close()));
            const finish = async () => {
                // rename may commit a request even when the subsequent directory fsync fails.
                if (committed || (enqueueAttempted && await exists(requestPath(this.home, id)))) {
                    // Install every tombstone before notifying fallible downstream listeners.
                    if (!committed)
                        await this.loadReceipt();
                    const completed = ids.filter(member => this.deleted.has(digest(member)));
                    const registry = this.unwrap(this.ctx.workspaceRegistry);
                    for (const member of completed) {
                        for (const key of ['headers', 'sessionPaths', 'missingSessionPaths', 'invalidSessionPaths'])
                            registry[key]?.delete(member);
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
                // The journal blocks new maintenance. Only a receipt keeps a settled session locked.
                for (const member of ids)
                    this.locked.delete(member);
            };
            if (this.stopping) {
                this.stopping = this.stopping.then(finish, finish)
                    .catch(error => { this.ctx.logger.warn('Session stop finalization failed', error); })
                    .finally(() => { this.stopping = undefined; });
            }
            else
                await finish();
        }
    }
}
export async function createRuntime(ctx) {
    const require = createRequire(process.versions.electron ? resolve(process.argv[1]) : await realpath(process.argv[1]));
    const { version } = require('@deepseek-ai/dsh/package.json');
    if (version !== SUPPORTED_DSH)
        throw new LocalizedError('error.incompatibleDsh', { supported: SUPPORTED_DSH, found: version });
    const cordis = await import(__rewriteRelativeImportExtension(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href));
    const provider = await import(__rewriteRelativeImportExtension(pathToFileURL(require.resolve('@deepseek-ai/dsh-llm-deepseek')).href));
    return new DeletionRuntime(ctx, object => (object?.[cordis.symbols.original] ?? object), provider.DeepSeekUploadIndex);
}
