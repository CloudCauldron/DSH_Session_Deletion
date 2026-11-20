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
interface SessionDirectory { path: string; id: string; createdAt: number }
interface Transcript { path: string; sizeBytes: number; sha256: string }
export interface SessionStat { header: SessionHeader; sizeBytes?: number; location?: { kind: string; path: string } }
export interface DeletionPlan<T extends SessionDirectory = SessionDirectory> {
  ids: string[]; directories: T[];
}
export interface DeletionRequest {
  schema: 1; dshVersion: string; sessionId: string; createdAt: number; queuedAt: string;
  plan: DeletionPlan<SessionDirectory & { transcript: Transcript }>;
}
export interface Result { sessions: number }
export interface GcResult { total: number; objects: number; fileLinks: number; cacheFiles: number; uploadMappings: number }
export interface Receipt { schema: 1; revision: string; deletedIdHashes: string[]; lastCompletedAt?: string; lastResult?: Result }
interface WorkspaceData {
  unit: { name: string; version: number };
  global?: { archivedSessionIds?: string[]; pinnedSessionIds?: string[] } | null;
  tables: { workspaces: Record<string, { sessionIds: string[] }> };
}
export interface ScheduleTask {
  sessionId?: string;
  target?: { kind: 'session' | 'new_once' | 'new'; sessionId?: string };
  record?: { id: string };
  pendingDelivery?: { targetSessionId: string };
}
interface ScheduleData { unit: { name: string; version: number }; tables: { tasks: Record<string, ScheduleTask> } }
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
  onlySessionId: string;
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
function isRecord(value: unknown): boolean {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
function validTable(tables: Record<string, unknown>, key: string) {
  return isRecord(tables) && (tables[key] === undefined || isRecord(tables[key]));
}
/** DSH's explicit destination wins over the legacy session binding. */
export function scheduledSession(task: ScheduleTask): string | undefined {
  if (!isRecord(task)) throw new LocalizedError('error.scheduleDestination');
  const target = task.target;
  if (target?.kind === 'new' && target.sessionId === undefined) return undefined;
  if (target !== undefined && !['new_once', 'session'].includes(target?.kind)) throw new LocalizedError('error.scheduleDestination');
  const id = target === undefined ? task.sessionId : target.sessionId;
  if (typeof id === 'string' && id) return id;
  if (id !== undefined || target?.kind === 'session') throw new LocalizedError('error.scheduleDestination');
  if (task.record === undefined) return undefined; // A live creation request may not have its schedule ID yet.
  if (typeof task.record?.id !== 'string' || !task.record.id) throw new LocalizedError('error.scheduleDestination');
  return 'session-schedule-' + digest(task.record.id);
}
export async function readSchedule(home: string): Promise<ScheduleData | undefined> {
  const schedule = await readJSON<ScheduleData | undefined>(join(home, 'storages/schedule.json'));
  if (schedule !== undefined) {
    if (schedule?.unit?.name !== 'schedule' || ![1, 2].includes(schedule.unit.version) || !validTable(schedule.tables, 'tasks'))
      throw new LocalizedError('error.scheduleSchema');
    schedule.tables.tasks ??= {};
  }
  return schedule;
}
function escapeSegment(raw: string) {
  return raw.replace(/[^A-Za-z0-9._-]/g, c => '~' + c.charCodeAt(0).toString(16).toUpperCase().padStart(4, '0'));
}
export function encodeSegment(raw: string) {
  if (typeof raw !== 'string' || !raw || raw.length > 1024) throw new LocalizedError('error.invalidSessionId');
  const out = escapeSegment(raw);
  return out === '.' || out === '..' ? out.replaceAll('.', '~002E') : out;
}
/** rc.5's JSONL project directory for a stored header's working directory. */
export function projectKey(cwd: string | undefined) {
  if (cwd === undefined) return '_no-cwd';
  const slug = escapeSegment(cwd.replace(/[\\/:]+/g, '-')).replace(/^-+/, '') || 'root';
  return '--' + slug.slice(0, 251) + '--';
}

export async function exists(path: string): Promise<boolean> {
  try { await fs.lstat(path); return true; } catch (e) { if ((e as NodeJS.ErrnoException).code === 'ENOENT') return false; throw e; }
}
export async function safePath(path: string, { missing = false, directory = false, file = false }: { missing?: boolean; directory?: boolean; file?: boolean } = {}) {
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
      if (file && !st.isFile()) throw new LocalizedError('error.unexpectedFile', { path: current });
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
    await safePath(path, { file: true });
    return JSON.parse(await fs.readFile(path, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return fallback as T;
    throw error;
  }
}
export async function readReceipt(home: string): Promise<Receipt> {
  const receipt = await readJSON<Receipt>(join(stateDir(home), 'receipt.json'), { schema: 1, revision: '', deletedIdHashes: [] });
  if (receipt?.schema !== 1 || typeof receipt.revision !== 'string' || !Array.isArray(receipt.deletedIdHashes)
    || !receipt.deletedIdHashes.every(hash => typeof hash === 'string' && /^[a-f0-9]{64}$/.test(hash)))
    throw new LocalizedError('error.receiptSchema');
  return receipt;
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
async function* zstdChunks(input: AsyncIterable<Buffer>, firstFrameOnly = false) {
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
          if (firstFrameOnly && (descriptor & 0x18)) throw new LocalizedError('error.invalidZstdFrame');
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
      if (state === 'magic' && !skip) {
        yield chunk.subarray(start, at);
        if (firstFrameOnly) return;
        start = at;
      }
    }
    if (start < chunk.length) yield chunk.subarray(start);
  }
  if (used || skip || state !== 'magic') throw new LocalizedError('error.incompleteZstdFrame');
}

/** rc.5 reads a terminated first line, or exactly one line in the first Zstandard frame. */
async function storedHeader(path: string, input: AsyncIterable<Buffer>, compressed: boolean): Promise<SessionHeader> {
  const chunks: Buffer[] = [];
  for await (const chunk of input) {
    const end = compressed ? -1 : chunk.indexOf(10);
    if (end !== -1) { chunks.push(chunk.subarray(0, end + 1)); break; }
    chunks.push(chunk);
  }
  const line = Buffer.concat(chunks);
  if (!line.length || line.indexOf(10) !== line.length - 1) throw new LocalizedError('error.sessionHeaderUnsupported', { path });
  const { sessionFormatCatalog } = await import('@deepseek-ai/dsh-session-format-catalog');
  const result = sessionFormatCatalog.readHeader(JSON.parse(line.toString('utf8')));
  if (result.status === 'unsupported') throw new LocalizedError('error.sessionFormatUnsupported', { path });
  if (result.status === 'malformed') throw new LocalizedError('error.sessionHeaderUnsupported', { path });
  return { ...result.header, version: result.storedVersion };
}

export async function readLog(path: string, refs?: Set<string>) {
  await safePath(path);
  const input = createReadStream(path, { fd: openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), autoClose: true });
  const compressed = path.endsWith('.zstd');
  const source = compressed ? Readable.from(zstdChunks(input, !refs)) : input;
  const decoded = compressed ? source.pipe(createZstdDecompress()) : source;
  // Forward the source error; async iteration must never silently accept a truncated compressed stream.
  if (decoded !== source) source.on('error', e => decoded.destroy(e));
  let header: SessionHeader | undefined; let count = 0;
  try {
    if (!refs) return await storedHeader(path, decoded, compressed);
    using lines = createInterface({ input: decoded, crlfDelay: Infinity });
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
      }
      references(record, refs);
    }
    if (decoded.errored) throw decoded.errored;
    if (!header) throw new LocalizedError('error.emptySessionLog', { path });
    return header;
  } catch (error) {
    throw new LocalizedError('error.readSessionLog', { path }, { cause: error, failures: [error] });
  } finally { decoded.destroy(); source.destroy(); input.destroy(); }
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

async function* sessionProjects(home: string) {
  for (const project of await entries(join(home, 'sessions'))) {
    if (!project.isDirectory()) continue;
    const projectPath = join('sessions', project.name);
    await safePath(join(home, projectPath), { directory: true });
    yield projectPath;
  }
}
/** Locate only the confirmed family's directories. No other transcript or attachment is read. */
export async function planSessionDeletion(home: string, rootId: string, confirmed: ReadonlyMap<string, number>): Promise<DeletionPlan> {
  const targets = Array.from(confirmed, ([id, createdAt]) => ({ id, createdAt, name: encodeSegment(id) }));
  const directories: DeletionPlan['directories'] = [];
  for await (const projectPath of sessionProjects(home)) {
    for (const { id, createdAt, name } of targets) {
      // Match the provider's path lookup on both case-sensitive and case-insensitive volumes.
      const path = join(projectPath, name), dir = join(home, path);
      if (!await exists(dir)) continue;
      await safePath(dir, { directory: true });
      directories.push({ path, id, createdAt });
    }
  }
  const plan = { ids: [...confirmed.keys()].sort(), directories };
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
      || relative(home, path) !== row.path || !inside(join(home, 'sessions'), path) || basename(path) !== encodeSegment(row.id)) throw new LocalizedError('error.invalidPlanPath');
  }
}
export async function listRequests(home: string): Promise<DeletionRequest[]> {
  const out: DeletionRequest[] = [];
  for (const e of await entries(join(stateDir(home), 'pending'))) {
    if (ATOMIC_TEMP.test(e.name) && e.isFile()) continue;
    if (!/^[a-f0-9]{64}\.json$/.test(e.name)) throw new LocalizedError('error.pendingQueueFile');
    const r = await readJSON<DeletionRequest | undefined>(join(stateDir(home), 'pending', e.name));
    if (r === undefined) continue;
    if (r.schema !== 1 || digest(r.sessionId) + '.json' !== e.name || r.dshVersion !== SUPPORTED_DSH)
      throw new LocalizedError('error.invalidDeletionRequest');
    validatePlan(home, r.sessionId, r.plan);
    if (r.plan.directories.find(row => row.id === r.sessionId)?.createdAt !== r.createdAt
      || r.plan.directories.some(({ transcript }) => !transcript || typeof transcript.path !== 'string' || !LOG.test(transcript.path)
        || !Number.isSafeInteger(transcript.sizeBytes) || transcript.sizeBytes <= 0
        || typeof transcript.sha256 !== 'string' || !/^[a-f0-9]{64}$/.test(transcript.sha256)))
      throw new LocalizedError('error.invalidDeletionRequest');
    out.push(r);
  }
  return out;
}
/** A different stored length proves change without reading the transcript body. */
async function transcriptDigest(path: string, expectedSize: number): Promise<string | undefined> {
  await safePath(path);
  await using file = await fs.open(path, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  const info = await file.stat();
  if (!info.isFile()) throw new LocalizedError('error.unexpectedFile', { path });
  if (info.size !== expectedSize) return undefined;
  const input = file.createReadStream();
  const hash = createHash('sha256');
  for await (const chunk of input) hash.update(chunk);
  if (input.bytesRead !== expectedSize) throw new LocalizedError('error.sessionChanged');
  return hash.digest('hex');
}
/** The caller holds every target writer lock through journal publication and cleanup. */
export async function captureDeletionRequest(home: string, header: SessionHeader, plan: DeletionPlan, stat: (id: string) => Promise<SessionStat | undefined>): Promise<DeletionRequest> {
  await safePath(home, { directory: true });
  validatePlan(home, header.id, plan);
  if (plan.directories.find(row => row.id === header.id)?.createdAt !== header.createdAt) throw new LocalizedError('error.targetLifecycleMismatch');
  const directories: DeletionRequest['plan']['directories'] = [];
  for (const row of plan.directories) {
    const stored = await stat(row.id);
    if (stored?.header.id !== row.id || stored.header.createdAt !== row.createdAt || stored.location?.kind !== 'jsonl')
      throw new LocalizedError('error.sessionChanged');
    const source = stored.location.path, leaf = basename(source);
    if (!LOG.test(leaf) || source !== join(home, row.path, leaf)) throw new LocalizedError('error.invalidPlanPath');
    if (!stored.sizeBytes) throw new LocalizedError('error.sessionChanged');
    const sha256 = await transcriptDigest(source, stored.sizeBytes);
    if (!sha256) throw new LocalizedError('error.sessionChanged');
    directories.push({ ...row, transcript: { path: leaf, sizeBytes: stored.sizeBytes, sha256 } });
  }
  return { schema: 1, dshVersion: SUPPORTED_DSH, sessionId: header.id,
    createdAt: header.createdAt, queuedAt: new Date().toISOString(), plan: { ids: plan.ids, directories } };
}
export async function enqueue(home: string, request: DeletionRequest) {
  const path = requestPath(home, request.sessionId);
  if (await exists(path)) throw new LocalizedError('error.deletionAlreadyQueued');
  await atomicJSON(path, request);
}

/** Only target bookkeeping is examined; unrelated logs/projections can keep changing. */
async function privateInventory(home: string, ids: ReadonlySet<string>) {
  const rewrite: Edit[] = []; const remove: string[] = [];
  const projections = join(home, 'storages/session_projcache/sessions');
  const names = [...ids].map(id => encodeSegment(id) + '.json');
  for (const entry of await entries(projections)) {
    const name = names.find(name => entry.name === name || entry.name === name + '.deleting' || entry.name.startsWith(name + '.bak.'));
    if (!name) continue;
    const path = join(projections, entry.name);
    const suffix = entry.name.slice(name.length);
    if (suffix.startsWith('.bak.') && !/^\.bak\.\d{12}$/.test(suffix)) throw new LocalizedError('error.unexpectedEntry', { path });
    await safePath(path, { file: true });
    remove.push(path);
  }
  const workspacePath = join(home, 'storages/workspace.json');
  const workspace = await readJSON<WorkspaceData | undefined>(workspacePath);
  if (workspace !== undefined) {
    if (workspace?.unit?.name !== 'workspace' || workspace.unit.version !== 2 || !validTable(workspace.tables, 'workspaces')
      || (workspace.global != null && !isRecord(workspace.global))) throw new LocalizedError('error.workspaceSchema');
    let changed = false;
    for (const key of ['archivedSessionIds', 'pinnedSessionIds'] as const) {
      const members = workspace.global?.[key];
      if (members === undefined) continue;
      if (!Array.isArray(members) || !members.every(id => typeof id === 'string')) throw new LocalizedError('error.workspaceSessionsInvalid');
      const kept = members.filter(id => !ids.has(id));
      changed ||= kept.length !== members.length; workspace.global![key] = kept;
    }
    const detach: [string, string][] = [];
    for (const [workspaceId, row] of Object.entries(workspace.tables.workspaces ?? {})) {
      if (!Array.isArray(row?.sessionIds) || !row.sessionIds.every(id => typeof id === 'string')) throw new LocalizedError('error.workspaceSessionsInvalid');
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
    for (const [key, task] of Object.entries(schedule.tables.tasks)) {
      if (!key || key.trim() !== key || task?.record?.id !== key) throw new LocalizedError('error.scheduleSchema');
      const destination = scheduledSession(task);
      if (destination !== undefined && ids.has(destination)) { delete schedule.tables.tasks[key]; changed = true; }
    }
    if (changed) rewrite.push({ path: schedulePath, data: schedule });
  }
  return { rewrite, remove };
}
async function targetHeader(path: string, row: SessionDirectory) {
  const header = await readLog(path);
  if (header.id !== row.id || header.createdAt !== row.createdAt) throw new LocalizedError('error.identityChangedDuringRecovery', { path });
  return header;
}
async function validateTargetDirectories(home: string, plan: DeletionPlan) {
  for (const row of plan.directories) {
    const dir = join(home, row.path);
    await safePath(dir, { missing: true });
    for (const file of await filesUnder(dir)) if (LOG.test(basename(file))) await targetHeader(file, row);
  }
}
async function sameDirectory(actual: string, expected: string) {
  if (actual === expected) return true;
  if (!await exists(expected)) return false;
  await safePath(expected, { directory: true });
  return await fs.realpath(actual) === await fs.realpath(expected);
}
/** rc.5 selects the highest canonical generation and refuses mixed encodings. */
async function offlineTranscript(dir: string, row: SessionDirectory): Promise<string | undefined> {
  let latest: { version: number; name: string } | undefined;
  for (const entry of await entries(dir)) {
    const path = join(dir, entry.name);
    await safePath(path);
    if (!entry.isFile()) throw new LocalizedError('error.unexpectedEntry', { path });
    const generation = LOG.exec(entry.name);
    if (!generation) {
      // The writer lease and rc.5's unpublished create/migration files belong to this directory.
      if (entry.name === 'session.lock' || /^session(?:\.v[1-9]\d*)?\.jsonl(?:\.zstd)?\.[a-f0-9]{12}\.tmp$/.test(entry.name)
        || /^session\.migration\.[a-f0-9]{16}\.jsonl(?:\.zstd)?\.tmp$/.test(entry.name)) continue;
      throw new LocalizedError('error.unexpectedEntry', { path });
    }
    const header = await targetHeader(path, row);
    const project = dirname(dir);
    if (!await sameDirectory(project, join(dirname(project), projectKey(header.cwd))))
      throw new LocalizedError('error.directorySessionMismatch', { path });
    if (header.version !== Number(generation[1] ?? 0)
      || (latest && latest.name.endsWith('.zstd') !== entry.name.endsWith('.zstd')))
      throw new LocalizedError('error.unclassifiedBackup', { path });
    if (!latest || header.version > latest.version) latest = { version: header.version, name: entry.name };
  }
  return latest?.name;
}
async function familyChanged(home: string, plan: DeletionRequest['plan']): Promise<boolean> {
  const seen = new Set<string>();
  let changed = false;
  for (const row of plan.directories) await safePath(join(home, row.path), { missing: true, directory: true });
  for await (const project of sessionProjects(home)) for (const row of plan.directories) {
    const dir = join(home, project, basename(row.path));
    // findLog also refuses flat artifacts for the requested ID in any project.
    for (const suffix of ['.jsonl', '.jsonl.zstd']) if (await exists(dir + suffix))
      throw new LocalizedError('error.unclassifiedBackup', { path: dir + suffix });
    if (!await exists(dir)) continue;
    const leaf = await offlineTranscript(dir, row);
    const recorded = await sameDirectory(dir, join(home, row.path));
    if (!leaf) {
      if (!recorded) throw new LocalizedError('error.directorySessionMismatch', { path: dir });
      continue;
    }
    if (seen.has(row.id)) throw new LocalizedError('error.duplicateSession', { id: row.id });
    seen.add(row.id);
    if (!recorded || leaf !== row.transcript.path) changed = true;
    else if (!changed) changed = await transcriptDigest(join(dir, leaf), row.transcript.sizeBytes) !== row.transcript.sha256;
  }
  return changed;
}
/** Sweep confirmed session data under the caller's live maintenance or exclusive offline writer protections. */
export async function sweep(home: string, { failAfter, hooks, assertOffline, onResolved }: {
  failAfter?: number; hooks?: SweepHooks; assertOffline?: () => Promise<void>; onResolved?: (id: string, outcome: 'completed' | 'abandoned') => void;
} = {}) {
  await safePath(home, { directory: true });
  let operations = 0;
  const checkpoint = () => { if (failAfter !== undefined && ++operations >= failAfter) throw new LocalizedError('error.injectedInterruption'); };
  const completed: Result[] = [];
  for (const request of (await listRequests(home)).filter(r => !hooks || r.sessionId === hooks.onlySessionId)) {
    const plan = request.plan; const ids = new Set(plan.ids);
    if (hooks) await validateTargetDirectories(home, plan);
    else if (await familyChanged(home, plan)) {
      await assertOffline?.();
      await removeOwned(requestPath(home, request.sessionId));
      onResolved?.(request.sessionId, 'abandoned');
      continue;
    }
    const work = await privateInventory(home, ids);
    const receiptPath = join(stateDir(home), 'receipt.json');
    const receipt = await readReceipt(home);
    receipt.deletedIdHashes = [...new Set([...receipt.deletedIdHashes, ...plan.ids.map(digest)])];
    await assertOffline?.();
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
    receipt.revision = randomBytes(16).toString('hex');
    receipt.lastCompletedAt = new Date().toISOString(); receipt.lastResult = { sessions: ids.size };
    await atomicJSON(receiptPath, receipt);
    hooks?.receiptCommitted?.(receipt); checkpoint();
    await removeOwned(requestPath(home, request.sessionId)); checkpoint();
    completed.push(receipt.lastResult);
    onResolved?.(request.sessionId, 'completed');
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
