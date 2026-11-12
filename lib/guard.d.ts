import { type Lock } from './platform/index.js';
export interface GuardOptions {
    home: string;
    hostPid?: number;
    hostBirth?: string;
    startupTimeoutMs?: number;
}
export declare function waitingHosts(state: string): Promise<Set<number>>;
/** Use the same kernel lock as DSH's session writer on each platform. */
export declare function tryLock(path: string, create?: boolean): Promise<Lock | undefined>;
export declare function runGuard(options: GuardOptions, announce?: (line: string) => void): Promise<void>;
