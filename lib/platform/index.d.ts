export interface Lock {
    close(): Promise<void>;
}
export declare const usesLockFiles: boolean;
export declare const assertOwner: typeof import("./linux.js").assertOwner, mkdir: typeof import("./linux.js").mkdir, secureDir: typeof import("./linux.js").secureDir, syncDir: typeof import("./linux.js").syncDir, rename: typeof import("./linux.js").rename, birth: typeof import("./linux.js").birth, otherHosts: typeof import("./linux.js").otherHosts, tryLock: typeof import("./linux.js").tryLock;
