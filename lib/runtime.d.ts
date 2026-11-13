import { type LiveSnapshot, type SessionHeader, type GcResult } from './core.js';
import { type Gate } from './gate.js';
import { LocalizedError, type LocalizedMessage } from './locale.js';
interface Session {
    id: string;
    header: SessionHeader;
}
interface Agent {
    id: string;
    session: Session;
    status: string;
    whenIdle(): Promise<void>;
    inbox?: {
        nextTurn?: readonly unknown[];
        nextStep?: readonly unknown[];
    };
}
interface DeletionCache {
    delete(id: string): unknown;
}
interface Schedule {
    catalog(): Promise<Array<{
        sessionId: string;
        id: string;
    }>>;
    delete(request: {
        sessionId: string;
        id: string;
    }): Promise<unknown>;
}
interface Terminals {
    list(agent: Agent): Array<{
        status?: {
            kind: string;
        };
    }>;
}
interface UploadRecord {
    scope: string;
    attachmentId: string;
    variantId: string;
    fileId: string;
}
export interface UploadIndex {
    load(): Promise<{
        records: UploadRecord[];
    }>;
    remove(scope: string, records: Array<Pick<UploadRecord, 'variantId' | 'fileId'>>): Promise<unknown>;
}
export interface RuntimeContext {
    sessionDeletionGate: Gate;
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
        list(): Promise<Array<{
            header: SessionHeader;
        }>>;
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
        list(): Array<{
            sessionIds: string[];
            detachSession(id: string): Promise<unknown>;
        }>;
        headers?: DeletionCache;
        sessionPaths?: DeletionCache;
        missingSessionPaths?: DeletionCache;
        invalidSessionPaths?: DeletionCache;
    };
    sessionController: object;
    schedule: Schedule;
    terminals: Terminals;
    on(name: 'agent/created' | 'agent/disposed', listener: (event: {
        agent: Agent;
    }) => unknown): () => void;
    on(name: 'agent/pre-step', listener: (event: {
        agent: Agent;
    }, next: () => Promise<unknown>) => unknown): () => void;
    on(name: 'session/created' | 'session/disposed' | 'session/event', listener: () => unknown): () => void;
    inject(names: string[], callback: (ctx: RuntimeContext) => void): unknown;
    effect(callback: () => () => void, label?: string): unknown;
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
    private operations;
    private deleted;
    private receiptRevision;
    private cacheWrites;
    private restorers;
    private agentRestorers;
    private wrapped;
    private controller?;
    private schedule?;
    private terminals?;
    private unarchiveForCleanup;
    private maintenance?;
    get gcRunning(): boolean;
    get deletionRunning(): boolean;
    constructor(ctx: RuntimeContext, unwrap: <T extends object>(value: T) => T, UploadIndex: new (path: string) => UploadIndex);
    get home(): string;
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
    initialize(): Promise<void>;
    headers(): Promise<Map<string, SessionHeader>>;
    family(headers: Map<string, SessionHeader>, id: string): string[];
    /** One final check after native archival, never a continuous activity monitor. */
    private quiescence;
    get archivedIds(): string[];
    private snapshots;
    remove(id: string, createdAt: number, expectedIds: readonly string[]): Promise<{
        deleted: number;
    }>;
    garbageSize(): Promise<number>;
    gc(): Promise<GcResult>;
    private removeUploadMappings;
    private removeOne;
}
export declare const name = "session-deletion-runtime";
export declare const inject: string[];
export declare function apply(ctx: RuntimeContext): Promise<void>;
export {};
