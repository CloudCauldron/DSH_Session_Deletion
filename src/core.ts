import * as fs from 'node:fs/promises';
import { createReadStream, openSync, constants } from 'node:fs';
import { createZstdDecompress } from 'node:zlib';
import { createInterface } from 'node:readline';
import { createHash, randomBytes } from 'node:crypto';
import { join, resolve, dirname, basename, relative, sep } from 'node:path';

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
interface ScheduleData { unit: { name: string }; tables: { tasks: Record<string, { sessionId: string }> } }
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

export const SUPPORTED_DSH = '0.2.1-rc.5';
export const STATE_NAME = 'session-deletion';
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');
export const stateDir = (home: string) => join(home, STATE_NAME);
export const requestPath = (home: string, id: string) => join(stateDir(home), 'pending', digest(id) + '.json');
export function encodeSegment(raw: string) {
  if (typeof raw !== 'string' || !raw || raw.length > 1024) throw new Error('Invalid session ID');
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
  let current = '/';
  const parts = path.split('/').filter(Boolean);
  for (let i = 0; i < parts.length; i++) {
    current = join(current, parts[i]);
    let st;
    try { st = await fs.lstat(current); }
    catch (e) { if (missing && (e as NodeJS.ErrnoException).code === 'ENOENT') return; throw e; }
    if (st.isSymbolicLink()) throw new Error(`Refusing symlink: ${current}`);
    if (i < parts.length - 1 && !st.isDirectory()) throw new Error(`Not a directory: ${current}`);
    if (i === parts.length - 1) {
      if (st.uid !== process.getuid!()) throw new Error(`Not owned by this user: ${current}`);
      if (directory && !st.isDirectory()) throw new Error(`Not a directory: ${current}`);
    }
  }
}
const durableDirectories = new Set<string>();
export async function privateDir(path: string) {
  path = resolve(path);
  await safePath(path, { missing: true });
  const firstCreated = await fs.mkdir(path, { recursive: true, mode: 0o700 });
  await safePath(path, { directory: true });
  await fs.chmod(path, 0o700);
  // A synced request file is insufficient if its newly-created parent entry
  // can disappear after a power loss. Establish the entire directory chain.
  let requiredParent = firstCreated ? dirname(resolve(firstCreated)) : undefined;
  const synced: string[] = [];
  for (let current = path;; current = dirname(current)) {
    await syncDir(current); synced.push(current);
    if (current === requiredParent) requiredParent = undefined;
    if (dirname(current) === current || (!requiredParent && durableDirectories.has(current))) break;
  }
  for (const directory of synced) durableDirectories.add(directory);
}
async function syncDir(path: string) {
  const h = await fs.open(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
  try { await h.sync(); } finally { await h.close(); }
}
export async function birth(pid: number): Promise<string | undefined> {
  try {
    const text = await fs.readFile(`/proc/${pid}/stat`, 'utf8');
    const fields = text.slice(text.lastIndexOf(')') + 2).split(' ');
    if (!/^\d+$/.test(fields[19] ?? '')) throw new Error('Cannot read process identity');
    return fields[0] === 'Z' ? undefined : fields[19];
  } catch (e) { if (['ENOENT', 'ESRCH'].includes((e as NodeJS.ErrnoException).code || '')) return; throw e; }
}
export async function atomicJSON(path: string, data: unknown) {
  await safePath(path, { missing: true });
  await privateDir(dirname(path));
  const started = await birth(process.pid);
  if (!started) throw new Error('Cannot identify atomic writer');
  const temp = join(dirname(path), `.session-deletion-write-${process.pid}-${started}-${randomBytes(12).toString('hex')}`);
  let h;
  try {
    h = await fs.open(temp, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW, 0o600);
    await h.writeFile(JSON.stringify(data) + '\n');
    await h.sync(); await h.close(); h = undefined;
    await fs.rename(temp, path); await syncDir(dirname(path));
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
    if (e.isSymbolicLink()) throw new Error(`Refusing symlink: ${p}`);
    if (e.isDirectory()) files.push(...await filesUnder(p));
    else if (e.isFile()) { await safePath(p); files.push(p); }
    else throw new Error(`Unexpected filesystem entry: ${p}`);
  }
  return files;
}
function inside(root: string, path: string) {
  const r = relative(root, path);
  return r !== '' && r !== '..' && !r.startsWith('..' + sep) && !r.startsWith(sep);
}
export async function removeOwned(path: string) {
  if (!(await exists(path))) return;
  await safePath(path);
  const st = await fs.lstat(path);
  if (st.isDirectory()) await filesUnder(path);
  else if (!st.isFile()) throw new Error(`Unexpected file: ${path}`);
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
const HASH = /(?:sha256:|\/(?:objects|file-objects|files)\/[a-f0-9]{2}\/)([a-f0-9]{64})(?![a-f0-9])/g;
function references(value: unknown, refs: References) {
  if (typeof value === 'string') {
    for (const match of value.matchAll(HASH)) refs.hashes.add(match[1]);
  } else if (Array.isArray(value)) { for (const v of value) references(v, refs); }
  else if (value && typeof value === 'object') { for (const v of Object.values(value)) references(v, refs); }
}
const newRefs = (): References => ({ hashes: new Set() });

export async function readLog(path: string, headerOnly = false) {
  await safePath(path);
  const input = createReadStream(path, { fd: openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW), autoClose: true });
  const decoded = path.endsWith('.zstd') ? input.pipe(createZstdDecompress()) : input;
  // Forward the source error; async iteration must never silently accept a truncated compressed stream.
  if (decoded !== input) input.on('error', e => decoded.destroy(e));
  const lines = createInterface({ input: decoded, crlfDelay: Infinity });
  const refs = newRefs(); let header: SessionHeader | undefined; let count = 0;
  try {
    for await (const line of lines) {
      if (!line.trim()) continue;
      let record;
      try { record = JSON.parse(line); } catch { throw new Error(`Invalid JSONL in ${path}, record ${count + 1}`); }
      if (count++ === 0) {
        if (record.type !== 'session' || typeof record.id !== 'string' || !Number.isFinite(record.createdAt))
          throw new Error(`Unsupported session header: ${path}`);
        if (!Number.isInteger(record.version) || record.version < 0 || record.version > 4)
          throw new Error(`Unsupported session format: ${path}`);
        header = record;
        if (headerOnly) break;
      }
      references(record, refs);
    }
    if (!headerOnly && decoded.errored) throw decoded.errored;
    if (!header) throw new Error(`Empty session log: ${path}`);
    return { header, refs };
  } catch (error) {
    throw new Error(`Cannot read session log ${path}: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  } finally { lines.close(); decoded.destroy(); input.destroy(); }
}

export async function scanSessions(home: string, snapshots?: Map<string, LiveSnapshot>): Promise<SessionMap> {
  const root = join(home, 'sessions'); const sessions: SessionMap = new Map();
  const liveByDirectory = new Map([...snapshots?.values() ?? []].map(s => [encodeSegment(s.header.id), s]));
  for (const project of await entries(root)) {
    if (!project.isDirectory()) {
      if (project.isSymbolicLink()) throw new Error('Symlink under sessions');
      continue;
    }
    for (const directory of await entries(join(root, project.name))) {
      if (!directory.isDirectory()) {
        if (directory.isSymbolicLink()) throw new Error('Symlink session directory');
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
        if (directory.name !== encodeSegment(parsed.header.id)) throw new Error(`Session directory identity mismatch: ${dir}`);
        if (selected && (selected.id !== parsed.header.id || selected.createdAt !== parsed.header.createdAt))
          throw new Error(`Mixed session identities: ${dir}`);
        if (!selected || parsed.header.version > selected.version) selected = parsed.header;
        for (const h of parsed.refs.hashes) refs.hashes.add(h);
      }
      // Retained backup generations can contain additional attachments or spill references.
      for (const file of await filesUnder(dir)) {
        const leaf = basename(file);
        if (LOG.test(leaf) || leaf === 'session.lock') continue;
        if (/\.jsonl(?:\.zstd)?(?:\.|$)/.test(leaf)) {
          // Unknown damaged/backup encodings must not be assumed to contain no references.
          throw new Error(`Unclassified backup log requires review: ${file}`);
        }
      }
      if (!selected) throw new Error("Missing session header");
      if (sessions.has(selected.id)) throw new Error(`Duplicate session ID: ${selected.id}`);
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
      const header = headers.get(id); if (!header) throw new Error('Missing target header');
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
    || new Set(plan.directories.map(row => row.id)).size !== ids.size) throw new Error('Invalid deletion plan identities');
  for (const row of plan.directories) {
    const path = resolve(home, row.path);
    const parts = relative(join(home, 'sessions'), path).split(sep);
    if (!ids.has(row.id) || !Number.isFinite(row.createdAt) || parts.length !== 2
      || !inside(join(home, 'sessions'), path) || basename(path) !== encodeSegment(row.id)) throw new Error('Invalid deletion plan path');
  }
}
export async function listRequests(home: string): Promise<DeletionRequest[]> {
  const out: DeletionRequest[] = [];
  for (const e of await entries(join(stateDir(home), 'pending'))) {
    if (ATOMIC_TEMP.test(e.name) && e.isFile()) continue;
    if (!/^[a-f0-9]{64}\.json$/.test(e.name)) throw new Error('Unexpected pending queue file');
    const r = await readJSON<DeletionRequest | undefined>(join(stateDir(home), 'pending', e.name));
    if (r === undefined) continue;
    if (r.schema !== 3 || digest(r.sessionId) + '.json' !== e.name || r.dshVersion !== SUPPORTED_DSH)
      throw new Error('Invalid deletion request');
    validatePlan(home, r.sessionId, r.plan);
    out.push(r);
  }
  return out;
}
export async function enqueue(home: string, header: SessionHeader, plan: DeletionPlan) {
  await safePath(home, { directory: true });
  validatePlan(home, header.id, plan);
  if (plan.directories.find(row => row.id === header.id)?.createdAt !== header.createdAt) throw new Error('Target lifecycle mismatch');
  const path = requestPath(home, header.id);
  if (await exists(path)) throw new Error('A deletion request already exists');
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
    if (workspace.unit?.name !== 'workspace' || !workspace.global || !workspace.tables?.workspaces) throw new Error('Unsupported workspace storage schema');
    let changed = false;
    for (const key of ['archivedSessionIds', 'pinnedSessionIds'] as const) {
      if (!Array.isArray(workspace.global[key])) throw new Error('Invalid workspace session accounting');
      const kept = workspace.global[key].filter(id => !ids.has(id));
      changed ||= kept.length !== workspace.global[key].length; workspace.global[key] = kept;
    }
    for (const row of Object.values(workspace.tables.workspaces)) {
      if (!Array.isArray(row.sessionIds)) throw new Error('Invalid workspace session accounting');
      const kept = row.sessionIds.filter(id => !ids.has(id));
      changed ||= kept.length !== row.sessionIds.length; row.sessionIds = kept;
    }
    if (changed) rewrite.push({ path: workspacePath, data: workspace });
  }
  const schedulePath = join(home, 'storages/schedule.json');
  const schedule = await readJSON<ScheduleData | undefined>(schedulePath);
  if (schedule) {
    if (schedule.unit?.name !== 'schedule' || !schedule.tables?.tasks) throw new Error('Unsupported schedule schema');
    let changed = false;
    for (const [key, task] of Object.entries(schedule.tables.tasks)) if (ids.has(task.sessionId)) { delete schedule.tables.tasks[key]; changed = true; }
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
      if (header.id !== row.id || header.createdAt !== row.createdAt) throw new Error('Session identity changed during recovery');
    }
  }
}
/** Caller holds lifecycle and target writer locks. This function never scans or deletes attachments. */
export async function sweep(home: string, { failAfter, hooks }: { failAfter?: number; hooks?: SweepHooks } = {}) {
  await safePath(home, { directory: true });
  let operations = 0;
  const checkpoint = () => { if (failAfter !== undefined && ++operations >= failAfter) throw new Error('Injected interruption'); };
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
    if (audit.remove.length || audit.rewrite.length) throw new Error('Post-deletion private metadata audit failed');
    for (const row of plan.directories) if (await exists(join(home, row.path))) throw new Error('Post-deletion session audit failed');
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

/** Explicit, globally quiescent mark/sweep. Interrupted GC is rescanned, never replayed from a stale manifest. */
export async function collectGarbage(home: string, { hooks, failAfter }: { hooks?: GcHooks; failAfter?: number } = {}): Promise<GcResult> {
  if ((await listRequests(home)).length) throw new Error('Finish pending session deletions before GC');
  const sessions = await scanSessions(home, await hooks?.snapshots?.());
  const refs = newRefs();
  for (const session of sessions.values()) for (const hash of session.refs.hashes) refs.hashes.add(hash);
  for (const path of await filesUnder(join(home, 'storages'))) {
    if (ATOMIC_TEMP.test(basename(path))) continue;
    if (!path.endsWith('.json') && !/\.json\.bak\./.test(path)) throw new Error('Unclassified storage during GC: ' + path);
    references(await readJSON(path), refs);
  }
  const candidates: { path: string; kind: string; files: number }[] = [];
  const garbage = new Set<string>();
  for (const kind of ['objects', 'file-objects', 'files']) {
    const root = join(home, 'attachments/v1', kind);
    for (const prefix of await entries(root)) {
      if (!/^[a-f0-9]{2}$/.test(prefix.name) || !prefix.isDirectory()) throw new Error('Unexpected attachment shard: ' + join(root, prefix.name));
      for (const entry of await entries(join(root, prefix.name))) {
        const hash = entry.name; const path = join(root, prefix.name, hash);
        if (!/^[a-f0-9]{64}$/.test(hash) || hash.slice(0, 2) !== prefix.name) throw new Error('Unexpected attachment object: ' + path);
        await safePath(path);
        if (kind === 'files' ? !entry.isDirectory() : !entry.isFile()) throw new Error('Unexpected attachment object type: ' + path);
        const files = kind === 'files' ? (await filesUnder(path)).length : 1;
        if (!refs.hashes.has(hash)) { candidates.push({ path, kind, files }); garbage.add(hash); }
      }
    }
  }
  const cache = join(home, 'cache/attachments/request-images');
  const cacheFiles = await filesUnder(cache);
  const uploadPath = join(home, 'llm-deepseek/files-v3.json');
  const upload = await readJSON<RemoteCache | undefined>(uploadPath);
  let uploadMappings = 0;
  if (upload) {
    if (upload.formatVersion !== 3 || !Array.isArray(upload.records)) throw new Error('Unsupported DeepSeek file-cache schema');
    upload.records = upload.records.filter(record => {
      if (!/^sha256:[a-f0-9]{64}$/.test(record.attachmentId)) throw new Error('Invalid upload attachment ID');
      const hash = record.attachmentId.slice(7);
      if (refs.hashes.has(hash)) return true;
      garbage.add(hash); uploadMappings++; return false;
    });
  }
  // Complete preflight above before the first destructive operation.
  let operations = 0;
  const checkpoint = () => { if (failAfter !== undefined && ++operations >= failAfter) throw new Error('Injected GC interruption'); };
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
    if (candidate.kind === 'files') result.fileLinks += candidate.files; else result.objects++;
    checkpoint();
  }
  if (await exists(cache)) { await removeOwned(cache); checkpoint(); }
  for (const { path } of candidates) if (await exists(path)) throw new Error('Post-GC attachment audit failed');
  if (await exists(cache)) throw new Error('Post-GC cache audit failed');
  const remaining = await readJSON<RemoteCache | undefined>(uploadPath);
  if (remaining?.records.some(record => garbage.has(record.attachmentId.slice(7)))) throw new Error('Post-GC upload index audit failed');
  await atomicJSON(join(stateDir(home), 'gc.json'), { completedAt: new Date().toISOString(), ...result });
  return result;
}
