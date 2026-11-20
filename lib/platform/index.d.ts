export interface Lock {
    close(): Promise<void>;
}
export interface ProcessInfo {
    pid: number;
    cwd: string;
    env: string[];
    envFile?: boolean;
}
export declare const usesLockFiles: boolean;
export declare const assertOwner: typeof import("./linux.js").assertOwner, mkdir: typeof import("./linux.js").mkdir, secureDir: typeof import("./linux.js").secureDir, syncDir: typeof import("./linux.js").syncDir, rename: typeof import("./linux.js").rename, birth: typeof import("./linux.js").birth, processes: typeof import("./linux.js").processes, tryLock: typeof import("./linux.js").tryLock, homeVariable: string, resolvePath: typeof import("./linux.js").resolvePath;
