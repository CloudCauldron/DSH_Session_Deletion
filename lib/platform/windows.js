/** Windows counterparts for /proc, flock and durable namespace publication. */
import * as fs from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { homedir } from 'node:os';
import { dirname, join, resolve, toNamespacedPath } from 'node:path';
import koffi from 'koffi';
const kernel = koffi.load('kernel32.dll');
const security = koffi.load('advapi32.dll');
const close = kernel.func('int __stdcall CloseHandle(intptr_t handle)');
const lastError = kernel.func('uint32_t __stdcall GetLastError()');
const openProcess = kernel.func('intptr_t __stdcall OpenProcess(uint32_t access, int inherit, uint32_t pid)');
const wait = kernel.func('uint32_t __stdcall WaitForSingleObject(intptr_t handle, uint32_t timeout)');
const times = kernel.func('int __stdcall GetProcessTimes(intptr_t process, void *created, void *exited, void *kernel, void *user)');
const semaphore = kernel.func('intptr_t __stdcall CreateSemaphoreW(void *attributes, int initial, int maximum, const char16_t *name)');
const release = kernel.func('int __stdcall ReleaseSemaphore(intptr_t handle, int count, void *previous)');
const move = kernel.func('int __stdcall MoveFileExW(const char16_t *from, const char16_t *to, uint32_t flags)');
const snapshot = kernel.func('intptr_t __stdcall CreateToolhelp32Snapshot(uint32_t flags, uint32_t pid)');
const first = kernel.func('int __stdcall Process32FirstW(intptr_t snapshot, void *entry)');
const next = kernel.func('int __stdcall Process32NextW(intptr_t snapshot, void *entry)');
const readMemory = kernel.func('int __stdcall ReadProcessMemory(intptr_t process, uintptr_t address, void *data, size_t size, void *read)');
const query = koffi.load('ntdll.dll').func('int32_t __stdcall NtQueryInformationProcess(intptr_t process, uint32_t kind, void *data, uint32_t size, void *length)');
const openToken = security.func('int __stdcall OpenProcessToken(intptr_t process, uint32_t access, _Out_ intptr_t *token)');
const tokenInfo = security.func('int __stdcall GetTokenInformation(intptr_t token, uint32_t kind, void *data, uint32_t size, void *length)');
const equalSid = security.func('int __stdcall EqualSid(void *left, void *right)');
const entryType = koffi.struct({
    size: 'uint32_t', usage: 'uint32_t', pid: 'uint32_t', heap: 'uintptr_t', module: 'uint32_t',
    threads: 'uint32_t', parent: 'uint32_t', priority: 'int32_t', flags: 'uint32_t', exe: koffi.array('char16_t', 260),
});
function check(value, operation) {
    if (!value) {
        const code = lastError();
        throw Object.assign(new Error(`${operation} failed (Win32 ${code})`), { win32Code: code, code: code === 183 || code === 80 ? 'EEXIST' : 'EIO' });
    }
}
function user(processHandle) {
    const token = [0];
    check(openToken(processHandle, 8 /* TOKEN_QUERY */, token), 'OpenProcessToken');
    try {
        const data = Buffer.alloc(256); // TOKEN_USER plus the maximum-sized SID.
        check(tokenInfo(token[0], 1 /* TokenUser */, data, data.length, Buffer.alloc(4)), 'GetTokenInformation');
        return data;
    }
    finally {
        check(close(token[0]), 'CloseHandle');
    }
}
const currentUser = user(-1);
// Windows uses inherited ACLs and write-through publication instead of POSIX
// ownership/mode checks and directory fsync.
export function assertOwner(_path, _uid) { }
export async function secureDir(_path, _firstCreated) { }
export async function syncDir(_path) { }
export async function birth(pid) {
    const handle = openProcess(0x101000 /* QUERY_LIMITED_INFORMATION | SYNCHRONIZE */, 0, pid);
    if (!handle) {
        if (lastError() === 87 /* ERROR_INVALID_PARAMETER: no such PID */)
            return;
        check(handle, 'OpenProcess');
    }
    try {
        const state = wait(handle, 0);
        if (state === 0)
            return;
        if (state !== 258 /* WAIT_TIMEOUT */)
            check(false, 'WaitForSingleObject');
        const created = Buffer.alloc(8);
        check(times(handle, created, Buffer.alloc(8), Buffer.alloc(8), Buffer.alloc(8)), 'GetProcessTimes');
        return created.readBigUInt64LE().toString();
    }
    finally {
        check(close(handle), 'CloseHandle');
    }
}
export async function tryLock(path, _create = false) {
    // This name and semaphore protocol are DSH rc.5's session-write lease ABI.
    const name = 'Local\\dsh-session-lock-' + createHash('sha256').update(resolve(path).toLowerCase()).digest('hex');
    const handle = semaphore(null, 1, 1, name);
    check(handle, 'CreateSemaphoreW');
    const state = wait(handle, 0);
    if (state === 0)
        return { async close() {
                try {
                    check(release(handle, 1, null), 'ReleaseSemaphore');
                }
                finally {
                    check(close(handle), 'CloseHandle');
                }
            } };
    const error = lastError();
    check(close(handle), 'CloseHandle');
    if (state !== 258)
        throw new Error(`WaitForSingleObject failed (Win32 ${error})`);
}
export async function rename(from, to) {
    check(move(toNamespacedPath(from), toNamespacedPath(to), 9 /* REPLACE_EXISTING | WRITE_THROUGH */), 'MoveFileExW');
}
export async function mkdir(path) {
    try {
        if ((await fs.lstat(path)).isDirectory())
            return;
        throw new Error('Not a directory: ' + path);
    }
    catch (e) {
        if (e.code !== 'ENOENT')
            throw e;
    }
    const firstCreated = await mkdir(dirname(path));
    const staging = await fs.mkdtemp(join(dirname(path), '.session-deletion-dir-'));
    try {
        check(move(toNamespacedPath(staging), toNamespacedPath(path), 8 /* WRITE_THROUGH */), 'MoveFileExW');
        return firstCreated || path;
    }
    catch (e) {
        if (e.code !== 'EEXIST' || !(await fs.lstat(path)).isDirectory())
            throw e;
        return firstCreated;
    }
    finally {
        await fs.rm(staging, { recursive: true, force: true });
    }
}
/** Read the target's own cwd/environment, rather than infer DSH_HOME from ours.
 * PEB/RTL_USER_PROCESS_PARAMETERS are Windows ABI structures; failed inspection
 * defers cleanup. Both native 64-bit and WOW64 Node processes are recognized. */
function parameters(handle) {
    const pointerSize = koffi.sizeof('uintptr_t');
    const basic = Buffer.alloc(6 * pointerSize), wow64 = Buffer.alloc(8);
    if (query(handle, 0, basic, basic.length, null) < 0 || (pointerSize === 8 && query(handle, 26, wow64, wow64.length, null) < 0))
        throw new Error('Cannot query process parameters');
    const narrow = pointerSize === 4 || wow64.readBigUInt64LE() !== 0n;
    const pointer = (data, offset) => narrow ? BigInt(data.readUInt32LE(offset)) : data.readBigUInt64LE(offset);
    const read = (address, size) => {
        const data = Buffer.alloc(size);
        check(readMemory(handle, address, data, size, null), 'ReadProcessMemory');
        return data;
    };
    const peb = wow64.readBigUInt64LE() || pointer(basic, pointerSize);
    const address = pointer(read(peb, narrow ? 0x14 : 0x28), narrow ? 0x10 : 0x20);
    const params = read(address, narrow ? 0x4c : 0x88);
    const string = (offset) => read(pointer(params, offset + (narrow ? 4 : 8)), params.readUInt16LE(offset)).toString('utf16le');
    const command = string(narrow ? 0x40 : 0x70).replaceAll('\\', '/');
    if (!/(?:@deepseek-ai\/dsh\/|deepseek-harness|\/dsh(?:["\s]|$))/.test(command))
        return { command: '', home: '' };
    let environment = '', cursor = pointer(params, narrow ? 0x48 : 0x80);
    while (!environment.includes('\0\0')) {
        if (environment.length > 8 * 1024 * 1024)
            throw new Error('Unterminated process environment');
        const size = 4096 - Number(cursor % 4096n);
        environment += read(cursor, size).toString('utf16le');
        cursor += BigInt(size);
    }
    const configured = environment.slice(0, environment.indexOf('\0\0')).split('\0').find(row => /^DSH_HOME=/i.test(row))?.slice(9);
    return { command, home: resolve(string(narrow ? 0x24 : 0x38), configured || join(homedir(), '.dsh')) };
}
export async function otherHosts(home, excluded) {
    const found = [];
    const list = snapshot(2 /* TH32CS_SNAPPROCESS */, 0);
    if (list === -1 || list === -1n)
        check(false, 'CreateToolhelp32Snapshot');
    try {
        const entry = Buffer.alloc(koffi.sizeof(entryType));
        entry.writeUInt32LE(entry.length);
        for (let ok = first(list, entry); ok; ok = next(list, entry)) {
            const row = koffi.decode(entry, entryType);
            if (excluded.has(row.pid) || !/^(?:node|nodejs|dsh)\.exe$/i.test(row.exe))
                continue;
            const handle = openProcess(0x101410 /* QUERY_INFORMATION | QUERY_LIMITED_INFORMATION | VM_READ | SYNCHRONIZE */, 0, row.pid);
            if (!handle && lastError() === 87)
                continue;
            check(handle, 'OpenProcess');
            try {
                const owner = user(handle);
                if (!equalSid(koffi.decode(owner, 'void *'), koffi.decode(currentUser, 'void *')))
                    continue;
                const info = parameters(handle);
                if (info.command && info.home.toLowerCase() === resolve(home).toLowerCase())
                    found.push(row.pid);
            }
            catch (e) {
                if (wait(handle, 0) !== 0)
                    throw new Error('Cannot inspect a same-user process; cleanup deferred', { cause: e });
            }
            finally {
                check(close(handle), 'CloseHandle');
            }
        }
        if (lastError() !== 18 /* ERROR_NO_MORE_FILES */)
            check(false, 'Process32NextW');
    }
    finally {
        check(close(list), 'CloseHandle');
    }
    return found;
}
