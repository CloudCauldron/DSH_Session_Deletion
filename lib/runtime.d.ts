import { type SessionHeader, type GcResult } from './core.js';
type Dynamic = Record<string, any>;
export interface Activity {
    busy: boolean;
    reasons: string[];
}
export declare class DeletionRefused extends Error {
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
    readonly ctx: Dynamic;
    private unwrap;
    private UploadIndex;
    readonly locked: Set<string>;
    readonly barrier: PublicationBarrier;
    private handles;
    private operations;
    private deleted;
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
    constructor(ctx: Dynamic, unwrap: (value: any) => any, UploadIndex: new (path: string) => Dynamic);
    get home(): string;
    isLocked(id: string): boolean;
    private assertAllowed;
    private operation;
    private patch;
    private trackAgent;
    private captureFactory;
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
    gc(): Promise<GcResult>;
    private removeUploadMappings;
    private removeOne;
}
export declare const name = "session-deletion-runtime";
export declare const inject: string[];
export declare function apply(ctx: Dynamic): Promise<void>;
export {};
