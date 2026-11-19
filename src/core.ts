import * as fs from 'node:fs/promises';
import { createReadStream, openSync, constants } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve, dirname, basename, relative, sep, parse, isAbsolute } from 'node:path';
import { assertOwner, mkdir, secureDir, syncDir, rename, birth } from './platform/index.js';
import { LocalizedError } from './locale/errors.js';

export interface SessionHeader {
  type?: 'session'; version: number; id: string; createdAt: number; cwd?: string;
  parentSession?: string; origin?: 'subagent'; delegationDepth?: number; isSeeded?: boolean;
}
export interface DeletionPlan {
  ids: string[]; directories: { path: string; id: string; createdAt: number }[];
}
export interface DeletionRequest {
  schema: 3; dshVersion: string; sessionId: string; createdAt: number; queuedAt: string;
  plan: DeletionPlan;
}
export interface Result { sessions: number }
export interface GcResult { total: number; objects: number; fileLinks: number; cacheFiles: number; uploadMappings: number }
export interface Receipt { schema: 1; revision: string; deletedIdHashes: string[]; lastCompletedAt?: string; lastResult?: Result }
interface WorkspaceData {
  unit: { name: string; version: number };
  global: { archivedSessionIds: string[]; pinnedSessionIds: string[] };
  tables: { workspaces: Record<string, { sessionIds: string[] }> };
}
export interface ScheduleTask {
  sessionId?: string;
  target?: { kind: 'session' | 'new_once' | 'new'; sessionId?: string };
  record?: { id: string };
  pendingDelivery?: { targetSessionId: string };
}
interface ScheduleData { unit: { name: string }; tables: { tasks: Record<string, ScheduleTask> } }
interface UploadRecord { scope: string; attachmentId: string; variantId: string; fileId: string }
interface RemoteCache { formatVersion: number; records: UploadRecord[] }
export interface UploadIndex {
  load(): Promise<{ records: UploadRecord[] }>;
  remove(scope: string, records: Array<Pick<UploadRecord, 'variantId' | 'fileId'>>): Promise<unknown>;
}
interface Edit { path: string; data: unknown; detach?: [workspaceId: string, sessionId: string][] }
export interface LiveSnapshot { header: SessionHeader; events: readonly unknown[]; staged?: readonly unknown[] }
export interface SweepHooks {
  /** Live owners mutate their own tables, never overwrite them from a disk snapshot. */
  applyEdit?(edit: Edit, ids: ReadonlySet<string>): Promise<void>;
  receiptCommitted?(receipt: Receipt): void;
  onlySessionId?: string;
}
export interface GcSources {
  snapshots?: readonly LiveSnapshot[];
  UploadIndex?: new(path: string) => UploadIndex;
}

export const SUPPORTED_DSH = '0.2.2-rc.5';
export const STATE_NAME = '.dsh-session-deletion';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const stateDir = (home: string) => join(home, STATE_NAME);
export const requestPath = (home: string, id: string) => join(stateDir(home), 'pending', digest(id) + '.json');
/** DSH's explicit destination wins over the legacy session binding. */
export function scheduledSession(task: ScheduleTask): string | undefined {
  if (task.target?.kind === 'new') return undefined;
  if (task.target) {
    if (!['session', 'new_once'].includes(task.target.kind)) throw new LocalizedError('error.scheduleDestination');
    if (task.target.sessionId) return task.target.sessionId;
    if (task.target.kind !== 'new_once') throw new LocalizedError('error.scheduleDestination');
  } else if (task.sessionId) return task.sessionId;
  return task.record ? 'session-schedule-' + digest(task.record.id) : undefined;
}
export async function readSchedule(home: string): Promise<ScheduleData | undefined> {
  const schedule = await readJSON<ScheduleData | undefined>(join(home, 'storages/schedule.json'));
  if (schedule && (schedule.unit?.name !== 'schedule' || !schedule.tables?.tasks)) throw new LocalizedError('error.scheduleSchema');
  return schedule;
}
export function encodeSegment(raw: string) {
  if (typeof raw !== 'string' || !raw || raw.length > 1024) throw new LocalizedError('error.invalidSessionId');
  let out = '';
  for (let i = 0; i < raw.length; i++) {
    const c = raw[i];
    out += /[A-Za-z0-9._-]/.test(c) ? c : '~' + raw.charCodeAt(i).toString(16).toUpperCase().padStart(4, '0');
  }
  return out === '.' || out === '..' ? out.replaceAll('.', '~002E') : out;
}

export async function exists(path: string): Promise<boolean> {
  try { await fs.lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
export async function safePath(path: string, { missing = false, directory = false }: { missing?: boolean; directory?: boolean } = {}) {
  path = resolve(path);
  let current = parse(path).root;
  const parts = path.slice(current.length).split(sep).filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let st;
    try { st = await fs.lstat(current); }
    catch (e) { if (missing && (e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    if (st.isSymbolicLink()) throw new LocalizedError('error.refuseSymlink', { path: current });
    if (i < parts.length - 1 && !st.isDirectory()) throw new LocalizedError('error.notDirectory', { path: current });
    if (i === parts.length - 1) {
      assertOwner(current, st.uid);
      if (directory && !st.isDirectory()) throw new LocalizedError('error.notDirectory', { path: current });
    }
  }
}
export async function privateDir(path: string) {
  path = resolve(path);
  await safePath(path, { missing: true });
  const firstCreated = await mkdir(path);
  await safePath(path, { directory: true });
  await secureDir(path, firstCreated);
}
export async function atomicJSON(path: string, data: unknown) {
  await safePath(path, { missing: true });
  await privateDir(dirname(path));
  const started = await birth(process.pid);
  if (!started) throw new LocalizedError('error.writerIdentity');
  const temp = join(dirname(path), `.session-deletion-write-${process.pid}-${started}-${randomBytes(12).toString('hex')}`);
  let h;
  try {
    h = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await h.writeFile(JSON.stringify(data) + '\n');
    await h.sync(); await h.close(); h = undefined;
    await rename(temp, path);
    await syncDir(dirname(path));
  } finally { if (h) await h.close(); await fs.rm(temp, { force: true }); }
}
export async function readJSON<T>(path: string, fallback?: T): Promise<T> {
  try {
    await safePath(path);
    return JSON.parse(await fs.readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback as T;
    throw error;
  }
}
async function entries(path: string) {
  if (!(await exists(path))) return [];
  await safePath(path, { directory: true });
  return fs.readdir(path, { withFileTypes: true });
}
async function filesUnder(path: string): Promise<string[]> {
  const files: string[] = [];
  for (const e of await entries(path)) {
    const p = join(path, e.name);
    if (e.isSymbolicLink()) throw new LocalizedError('error.refuseSymlink', { path: p });
    if (e.isDirectory()) files.push(...await filesUnder(p));
    else if (e.isFile()) { await safePath(p); files.push(p); }
    else throw new LocalizedError('error.unexpectedEntry', { path: p });
  }
  return files;
}
function inside(root: string, path: string) {
  const r = relative(root, path);
  return r !== '' && r !== '..' && !r.startsWith('..' + sep) && !isAbsolute(r);
}
export async function removeOwned(path: string) {
  if (!(await exists(path))) return;
  await safePath(path);
  const st = await fs.lstat(path);
  if (st.isDirectory()) await filesUnder(path);
  else if (!st.isFile()) throw new LocalizedError('error.unexpectedFile', { path });
  await fs.rm(path, { recursive: st.isDirectory(), force: false });
  await syncDir(dirname(path));
}
const LOG = /^session(?:\.v([1-9]\d*))?\.jsonl(?:\.zstd)?$/;
const ATOMIC_TEMP = /^\.session-deletion-write-([1-9]\d*)-(\d+)-[a-f0-9]{24}$/;
export async function cleanAtomicTemps(directory: string) {
  for (const entry of await entries(directory)) {
    const owner = ATOMIC_TEMP.exec(entry.name);
    if (!owner || !entry.isFile()) continue;
    if (await birth(Number(owner[1])) === owner[2]) continue;
    try { await removeOwned(join(directory, entry.name)); }
    catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  }
}
const HASH = /(?:sha256:|[\\/](?:objects|file-objects|files)[\\/][a-f0-9]{2}[\\/])([a-f0-9]{64})(?![a-f0-9])/g;
function references(value: unknown, refs: Set<string>) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(HASH)) refs.add(match[1]);
  } else if (Array.isArray(value)) { for (const v of value) references(v, refs); }
  else if (value && typeof value === 'object') {
    for (const [key, entry] of Object.entries(value)) { references(key, refs); references(entry, refs); }
  }
}
// Node 24 stops at the first Zstandard frame within a write. Keep frames in
// separate chunks and prove that the final frame is complete before accepting EOF.
async function* zstdChunks(input: AsyncIterable<Buffer>) {
  const header = Buffer.alloc(4);
  let state = 'magic', need = 4, used = 0, skip = 0, checksum = 0;
  for await (const chunk of input) {
    let at = 0, start = 0;
    while (at < chunk.length) {
      if (skip) {
        const count = Math.min(skip, chunk.length - at); skip -= count; at += count;
      } else {
        const count = Math.min(need - used, chunk.length - at);
        chunk.copy(header, used, at, at + count); used += count; at += count;
        if (used < need) continue;
        used = 0;
        if (state === 'magic') {
          const magic = header.readUInt32LE();
          if (magic === 0xfd2fb528) { state = 'descriptor'; need = 1; }
          else if ((magic & 0xfffffff0) === 0x184d2a50) { state = 'skippable'; need = 4; }
          else throw new LocalizedError('error.invalidZstdFrame');
        } else if (state === 'descriptor') {
          const descriptor = header[0], single = descriptor & 32, size = descriptor >>> 6;
          skip = (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + (size ? 1 << size : single ? 1 : 0);
          checksum = descriptor & 4; state = 'block'; need = 3;
        } else if (state === 'skippable') {
          skip = header.readUInt32LE(); state = 'magic'; need = 4;
        } else {
          const block = header.readUIntLE(0, 3), type = (block >>> 1) & 3;
          if (type === 3) throw new LocalizedError('error.invalidZstdBlock');
          skip = type === 1 ? 1 : block >>> 3;
          if (block & 1) { skip += checksum; state = 'magic'; need = 4; }
        }
      }
      if (state === 'magic' && !skip) { yield chunk.subarray(start, at); start = at; }
    }
    if (start < chunk.length) yield chunk.subarray(start);
  }
  if (used || skip || state !== 'magic') throw new LocalizedError('error.incompleteZstdFrame');
}

export async function readLog(path: string, refs?: Set<string>) {
  await safePath(path);
  const input = createReadStream(path, { fd: openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), autoClose: true });
  const compressed = path.endsWith('.zstd');
  const source = compressed ? Readable.from(zstdChunks(input)) : input;
  const decoded = compressed ? source.pipe(createZstdDecompress()) : source;
  // Forward the source error; async iteration must never silently accept a truncated compressed stream.
  if (decoded !== source) source.on('error', e => decoded.destroy(e));
  const lines = createInterface({ input: decoded, crlfDelay: Infinity });
  let header: SessionHeader | undefined; let count = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { throw new LocalizedError('error.invalidJsonl', { path, record: count + 1 }); }
      if (count++ === 0) {
        if (record.type !== 'session' || typeof record.id !== 'string' || !Number.isFinite(record.createdAt))
          throw new LocalizedError('error.sessionHeaderUnsupported', { path });
        if (!Number.isInteger(record.version) || record.version < 0 || record.version > 4)
          throw new LocalizedError('error.sessionFormatUnsupported', { path });
        header = record;
        if (!refs) break;
      }
      if (refs) references(record, refs);
    }
    if (refs && decoded.errored) throw decoded.errored;
    if (!header) throw new LocalizedError('error.emptySessionLog', { path });
    return header;
  } catch (error) {
    throw new LocalizedError('error.readSessionLog', { path }, { cause: error, failures: [error] });
  } finally { lines.close(); decoded.destroy(); source.destroy(); input.destroy(); }
}

export async function scanSessions(home: string, refs = new Set<string>()) {
  const root = join(home, 'sessions');
  const sessions = new Map<string, { dir: string; createdAt: number }>();
  for (const file of await filesUnder(root)) {
    const leaf = basename(file);
    if (!/\.jsonl/i.test(leaf)) continue;
    if (!LOG.test(leaf) || relative(root, file).split(sep).length !== 3)
      throw new LocalizedError('error.unclassifiedBackup', { path: file });
    const header = await readLog(file, refs);
    const dir = dirname(file);
    if (basename(dir) !== encodeSegment(header.id)) throw new LocalizedError('error.directorySessionMismatch', { path: dir });
    const previous = sessions.get(header.id);
    if (previous && previous.dir !== dir) throw new LocalizedError('error.duplicateSession', { id: header.id });
    if (previous && previous.createdAt !== header.createdAt) throw new LocalizedError('error.mixedSessionIds', { path: dir });
    sessions.set(header.id, { dir, createdAt: header.createdAt });
  }
  return sessions;
}
export function familyOf(headers: ReadonlyMap<string, SessionHeader>, rootId: string) {
  const ids = new Set([rootId]); let changed = true;
  while (changed) {
    changed = false;
    for (const [id, h] of headers) {
      if (!ids.has(id) && h.parentSession !== undefined && ids.has(h.parentSession) && (h.origin === 'subagent' || (h.delegationDepth ?? 0) > 0)) {
        ids.add(id); changed = true;
      }
    }
  }
  return [...ids].sort();
}

/** Locate only the confirmed family's directories. No other transcript or attachment is read. */
export async function planSessionDeletion(home: string, headers: Map<string, SessionHeader>, rootId: string): Promise<DeletionPlan> {
  const ids = familyOf(headers, rootId);
  const names = new Map(ids.map(id => [encodeSegment(id), id]));
  const directories: DeletionPlan['directories'] = [];
  for (const project of await entries(join(home, 'sessions'))) {
    if (!project.isDirectory()) continue;
    for (const child of await entries(join(home, 'sessions', project.name))) {
      const id = names.get(child.name); if (!id) continue;
      const path = join('sessions', project.name, child.name);
      await safePath(join(home, path), { directory: true });
      const header = headers.get(id); if (!header) throw new LocalizedError('error.targetHeaderMissing');
      directories.push({ path, id, createdAt: header.createdAt });
    }
  }
  const plan = { ids, directories };
  validatePlan(home, rootId, plan);
  return plan;
}
function validatePlan(home: string, id: string, plan: DeletionPlan): void {
  const ids = new Set(plan.ids);
  if (!ids.has(id) || ids.size !== plan.ids.length || plan.directories.length !== ids.size
    || new Set(plan.directories.map(row => row.id)).size !== ids.size) throw new LocalizedError('error.invalidPlanIds');
  for (const row of plan.directories) {
    const path = resolve(home, row.path);
    const parts = relative(join(home, 'sessions'), path).split(sep);
    if (!ids.has(row.id) || !Number.isFinite(row.createdAt) || parts.length !== 2
      || !inside(join(home, 'sessions'), path) || basename(path) !== encodeSegment(row.id)) throw new LocalizedError('error.invalidPlanPath');
  }
}
export async function listRequests(home: string): Promise<DeletionRequest[]> {
  const out: DeletionRequest[] = [];
  for (const e of await entries(join(stateDir(home), 'pending'))) {
    if (ATOMIC_TEMP.test(e.name) && e.isFile()) continue;
    if (!/^[a-f0-9]{64}\.json$/.test(e.name)) throw new LocalizedError('error.pendingQueueFile');
    const r = await readJSON<DeletionRequest | undefined>(join(stateDir(home), 'pending', e.name));
    if (r === undefined) continue;
    if (r.schema !== 3 || digest(r.sessionId) + '.json' !== e.name || r.dshVersion !== SUPPORTED_DSH)
      throw new LocalizedError('error.invalidDeletionRequest');
    validatePlan(home, r.sessionId, r.plan);
    out.push(r);
  }
  return out;
}
export async function enqueue(home: string, header: SessionHeader, plan: DeletionPlan) {
  await safePath(home, { directory: true });
  validatePlan(home, header.id, plan);
  if (plan.directories.find(row => row.id === header.id)?.createdAt !== header.createdAt) throw new LocalizedError('error.targetLifecycleMismatch');
  const path = requestPath(home, header.id);
  if (await exists(path)) throw new LocalizedError('error.deletionAlreadyQueued');
  const request: DeletionRequest = { schema: 3, dshVersion: SUPPORTED_DSH, sessionId: header.id,
    createdAt: header.createdAt, queuedAt: new Date().toISOString(), plan };
  await atomicJSON(path, request);
  return request;
}

/** Only target bookkeeping is examined; unrelated logs/projections can keep changing. */
async function privateInventory(home: string, ids: ReadonlySet<string>) {
  const rewrite: Edit[] = []; const remove: string[] = [];
  const projections = join(home, 'storages/session_projcache/sessions');
  const names = [...ids].map(id => encodeSegment(id) + '.json');
  for (const entry of await entries(projections)) if (names.some(name => entry.name === name || entry.name.startsWith(name + '.bak.'))) {
    const path = join(projections, entry.name); await safePath(path); remove.push(path);
  }
  const workspacePath = join(home, 'storages/workspace.json');
  const workspace = await readJSON<WorkspaceData | undefined>(workspacePath);
  if (workspace) {
    if (workspace.unit?.name !== 'workspace' || !workspace.global || !workspace.tables?.workspaces) throw new LocalizedError('error.workspaceSchema');
    let changed = false;
    for (const key of ['archivedSessionIds', 'pinnedSessionIds'] as const) {
      if (!Array.isArray(workspace.global[key])) throw new LocalizedError('error.workspaceSessionsInvalid');
      const kept = workspace.global[key].filter(id => !ids.has(id));
      changed ||= kept.length !== workspace.global[key].length; workspace.global[key] = kept;
    }
    const detach: [string, string][] = [];
    for (const [workspaceId, row] of Object.entries(workspace.tables.workspaces)) {
      if (!Array.isArray(row.sessionIds)) throw new LocalizedError('error.workspaceSessionsInvalid');
      row.sessionIds = row.sessionIds.filter(id => {
        if (!ids.has(id)) return true;
        detach.push([workspaceId, id]); return false;
      });
    }
    if (changed || detach.length) rewrite.push({ path: workspacePath, data: workspace, detach });
  }
  const schedulePath = join(home, 'storages/schedule.json');
  const schedule = await readSchedule(home);
  if (schedule) {
    let changed = false;
    for (const [key, task] of Object.entries(schedule.tables.tasks)) if (ids.has(scheduledSession(task)!)) { delete schedule.tables.tasks[key]; changed = true; }
    if (changed) rewrite.push({ path: schedulePath, data: schedule });
  }
  return { rewrite, remove };
}
async function validateTargetDirectories(home: string, plan: DeletionPlan) {
  for (const row of plan.directories) {
    const dir = join(home, row.path);
    await safePath(dir, { missing: true });
    for (const file of await filesUnder(dir)) if (LOG.test(basename(file))) {
      const header = await readLog(file);
      if (header.id !== row.id || header.createdAt !== row.createdAt) throw new LocalizedError('error.identityChangedDuringRecovery');
    }
  }
}
/** Caller holds lifecycle and target writer locks. This function never scans or deletes attachments. */
export async function sweep(home: string, { failAfter, hooks }: { failAfter?: number; hooks?: SweepHooks } = {}) {
  await safePath(home, { directory: true });
  let operations = 0;
  const checkpoint = () => { if (failAfter !== undefined && ++operations >= failAfter) throw new LocalizedError('error.injectedInterruption'); };
  const completed: Result[] = [];
  for (const request of (await listRequests(home)).filter(r => !hooks?.onlySessionId || r.sessionId === hooks.onlySessionId)) {
    const plan = request.plan; const ids = new Set(plan.ids);
    await validateTargetDirectories(home, plan);
    const work = await privateInventory(home, ids);
    checkpoint();
    for (const edit of work.rewrite) {
      if (hooks?.applyEdit) await hooks.applyEdit(edit, ids); else await atomicJSON(edit.path, edit.data);
      checkpoint();
    }
    for (const path of work.remove) { await removeOwned(path); checkpoint(); }
    for (const row of plan.directories) { await removeOwned(join(home, row.path)); checkpoint(); }
    const audit = await privateInventory(home, ids);
    if (audit.remove.length || audit.rewrite.length) throw new LocalizedError('error.privateMetadataAudit');
    for (const row of plan.directories) if (await exists(join(home, row.path))) throw new LocalizedError('error.deletedSessionAudit');
    // Do not prune the shared project directory: another conversation may be creating its first log.
    const receiptPath = join(stateDir(home), 'receipt.json');
    const receipt = await readJSON<Receipt>(receiptPath, { schema: 1, revision: '', deletedIdHashes: [] });
    receipt.deletedIdHashes = [...new Set([...receipt.deletedIdHashes, ...plan.ids.map(digest)])];
    receipt.revision = randomBytes(16).toString('hex');
    receipt.lastCompletedAt = new Date().toISOString(); receipt.lastResult = { sessions: ids.size };
    await atomicJSON(receiptPath, receipt);
    hooks?.receiptCommitted?.(receipt); checkpoint();
    await removeOwned(requestPath(home, request.sessionId)); checkpoint();
    completed.push(receipt.lastResult);
  }
  // Only our request temporaries can be stale here. Never touch active storage or attachment writers.
  await cleanAtomicTemps(join(stateDir(home), 'pending'));
  await atomicJSON(join(stateDir(home), 'status.json'), { schema: 1, state: 'clean', checkedAt: new Date().toISOString(), completed: completed.length });
  return completed;
}

/** Bound read-only I/O so large attachment stores do not flood the filesystem queue. */
async function forEachConcurrent<T>(values: readonly T[], work: (value: T) => Promise<void>): Promise<void> {
  let next = 0;
  let failure: { reason: unknown } | undefined;
  await Promise.all(Array.from({ length: Math.min(16, values.length) }, async () => {
    for (let i = next++; i < values.length && !failure; i = next++) {
      try { await work(values[i]); } catch (reason) { failure ??= { reason }; }
    }
  }));
  if (failure) throw failure.reason;
}

async function scanGarbage(home: string, { snapshots, UploadIndex }: GcSources) {
  if ((await listRequests(home)).length) throw new LocalizedError('error.gcPendingSessions');
  const refs = new Set<string>();
  for (const live of snapshots ?? []) references(live, refs);
  await scanSessions(home, refs);
  await forEachConcurrent(await filesUnder(join(home, 'storages')), async path => {
    if (ATOMIC_TEMP.test(basename(path))) return;
    if (!path.endsWith('.json') && !/\.json\.bak\./.test(path)) throw new LocalizedError('error.gcUnclassifiedStorage', { path });
    references(await readJSON(path), refs);
  });
  const candidates: { path: string; kind: string; files: string[] }[] = [];
  const garbage = new Set<string>();
  await forEachConcurrent(['objects', 'file-objects', 'files'], async kind => {
    const root = join(home, 'attachments/v1', kind);
    await forEachConcurrent(await entries(root), async prefix => {
      if (!/^[a-f0-9]{2}$/.test(prefix.name) || !prefix.isDirectory()) throw new LocalizedError('error.attachmentShard', { path: join(root, prefix.name) });
      for (const entry of await entries(join(root, prefix.name))) {
        const hash = entry.name; const path = join(root, prefix.name, hash);
        if (!/^[a-f0-9]{64}$/.test(hash) || hash.slice(0, 2) !== prefix.name) throw new LocalizedError('error.attachmentObject', { path });
        await safePath(path);
        if (kind === 'files' ? !entry.isDirectory() : !entry.isFile()) throw new LocalizedError('error.attachmentObjectType', { path });
        const files = kind === 'files' ? await filesUnder(path) : [path];
        if (!refs.has(hash)) { candidates.push({ path, kind, files }); garbage.add(hash); }
      }
    });
  });
  const cache = join(home, 'cache/attachments/request-images');
  const cacheFiles = await filesUnder(cache);
  const uploadPath = join(home, 'llm-deepseek/files-v3.json');
  const upload = await readJSON<RemoteCache | undefined>(uploadPath);
  const index = UploadIndex && new UploadIndex(uploadPath);
  const stale: UploadRecord[] = [];
  if (upload !== undefined) {
    if (upload?.formatVersion !== 3 || !Array.isArray(upload.records)) throw new LocalizedError('error.fileCacheSchema');
    const records = index ? (await index.load()).records : upload.records;
    // rc.5 returns an empty list for malformed records and duplicate variants.
    if (records.length !== upload.records.length) throw new LocalizedError('error.fileCacheSchema');
    upload.records = records.filter(record => {
      if (!/^sha256:[a-f0-9]{64}$/.test(record.attachmentId)) throw new LocalizedError('error.uploadAttachmentId');
      const hash = record.attachmentId.slice(7);
      if (refs.has(hash)) return true;
      garbage.add(hash); stale.push(record); return false;
    });
  }
  return { candidates, garbage, cache, cacheFiles, uploadPath, upload, index, stale };
}

/** Read-only estimate using the same reference checks as the actual collection. */
export async function garbageSize(home: string, sources: GcSources = {}): Promise<number> {
  const { candidates, cacheFiles } = await scanGarbage(home, sources);
  const links = new Map<string, bigint>(); let bytes = 0;
  await forEachConcurrent([...candidates.flatMap(candidate => candidate.files), ...cacheFiles], async path => {
    const st = await fs.lstat(path, { bigint: true });
    // A surviving hard link (including a DSH temp file) keeps the content on disk.
    const key = `${st.dev}:${st.ino}`;
    const count = (links.get(key) ?? 0n) + 1n;
    links.set(key, count);
    if (count === st.nlink) bytes += Number(st.size);
  });
  return bytes;
}

/** Explicit, globally quiescent mark/sweep. Interrupted GC is rescanned, never replayed from a stale manifest. */
export async function collectGarbage(home: string, { failAfter, ...sources }: GcSources & { failAfter?: number } = {}): Promise<GcResult> {
  // Complete preflight before the first destructive operation; never reuse a size preview.
  const { candidates, garbage, cache, cacheFiles, uploadPath, upload, index, stale } = await scanGarbage(home, sources);
  let operations = 0;
  const checkpoint = () => { if (failAfter !== undefined && ++operations >= failAfter) throw new LocalizedError('error.injectedGcInterruption'); };
  if (stale.length) {
    if (index) {
      for (const [scope, records] of Map.groupBy(stale, record => record.scope)) await index.remove(scope, records);
    } else await atomicJSON(uploadPath, upload);
    const remaining = await readJSON<RemoteCache | undefined>(uploadPath);
    if (remaining?.records.some(record => garbage.has(record.attachmentId.slice(7)))) throw new LocalizedError('error.uploadIndexAudit');
    checkpoint();
  }
  // Count one attachment identity once, regardless of its objects, aliases or
  // upload mappings. Derived cache files are separate reclaimed items.
  const result: GcResult = { total: garbage.size + cacheFiles.length, objects: 0, fileLinks: 0, cacheFiles: cacheFiles.length, uploadMappings: stale.length };
  for (const candidate of candidates) {
    await removeOwned(candidate.path);
    if (candidate.kind === 'files') result.fileLinks += candidate.files.length; else result.objects++;
    checkpoint();
  }
  if (await exists(cache)) { await removeOwned(cache); checkpoint(); }
  for (const { path } of candidates) if (await exists(path)) throw new LocalizedError('error.attachmentAudit');
  if (await exists(cache)) throw new LocalizedError('error.cacheAudit');
  await atomicJSON(join(stateDir(home), 'gc.json'), { completedAt: new Date().toISOString(), ...result });
  return result;
}
