import { type UploadIndex, type LiveSnapshot, type SessionHeader, type GcResult, type ScheduleTask } from './core.js';
import { LocalizedError } from './locale/errors.js';
import { type LocalizedMessage } from './locale/shared.js';
interface Session {
    id: string;
    header: SessionHeader;
}
interface Agent {
    id: string;
    session: Session;
    status: string;
    whenIdle(): Promise<void>;
    cancel(cause: {
        kind: 'user';
    }): void;
    inbox?: {
        nextTurn?: readonly unknown[];
        nextStep?: readonly unknown[];
    };
}
interface DeletionCache {
    delete(id: string): unknown;
}
interface Schedule {
    catalog(): Promise<Array<ScheduleTask & {
        id: string;
        updatedAt?: string;
    }>>;
    create(request: {
        target: ScheduleTask['target'];
    }, actor?: string, signal?: AbortSignal): Promise<unknown>;
    edit(request: {
        id: string;
        action: 'update' | 'delete';
        expectedUpdatedAt?: string | null;
        patch?: {
            target?: ScheduleTask['target'];
        };
    }, actor?: string, signal?: AbortSignal): Promise<unknown>;
}
interface Terminals {
    list(agent: Agent): Array<{
        sessionId: string;
        status?: {
            kind: string;
        };
    }>;
    hasOwnerActivity(agent: Agent): boolean;
    kill(agent: Agent, id: string, reason: string): Promise<boolean>;
}
interface Job {
    id: string;
    owner?: string;
    status: string;
}
interface Jobs {
    start(spec: {
        owner?: string;
    }): unknown;
    list(owner: string): Job[];
    kill(id: string, owner: string, reason: string): unknown;
    events: {
        subscribe(filter: {
            owners: 'all';
        }, listener: (event: {
            type: string;
            job?: Job;
        }) => void): () => void;
    };
}
export interface RuntimeContext {
    dshHomePath(): string;
    fiber: {
        uid: number | null;
    };
    attachments: {
        root: string;
        cacheRoot: string;
        requestInflight: {
            size: number;
        };
    };
    fileUploads: {
        stagedFiles: WeakMap<object, Map<string, {
            attachment: unknown;
        }>>;
    };
    agents: {
        list(): Agent[];
        get(id: string): Agent | undefined;
        requireFactory(): {
            target: object;
        };
        setFactory(...args: unknown[]): unknown;
        factory?: {
            target: object;
        };
    };
    sessions: {
        list(): Session[];
        get(id: string): Session | undefined;
    };
    sessionPersistence: {
        name: string;
        root: string;
        stat(id: string): Promise<{
            sizeBytes: number;
        } | undefined>;
        flush(): Promise<void>;
        coldLogMemo?: DeletionCache;
    };
    sessionProjectionCache: {
        table: DeletionCache;
        put(id: string, ...args: unknown[]): unknown;
    };
    sessionQuery: {
        listSessions(): Promise<Array<{
            header: SessionHeader;
            persisted: boolean;
        }>>;
        observeSession(id: string, options: {
            projectionMode: 'none';
        }): Promise<LiveSnapshot & Disposable>;
        _observations?: {
            cache?: DeletionCache;
        };
    };
    workspaceRegistry: {
        archivedSessionIds: string[];
        pinSession(id: string): unknown;
        archiveSession(id: string): Promise<unknown>;
        unarchiveSession(id: string): Promise<void>;
        unpinSession(id: string): Promise<unknown>;
        get(id: string): {
            detachSession(id: string): Promise<unknown>;
        } | undefined;
        headers?: DeletionCache;
        sessionPaths?: DeletionCache;
        missingSessionPaths?: DeletionCache;
        invalidSessionPaths?: DeletionCache;
    };
    sessionController: object;
    schedule: Schedule;
    terminals: Terminals;
    deepseekChatImport: {
        active?: {
            settled: Promise<void>;
        };
    };
    jobs: Jobs;
    subagents: {
        manager?: unknown;
    };
    on(name: 'agent/created' | 'agent/disposed', listener: (event: {
        agent: Agent;
    }) => unknown): () => void;
    on(name: 'agent/pre-step', listener: (event: {
        agent: Agent;
    }, next: () => Promise<unknown>) => unknown): () => void;
    on(name: 'session/created' | 'session/disposed' | 'session/event', listener: () => unknown): () => void;
    on(name: 'session/event', listener: (session: Session, event: {
        type: string;
        data: {
            jobId?: string;
            owner?: string;
            producerReported?: boolean;
        };
    }) => unknown, options: {
        global: true;
    }): () => void;
    inject(names: string[], callback: (ctx: RuntimeContext) => void): unknown;
    effect(callback: () => () => void | Promise<void>, label?: string): unknown;
    provide(name: string, value: unknown): unknown;
    emit(name: 'api-session/removed', id: string): unknown;
    waterfall(name: 'workspace/session-activity', request: {
        sessionId: string;
    }, fallback: () => Promise<unknown[]>): Promise<Array<{
        kind?: string;
    }>>;
    logger: {
        warn(message: string, error: unknown): unknown;
    };
}
export interface Activity {
    busy: boolean;
    reasons: LocalizedMessage[];
}
export declare class DeletionRefused extends LocalizedError {
    readonly status = 409;
}
/** Briefly serialize input/attachment publication while collecting references.
 * Reentrant service calls keep their lease, avoiding nested-call deadlocks. */
export declare class PublicationBarrier {
    private context;
    private active;
    private revision;
    recordPublication(): void;
    get idleRevision(): number | undefined;
    private blocked;
    private waiters;
    assertSynchronousPublication(): void;
    read<T>(work: () => Promise<T> | T): Promise<T>;
    exclusive<T>(work: () => Promise<T>, timeoutMs?: number): Promise<T>;
}
export declare class DeletionRuntime {
    readonly ctx: RuntimeContext;
    private unwrap;
    private UploadIndex;
    readonly locked: Set<string>;
    readonly barrier: PublicationBarrier;
    private handles;
    private preexistingAgents;
    private operations;
    private deleted;
    private importer?;
    private receiptRevision;
    private cacheWrites;
    private restorers;
    private agentRestorers;
    private wrapped;
    private schedule;
    private terminals?;
    private subagentBinding?;
    private stopping?;
    private stopTimeoutMs;
    private editSchedule;
    private unarchiveForCleanup;
    private maintenance?;
    private disposed;
    get gcRunning(): boolean;
    get deletionRunning(): boolean;
    readonly home: string;
    constructor(ctx: RuntimeContext, unwrap: <T extends object>(value: T) => T, UploadIndex: new (path: string) => UploadIndex);
    get receiptSummary(): {
        revision: string;
        count: number;
    };
    get receipt(): {
        revision: string;
        deletedIdHashes: string[];
    };
    isLocked(id: string): boolean;
    private assertAllowed;
    private operation;
    private patch;
    private trackAgent;
    private captureFactory;
    private installReceipt;
    private loadReceipt;
    closeAdmission(): Promise<void> | undefined;
    initialize(): Promise<void>;
    headers(): Promise<Map<string, SessionHeader>>;
    /** The public stop APIs do not expose cold-resumed or external Activation cleanup. */
    private manager;
    private activations;
    /** Start native cleanup synchronously after locking, retaining the main Session until commit. */
    private stop;
    private until;
    private checkScheduleDelivery;
    /** Final validation; native promises own stopping and lifecycle settlement. */
    private quiescence;
    get archivedIds(): string[];
    private gcSources;
    private runMaintenance;
    remove(id: string, createdAt: number, expectedIds: readonly string[]): Promise<{
        deleted: number;
    }>;
    private assertSoleHost;
    private assertAvailable;
    garbageSize(): Promise<number>;
    gc(): Promise<GcResult>;
    private removeOne;
}
export declare function createRuntime(ctx: RuntimeContext): Promise<DeletionRuntime>;
export {};
