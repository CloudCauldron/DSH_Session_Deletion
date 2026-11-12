export interface Lock { close(): Promise<void> }
export interface ProcessInfo { pid: number; cwd: string; env: string[] }

if (!['linux', 'win32'].includes(process.platform)) throw new Error('Session Deletion supports Linux and Windows only');

const platform: typeof import('./linux.js') = process.platform === 'win32'
  ? await import('./windows.js') : await import('./linux.js');

export const usesLockFiles = process.platform === 'linux';
export const { assertOwner, mkdir, secureDir, syncDir, rename, birth, processes, tryLock, homeVariable, resolvePath } = platform;
