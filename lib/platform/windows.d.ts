import type { Lock } from './index.js';
export declare function assertOwner(_path: string, _uid: number): void;
export declare function secureDir(_path: string, _firstCreated?: string): Promise<void>;
export declare function syncDir(_path: string): Promise<void>;
export declare function birth(pid: number): Promise<string | undefined>;
export declare function tryLock(path: string, _create?: boolean): Promise<Lock | undefined>;
export declare function rename(from: string, to: string): Promise<void>;
export declare function mkdir(path: string): Promise<string | undefined>;
export declare function otherHosts(home: string, excluded: Set<number>): Promise<number[]>;
