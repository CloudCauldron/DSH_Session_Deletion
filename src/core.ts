import * as fs from 'node:fs/promises';
import { createReadStream, openSync, constants } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';
import { createInterface } from 'node:readline';
import { Readable } from 'node:stream';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve, dirname, basename, relative, sep, parse, isAbsolute } from 'node:path';
import { assertOwner, mkdir, secureDir, syncDir, rename, birth } from './platform/index.js';
import { LocalizedError } from './locale.js';

export interface SessionHeader {
  type?: 'session'; version: number; id: string; createdAt: number; cwd?: string;
  parentSession?: string; origin?: 'subagent'; delegationDepth?: number; isSeeded?: boolean;
}
export interface References { hashes: Set<string> }
export interface StoredSession { header: SessionHeader; dir: string; refs: References }
export type SessionMap = Map<string, StoredSession>;
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
interface RemoteCache { formatVersion: number; records: { attachmentId: string }[] }
interface Edit { path: string; data: unknown }
export interface LiveSnapshot { header: SessionHeader; events: readonly unknown[] }
export interface SweepHooks {
  /** Live owners mutate their own tables, never overwrite them from a disk snapshot. */
  applyEdit?(edit: Edit, ids: ReadonlySet<string>): Promise<void>;
  receiptCommitted?(receipt: Receipt): void;
  onlySessionId?: string;
}
export interface GcHooks {
  snapshots?(): Promise<Map<string, LiveSnapshot>>;
  removeUploadMappings?(hashes: ReadonlySet<string>): Promise<void>;
}

export const SUPPORTED_DSH = '0.2.2-rc.2';
export const STATE_NAME = 'session-deletion';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const stateDir = (home: string) => join(home, STATE_NAME);
export const requestPath = (home: string, id: string) => join(stateDir(home), 'pending', digest(id) + '.json');
/** DSH's explicit destination wins over the legacy session binding. */
export function scheduledSession(task: ScheduleTask): string | undefined {
  if (task.target?.kind === 'new') return undefined;
  if (task.target) {
    if (!['session', 'new_once'].includes(task.target.kind)) throw LocalizedError.english('error.scheduleDestination');
    if (task.target.sessionId) return task.target.sessionId;
    if (task.target.kind !== 'new_once') throw LocalizedError.english('error.scheduleDestination');
  } else if (task.sessionId) return task.sessionId;
  return task.record ? 'session-schedule-' + digest(task.record.id) : undefined;
}
export async function readSchedule(home: string): Promise<ScheduleData | undefined> {
  const schedule = await readJSON<ScheduleData | undefined>(join(home, 'storages/schedule.json'));
  if (schedule && (schedule.unit?.name !== 'schedule' || !schedule.tables?.tasks)) throw LocalizedError.english('error.scheduleSchema');
  return schedule;
}
export function encodeSegment(raw: string) {
  if (typeof raw !== 'string' || !raw || raw.length > 1024) throw LocalizedError.english('error.invalidSessionId');
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
    if (st.isSymbolicLink()) throw LocalizedError.english('error.refuseSymlink', { path: current });
    if (i < parts.length - 1 && !st.isDirectory()) throw LocalizedError.english('error.notDirectory', { path: current });
    if (i === parts.length - 1) {
      assertOwner(current, st.uid);
      if (directory && !st.isDirectory()) throw LocalizedError.english('error.notDirectory', { path: current });
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
  if (!started) throw LocalizedError.english('error.writerIdentity');
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
    if (e.isSymbolicLink()) throw LocalizedError.english('error.refuseSymlink', { path: p });
    if (e.isDirectory()) files.push(...await filesUnder(p));
    else if (e.isFile()) { await safePath(p); files.push(p); }
    else throw LocalizedError.english('error.unexpectedEntry', { path: p });
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
  else if (!st.isFile()) throw LocalizedError.english('error.unexpectedFile', { path });
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
function references(value: unknown, refs: References) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(HASH)) refs.hashes.add(match[1]);
  } else if (Array.isArray(value)) { for (const v of value) references(v, refs); }
  else if (value && typeof value === 'object') { for (const v of Object.values(value)) references(v, refs); }
}
const newRefs = (): References => ({ hashes: new Set() });

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
          else throw LocalizedError.english('error.invalidZstdFrame');
        } else if (state === 'descriptor') {
          const descriptor = header[0], single = descriptor & 32, size = descriptor >>> 6;
          skip = (single ? 0 : 1) + [0, 1, 2, 4][descriptor & 3] + (size ? 1 << size : single ? 1 : 0);
          checksum = descriptor & 4; state = 'block'; need = 3;
        } else if (state === 'skippable') {
          skip = header.readUInt32LE(); state = 'magic'; need = 4;
        } else {
          const block = header.readUIntLE(0, 3), type = (block >>> 1) & 3;
          if (type === 3) throw LocalizedError.english('error.invalidZstdBlock');
          skip = type === 1 ? 1 : block >>> 3;
          if (block & 1) { skip += checksum; state = 'magic'; need = 4; }
        }
      }
      if (state === 'magic' && !skip) { yield chunk.subarray(start, at); start = at; }
    }
    if (start < chunk.length) yield chunk.subarray(start);
  }
  if (used || skip || state !== 'magic') throw LocalizedError.english('error.incompleteZstdFrame');
}

export async function readLog(path: string, headerOnly = false) {
  await safePath(path);
  const input = createReadStream(path, { fd: openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), autoClose: true });
  const compressed = path.endsWith('.zstd');
  const source = compressed ? Readable.from(zstdChunks(input)) : input;
  const decoded = compressed ? source.pipe(createZstdDecompress()) : source;
  // Forward the source error; async iteration must never silently accept a truncated compressed stream.
  if (decoded !== source) source.on('error', e => decoded.destroy(e));
  const lines = createInterface({ input: decoded, crlfDelay: Infinity });
  const refs = newRefs(); let header: SessionHeader | undefined; let count = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { throw LocalizedError.english('error.invalidJsonl', { path, record: count + 1 }); }
      if (count++ === 0) {
        if (record.type !== 'session' || typeof record.id !== 'string' || !Number.isFinite(record.createdAt))
          throw LocalizedError.english('error.sessionHeaderUnsupported', { path });
        if (!Number.isInteger(record.version) || record.version < 0 || record.version > 4)
          throw LocalizedError.english('error.sessionFormatUnsupported', { path });
        header = record;
        if (headerOnly) break;
      }
      references(record, refs);
    }
    if (!headerOnly && decoded.errored) throw decoded.errored;
    if (!header) throw LocalizedError.english('error.emptySessionLog', { path });
    return { header, refs };
  } catch (error) {
    throw LocalizedError.english('error.readSessionLog', { path }, { cause: error, failures: [error] });
  } finally { lines.close(); decoded.destroy(); source.destroy(); input.destroy(); }
}

export async function scanSessions(home: string, snapshots?: Map<string, LiveSnapshot>): Promise<SessionMap> {
  const root = join(home, 'sessions'); const sessions: SessionMap = new Map();
  const liveByDirectory = new Map([...snapshots?.values() ?? []].map(s => [encodeSegment(s.header.id), s]));
  for (const project of await entries(root)) {
    if (!project.isDirectory()) {
      if (project.isSymbolicLink()) throw LocalizedError.english('error.symlinkUnderSessions');
      continue;
    }
    for (const directory of await entries(join(root, project.name))) {
      if (!directory.isDirectory()) {
        if (directory.isSymbolicLink()) throw LocalizedError.english('error.symlinkSessionDir');
        continue;
      }
      const dir = join(root, project.name, directory.name);
      const logFiles = (await entries(dir)).filter(e => LOG.test(e.name));
      if (!logFiles.length) continue;
      let selected: SessionHeader | undefined; const refs = newRefs();
      for (const log of logFiles) {
        const candidate = liveByDirectory.get(directory.name);
        const live = candidate && log.name === `session.v${candidate.header.version}.jsonl.zstd` ? candidate : undefined;
        let parsed: { header: SessionHeader; refs: References };
        if (live) {
          const liveRefs = newRefs(); references(live.header, liveRefs);
          for (const event of live.events) references(event, liveRefs);
          parsed = { header: live.header, refs: liveRefs };
        } else parsed = await readLog(join(dir, log.name));
        if (directory.name !== encodeSegment(parsed.header.id)) throw LocalizedError.english('error.directorySessionMismatch', { path: dir });
        if (selected && (selected.id !== parsed.header.id || selected.createdAt !== parsed.header.createdAt))
          throw LocalizedError.english('error.mixedSessionIds', { path: dir });
        if (!selected || parsed.header.version > selected.version) selected = parsed.header;
        for (const h of parsed.refs.hashes) refs.hashes.add(h);
      }
      // Retained backup generations can contain additional attachments or spill references.
      for (const file of await filesUnder(dir)) {
        const leaf = basename(file);
        if (LOG.test(leaf) || leaf === 'session.lock') continue;
        if (/\.jsonl(?:\.zstd)?(?:\.|$)/.test(leaf)) {
          // Unknown damaged/backup encodings must not be assumed to contain no references.
          throw LocalizedError.english('error.unclassifiedBackup', { path: file });
        }
      }
      if (!selected) throw LocalizedError.english('error.sessionHeaderMissing');
      if (sessions.has(selected.id)) throw LocalizedError.english('error.duplicateSession', { id: selected.id });
      sessions.set(selected.id, { header: selected, dir, refs });
    }
  }
  // A newly created live session can already reference an attachment before
  // its first buffered write materializes a directory. It is a reference
  // owner too; never infer exclusivity only from the current disk listing.
  for (const [id, live] of snapshots ?? []) if (!sessions.has(id)) {
    const refs = newRefs(); references(live.header, refs);
    for (const event of live.events) references(event, refs);
    sessions.set(id, { header: live.header, dir: '', refs });
  }
  return sessions;
}
export function familyOf(sessions: SessionMap, rootId: string) {
  const ids = new Set([rootId]); let changed = true;
  while (changed) {
    changed = false;
    for (const [id, item] of sessions) {
      const h = item.header;
      if (!ids.has(id) && h.parentSession !== undefined && ids.has(h.parentSession) && (h.origin === 'subagent' || (h.delegationDepth ?? 0) > 0)) {
        ids.add(id); changed = true;
      }
    }
  }
  return ids;
}

/** Locate only the confirmed family's directories. No other transcript or attachment is read. */
export async function planSessionDeletion(home: string, headers: Map<string, SessionHeader>, rootId: string): Promise<DeletionPlan> {
  const ids = [...familyOf(new Map([...headers].map(([id, header]) => [id, { header }])) as SessionMap, rootId)].sort();
  const names = new Map(ids.map(id => [encodeSegment(id), id]));
  const directories: DeletionPlan['directories'] = [];
  for (const project of await entries(join(home, 'sessions'))) {
    if (!project.isDirectory()) continue;
    for (const child of await entries(join(home, 'sessions', project.name))) {
      const id = names.get(child.name); if (!id) continue;
      const path = join('sessions', project.name, child.name);
      await safePath(join(home, path), { directory: true });
      const header = headers.get(id); if (!header) throw LocalizedError.english('error.targetHeaderMissing');
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
    || new Set(plan.directories.map(row => row.id)).size !== ids.size) throw LocalizedError.english('error.invalidPlanIds');
  for (const row of plan.directories) {
    const path = resolve(home, row.path);
    const parts = relative(join(home, 'sessions'), path).split(sep);
    if (!ids.has(row.id) || !Number.isFinite(row.createdAt) || parts.length !== 2
      || !inside(join(home, 'sessions'), path) || basename(path) !== encodeSegment(row.id)) throw LocalizedError.english('error.invalidPlanPath');
  }
}
export async function listRequests(home: string): Promise<DeletionRequest[]> {
  const out: DeletionRequest[] = [];
  for (const e of await entries(join(stateDir(home), 'pending'))) {
    if (ATOMIC_TEMP.test(e.name) && e.isFile()) continue;
    if (!/^[a-f0-9]{64}\.json$/.test(e.name)) throw LocalizedError.english('error.pendingQueueFile');
    const r = await readJSON<DeletionRequest | undefined>(join(stateDir(home), 'pending', e.name));
    if (r === undefined) continue;
    if (r.schema !== 3 || digest(r.sessionId) + '.json' !== e.name || r.dshVersion !== SUPPORTED_DSH)
      throw LocalizedError.english('error.invalidDeletionRequest');
    validatePlan(home, r.sessionId, r.plan);
    out.push(r);
  }
  return out;
}
export async function enqueue(home: string, header: SessionHeader, plan: DeletionPlan) {
  await safePath(home, { directory: true });
  validatePlan(home, header.id, plan);
  if (plan.directories.find(row => row.id === header.id)?.createdAt !== header.createdAt) throw LocalizedError.english('error.targetLifecycleMismatch');
  const path = requestPath(home, header.id);
  if (await exists(path)) throw LocalizedError.english('error.deletionAlreadyQueued');
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
    if (workspace.unit?.name !== 'workspace' || !workspace.global || !workspace.tables?.workspaces) throw LocalizedError.english('error.workspaceSchema');
    let changed = false;
    for (const key of ['archivedSessionIds', 'pinnedSessionIds'] as const) {
      if (!Array.isArray(workspace.global[key])) throw LocalizedError.english('error.workspaceSessionsInvalid');
      const kept = workspace.global[key].filter(id => !ids.has(id));
      changed ||= kept.length !== workspace.global[key].length; workspace.global[key] = kept;
    }
    for (const row of Object.values(workspace.tables.workspaces)) {
      if (!Array.isArray(row.sessionIds)) throw LocalizedError.english('error.workspaceSessionsInvalid');
      const kept = row.sessionIds.filter(id => !ids.has(id));
      changed ||= kept.length !== row.sessionIds.length; row.sessionIds = kept;
    }
    if (changed) rewrite.push({ path: workspacePath, data: workspace });
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
      const { header } = await readLog(file, true);
      if (header.id !== row.id || header.createdAt !== row.createdAt) throw LocalizedError.english('error.identityChangedDuringRecovery');
    }
  }
}
/** Caller holds lifecycle and target writer locks. This function never scans or deletes attachments. */
export async function sweep(home: string, { failAfter, hooks }: { failAfter?: number; hooks?: SweepHooks } = {}) {
  await safePath(home, { directory: true });
  let operations = 0;
  const checkpoint = () => { if (failAfter !== undefined && ++operations >= failAfter) throw LocalizedError.english('error.injectedInterruption'); };
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
    if (audit.remove.length || audit.rewrite.length) throw LocalizedError.english('error.privateMetadataAudit');
    for (const row of plan.directories) if (await exists(join(home, row.path))) throw LocalizedError.english('error.deletedSessionAudit');
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

async function scanGarbage(home: string, snapshots?: GcHooks['snapshots']) {
  if ((await listRequests(home)).length) throw LocalizedError.english('error.gcPendingSessions');
  const sessions = await scanSessions(home, await snapshots?.());
  const refs = newRefs();
  for (const session of sessions.values()) for (const hash of session.refs.hashes) refs.hashes.add(hash);
  await forEachConcurrent(await filesUnder(join(home, 'storages')), async path => {
    if (ATOMIC_TEMP.test(basename(path))) return;
    if (!path.endsWith('.json') && !/\.json\.bak\./.test(path)) throw LocalizedError.english('error.gcUnclassifiedStorage', { path });
    references(await readJSON(path), refs);
  });
  const candidates: { path: string; kind: string; files: string[] }[] = [];
  const garbage = new Set<string>();
  await forEachConcurrent(['objects', 'file-objects', 'files'], async kind => {
    const root = join(home, 'attachments/v1', kind);
    await forEachConcurrent(await entries(root), async prefix => {
      if (!/^[a-f0-9]{2}$/.test(prefix.name) || !prefix.isDirectory()) throw LocalizedError.english('error.attachmentShard', { path: join(root, prefix.name) });
      for (const entry of await entries(join(root, prefix.name))) {
        const hash = entry.name; const path = join(root, prefix.name, hash);
        if (!/^[a-f0-9]{64}$/.test(hash) || hash.slice(0, 2) !== prefix.name) throw LocalizedError.english('error.attachmentObject', { path });
        await safePath(path);
        if (kind === 'files' ? !entry.isDirectory() : !entry.isFile()) throw LocalizedError.english('error.attachmentObjectType', { path });
        const files = kind === 'files' ? await filesUnder(path) : [path];
        if (!refs.hashes.has(hash)) { candidates.push({ path, kind, files }); garbage.add(hash); }
      }
    });
  });
  const cache = join(home, 'cache/attachments/request-images');
  const cacheFiles = await filesUnder(cache);
  const uploadPath = join(home, 'llm-deepseek/files-v3.json');
  const upload = await readJSON<RemoteCache | undefined>(uploadPath);
  let uploadMappings = 0;
  if (upload) {
    if (upload.formatVersion !== 3 || !Array.isArray(upload.records)) throw LocalizedError.english('error.fileCacheSchema');
    upload.records = upload.records.filter(record => {
      if (!/^sha256:[a-f0-9]{64}$/.test(record.attachmentId)) throw LocalizedError.english('error.uploadAttachmentId');
      const hash = record.attachmentId.slice(7);
      if (refs.hashes.has(hash)) return true;
      garbage.add(hash); uploadMappings++; return false;
    });
  }
  return { candidates, garbage, cache, cacheFiles, uploadPath, upload, uploadMappings };
}

/** Read-only estimate using the same reference checks as the actual collection. */
export async function garbageSize(home: string, snapshots?: GcHooks['snapshots']): Promise<number> {
  const { candidates, cacheFiles } = await scanGarbage(home, snapshots);
  const seen = new Set<string>(); let bytes = 0;
  await forEachConcurrent([...candidates.flatMap(candidate => candidate.files), ...cacheFiles], async path => {
    const st = await fs.lstat(path, { bigint: true });
    // DSH's file aliases are hard links; count their shared content only once.
    const key = `${st.dev}:${st.ino}`;
    if (!seen.has(key)) { seen.add(key); bytes += Number(st.size); }
  });
  return bytes;
}

/** Explicit, globally quiescent mark/sweep. Interrupted GC is rescanned, never replayed from a stale manifest. */
export async function collectGarbage(home: string, { hooks, failAfter }: { hooks?: GcHooks; failAfter?: number } = {}): Promise<GcResult> {
  // Complete preflight before the first destructive operation; never reuse a size preview.
  const { candidates, garbage, cache, cacheFiles, uploadPath, upload, uploadMappings } = await scanGarbage(home, hooks?.snapshots);
  let operations = 0;
  const checkpoint = () => { if (failAfter !== undefined && ++operations >= failAfter) throw LocalizedError.english('error.injectedGcInterruption'); };
  if (uploadMappings) {
    if (hooks?.removeUploadMappings) await hooks.removeUploadMappings(garbage);
    else await atomicJSON(uploadPath, upload);
    checkpoint();
  }
  // Count one attachment identity once, regardless of its objects, aliases or
  // upload mappings. Derived cache files are separate reclaimed items.
  const result: GcResult = { total: garbage.size + cacheFiles.length, objects: 0, fileLinks: 0, cacheFiles: cacheFiles.length, uploadMappings };
  for (const candidate of candidates) {
    await removeOwned(candidate.path);
    if (candidate.kind === 'files') result.fileLinks += candidate.files.length; else result.objects++;
    checkpoint();
  }
  if (await exists(cache)) { await removeOwned(cache); checkpoint(); }
  for (const { path } of candidates) if (await exists(path)) throw LocalizedError.english('error.attachmentAudit');
  if (await exists(cache)) throw LocalizedError.english('error.cacheAudit');
  const remaining = await readJSON<RemoteCache | undefined>(uploadPath);
  if (remaining?.records.some(record => garbage.has(record.attachmentId.slice(7)))) throw LocalizedError.english('error.uploadIndexAudit');
  await atomicJSON(join(stateDir(home), 'gc.json'), { completedAt: new Date().toISOString(), ...result });
  return result;
}
