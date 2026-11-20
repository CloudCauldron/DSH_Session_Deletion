import { type Lock } from './platform/index.js';
export declare function sameHomeHosts(home: string, excludePid?: number): Promise<number[]>;
/** Preserve DSH's writer protocol by default; machineWide additionally requires
 * exclusion across Windows logon sessions for the recovery lifecycle. */
export declare function tryLock(path: string, create?: boolean, machineWide?: boolean): Promise<Lock | undefined>;
