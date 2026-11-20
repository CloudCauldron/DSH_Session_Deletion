export interface SessionHeader {
    type?: 'session';
    version: number;
    id: string;
    createdAt: number;
    cwd?: string;
    parentSession?: string;
    origin?: 'subagent';
    delegationDepth?: number;
    isSeeded?: boolean;
}
interface SessionDirectory {
    path: string;
    id: string;
    createdAt: number;
}
interface Transcript {
    path: string;
    sizeBytes: number;
    sha256: string;
}
export interface SessionStat {
    header: SessionHeader;
    sizeBytes?: number;
    location?: {
        kind: string;
        path: string;
    };
}
export interface DeletionPlan<T extends SessionDirectory = SessionDirectory> {
    ids: string[];
    directories: T[];
}
export interface DeletionRequest {
    schema: 1;
    dshVersion: string;
    sessionId: string;
    createdAt: number;
    queuedAt: string;
    plan: DeletionPlan<SessionDirectory & {
        transcript: Transcript;
    }>;
}
export interface Result {
    sessions: number;
}
export interface GcResult {
    total: number;
    objects: number;
    fileLinks: number;
    cacheFiles: number;
    uploadMappings: number;
}
export interface Receipt {
    schema: 1;
    revision: string;
    deletedIdHashes: string[];
    lastCompletedAt?: string;
    lastResult?: Result;
}
export interface ScheduleTask {
    sessionId?: string;
    target?: {
        kind: 'session' | 'new_once' | 'new';
        sessionId?: string;
    };
    record?: {
        id: string;
    };
    pendingDelivery?: {
        targetSessionId: string;
    };
}
interface ScheduleData {
    unit: {
        name: string;
    };
    tables: {
        tasks: Record<string, ScheduleTask>;
    };
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
interface Edit {
    path: string;
    data: unknown;
    detach?: [workspaceId: string, sessionId: string][];
}
export interface LiveSnapshot {
    header: SessionHeader;
    events: readonly unknown[];
    staged?: readonly unknown[];
}
export interface SweepHooks {
    /** Live owners mutate their own tables, never overwrite them from a disk snapshot. */
    applyEdit?(edit: Edit, ids: ReadonlySet<string>): Promise<void>;
    receiptCommitted?(receipt: Receipt): void;
    onlySessionId?: string;
}
export interface GcSources {
    snapshots?: readonly LiveSnapshot[];
    UploadIndex?: new (path: string) => UploadIndex;
}
export declare const SUPPORTED_DSH = "0.2.2-rc.5";
export declare const STATE_NAME = ".dsh-session-deletion";
export declare const digest: (value: string) => string;
export declare const stateDir: (home: string) => string;
export declare const requestPath: (home: string, id: string) => string;
/** DSH's explicit destination wins over the legacy session binding. */
export declare function scheduledSession(task: ScheduleTask): string | undefined;
export declare function readSchedule(home: string): Promise<ScheduleData | undefined>;
export declare function encodeSegment(raw: string): string;
export declare function exists(path: string): Promise<boolean>;
export declare function safePath(path: string, { missing, directory }?: {
    missing?: boolean;
    directory?: boolean;
}): Promise<void>;
export declare function privateDir(path: string): Promise<void>;
export declare function atomicJSON(path: string, data: unknown): Promise<void>;
export declare function readJSON<T>(path: string, fallback?: T): Promise<T>;
export declare function removeOwned(path: string): Promise<void>;
export declare function cleanAtomicTemps(directory: string): Promise<void>;
export declare function readLog(path: string, refs?: Set<string>): Promise<SessionHeader>;
export declare function scanSessions(home: string, refs?: Set<string>): Promise<Map<string, {
    dir: string;
    createdAt: number;
}>>;
export declare function familyOf(headers: ReadonlyMap<string, SessionHeader>, rootId: string): string[];
/** Locate only the confirmed family's directories. No other transcript or attachment is read. */
export declare function planSessionDeletion(home: string, rootId: string, confirmed: ReadonlyMap<string, number>): Promise<DeletionPlan>;
export declare function listRequests(home: string): Promise<DeletionRequest[]>;
/** The caller holds every target writer lock through journal publication and cleanup. */
export declare function captureDeletionRequest(home: string, header: SessionHeader, plan: DeletionPlan, stat: (id: string) => Promise<SessionStat | undefined>): Promise<DeletionRequest>;
export declare function enqueue(home: string, request: DeletionRequest): Promise<void>;
/** Sweep confirmed session data under the caller's live maintenance or exclusive offline writer protections. */
export declare function sweep(home: string, { failAfter, hooks }?: {
    failAfter?: number;
    hooks?: SweepHooks;
}): Promise<Result[]>;
/** Read-only estimate using the same reference checks as the actual collection. */
export declare function garbageSize(home: string, sources?: GcSources): Promise<number>;
/** Explicit, globally quiescent mark/sweep. Interrupted GC is rescanned, never replayed from a stale manifest. */
export declare function collectGarbage(home: string, { failAfter, ...sources }?: GcSources & {
    failAfter?: number;
}): Promise<GcResult>;
export {};
