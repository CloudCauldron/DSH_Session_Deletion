import { type Lock } from './platform/index.js';
export interface GuardOptions {
    home: string;
    hostPid?: number;
    hostBirth?: string;
    startupTimeoutMs?: number;
}
export declare function waitingHosts(state: string): Promise<Set<number>>;
export declare function otherHosts(home: string, excluded: Set<number>): Promise<number[]>;
/** Preserve DSH's writer protocol by default; machineWide additionally requires
 * exclusion across Windows logon sessions for the recovery lifecycle. */
export declare function tryLock(path: string, create?: boolean, machineWide?: boolean): Promise<Lock | undefined>;
export declare function runGuard(options: GuardOptions, announce?: (line: string) => void): Promise<void>;
