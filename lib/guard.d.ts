/** Detached Node.js supervisor for interrupted deletion recovery before startup or after exit. */
import * as fs from 'node:fs/promises';
export interface GuardOptions {
    home: string;
    hostPid?: number;
    hostBirth?: string;
    startupTimeoutMs?: number;
}
export declare function birth(pid: number): Promise<string | undefined>;
export declare function waitingHosts(state: string): Promise<Set<number>>;
export declare function otherHosts(home: string, excluded: Set<number>): Promise<number[]>;
/** Kernel lock, held on an open inode and automatically released on process death. */
export declare function tryLock(path: string, create?: boolean): Promise<fs.FileHandle | undefined>;
export declare function runGuard(options: GuardOptions, announce?: (line: string) => void): Promise<void>;
