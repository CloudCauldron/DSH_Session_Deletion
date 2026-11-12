import type { Lock } from './index.js';
export declare function assertOwner(path: string, uid: number): void;
export declare function mkdir(path: string): Promise<string | undefined>;
export declare function secureDir(path: string, firstCreated?: string): Promise<void>;
export declare function syncDir(path: string): Promise<void>;
export declare function rename(from: string, to: string): Promise<void>;
export declare function birth(pid: number): Promise<string | undefined>;
export declare function otherHosts(home: string, excluded: Set<number>): Promise<number[]>;
export declare function tryLock(path: string, create?: boolean): Promise<Lock | undefined>;
