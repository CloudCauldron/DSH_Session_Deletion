import { LocalizedError } from '../locale.js';
if (!['linux', 'win32'].includes(process.platform))
    throw new LocalizedError('error.unsupportedPlatform');
const platform = process.platform === 'win32'
    ? await import('./windows.js') : await import('./linux.js');
export const usesLockFiles = process.platform === 'linux';
export const { assertOwner, mkdir, secureDir, syncDir, rename, birth, processes, tryLock, homeVariable, resolvePath } = platform;
