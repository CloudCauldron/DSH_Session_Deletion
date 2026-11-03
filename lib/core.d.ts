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
export interface References {
    hashes: Set<string>;
}
export interface StoredSession {
    header: SessionHeader;
    dir: string;
    refs: References;
}
export type SessionMap = Map<string, StoredSession>;
export interface DeletionPlan {
    ids: string[];
    directories: {
        path: string;
        id: string;
        createdAt: number;
    }[];
}
export interface DeletionRequest {
    schema: 3;
    dshVersion: string;
    sessionId: string;
    createdAt: number;
    queuedAt: string;
    plan: DeletionPlan;
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
interface Edit {
    path: string;
    data: unknown;
}
export interface LiveSnapshot {
    header: SessionHeader;
    events: readonly unknown[];
}
export interface SweepHooks {
    /** Live owners mutate their own tables, never overwrite them from a disk snapshot. */
    applyEdit?(edit: Edit, ids: ReadonlySet<string>): Promise<void>;
    receiptCommitted?(receipt: Receipt): void;
    onlySessionId?: string;
}
export interface GcHooks {
    snapshots?(): Promise<Map<string, LiveSnapshot>>;
    removeUploadMappings?(hashes: ReadonlySet<string>): Promise<void>;
}
export declare const SUPPORTED_DSH = "0.2.1-rc.5";
export declare const STATE_NAME = "session-deletion";
export declare const digest: (value: string) => string;
export declare const stateDir: (home: string) => string;
export declare const requestPath: (home: string, id: string) => string;
export declare function encodeSegment(raw: string): string;
export declare function exists(path: string): Promise<boolean>;
export declare function safePath(path: string, { missing, directory }?: {
    missing?: boolean;
    directory?: boolean;
}): Promise<void>;
export declare function privateDir(path: string): Promise<void>;
export declare function birth(pid: number): Promise<string | undefined>;
export declare function atomicJSON(path: string, data: unknown): Promise<void>;
export declare function readJSON<T>(path: string, fallback?: T): Promise<T>;
export declare function removeOwned(path: string): Promise<void>;
export declare function cleanAtomicTemps(directory: string): Promise<void>;
export declare function readLog(path: string, headerOnly?: boolean): Promise<{
    header: SessionHeader;
    refs: References;
}>;
export declare function scanSessions(home: string, snapshots?: Map<string, LiveSnapshot>): Promise<SessionMap>;
export declare function familyOf(sessions: SessionMap, rootId: string): Set<string>;
/** Locate only the confirmed family's directories. No other transcript or attachment is read. */
export declare function planSessionDeletion(home: string, headers: Map<string, SessionHeader>, rootId: string): Promise<DeletionPlan>;
export declare function listRequests(home: string): Promise<DeletionRequest[]>;
export declare function enqueue(home: string, header: SessionHeader, plan: DeletionPlan): Promise<DeletionRequest>;
/** Caller holds lifecycle and target writer locks. This function never scans or deletes attachments. */
export declare function sweep(home: string, { failAfter, hooks }?: {
    failAfter?: number;
    hooks?: SweepHooks;
}): Promise<Result[]>;
/** Explicit, globally quiescent mark/sweep. Interrupted GC is rescanned, never replayed from a stale manifest. */
export declare function collectGarbage(home: string, { hooks, failAfter }?: {
    hooks?: GcHooks;
    failAfter?: number;
}): Promise<GcResult>;
export {};
