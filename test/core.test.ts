import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { createHash, hash, randomBytes } from 'node:crypto';
import { basename, dirname, join } from 'node:path';
import { zstdCompressSync, constants } from 'node:zlib';
import { syncBuiltinESMExports } from 'node:module';
import { scanSessions, sweep, collectGarbage, garbageSize, exists, digest, encodeSegment, listRequests, readJSON, stateDir, captureDeletionRequest, enqueue, atomicJSON, safePath, readLog, SUPPORTED_DSH, scheduledSession } from '../lib/core.js';
import type { Receipt, DeletionRequest } from '../lib/core.js';
import { birth } from '../lib/platform/index.js';
import { fixture, trackContentHashes } from './fixtures.ts';

void test('compressed logs retain every frame across blocks, checksums and input boundaries', async () => {
  const f = await fixture();
  try {
    const header = zstdCompressSync(JSON.stringify(f.headers[f.ids.other]) + '\n');
    const rle = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 20, 0xa3, 0, 0, 10]);
    const metadata = Buffer.alloc(65534 - header.length - rle.length);
    metadata.writeUInt32LE(0x184d2a50); metadata.writeUInt32LE(metadata.length - 8, 4);
    const event = JSON.stringify({ content: randomBytes(2 * 1024 * 1024).toString('base64'), attachmentId: 'sha256:' + f.exclusive }) + '\n';
    const frame = zstdCompressSync(event, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
    const path = join(f.sessionProject, f.ids.other, 'session.v4.jsonl.zstd');
    await fs.writeFile(path, Buffer.concat([header, rle, metadata, frame]));
    const refs = new Set<string>();
    await readLog(path, refs);
    assert.deepEqual([...refs], [f.exclusive]);
    await fs.truncate(path, (await fs.stat(path)).size - 1);
    await assert.rejects(readLog(path, refs));
    await fs.writeFile(path, zstdCompressSync('not JSON\n'));
    await assert.rejects(readLog(path, refs), {
      messages: [{ key: 'error.readSessionLog', params: { path } }, { key: 'error.invalidJsonl', params: { path, record: 1 } }],
    });
  } finally { await f.cleanup(); }
});

for (const compressed of [false, true]) void test(`schema 1 captures only the selected ${compressed ? 'compressed' : 'plain'} transcript for each confirmed member`, async t => {
  const f = await fixture(compressed);
  try {
    const root = await f.stat(f.ids.main);
    const historical = JSON.stringify({ ...root.header, version: 3 }) + '\n';
    await f.write(root.location.path.replace('.v4.', '.v3.'), compressed ? zstdCompressSync(historical) : historical);
    await f.session('unlinked');
    const blank = await f.stat('unlinked');
    const header = Buffer.from(JSON.stringify(blank.header) + '\n');
    const headerOnly = compressed ? zstdCompressSync(header) : header;
    await f.write(blank.location.path, headerOnly);
    const contentHashes = trackContentHashes(t);
    await garbageSize(f.home); await collectGarbage(f.home);
    assert.deepEqual(await fs.readFile(blank.location.path), headerOnly);
    assert.equal(contentHashes(), 0);
    await f.queue();
    const [request] = await listRequests(f.home);
    assert.equal(request.schema, 1); assert.equal(request.dshVersion, SUPPORTED_DSH);
    assert.deepEqual(request.plan.ids, [f.ids.child, f.ids.grand, f.ids.main]);
    for (const row of request.plan.directories) {
      const { header, location } = await f.stat(row.id);
      const bytes = await fs.readFile(location.path);
      assert.equal(row.createdAt, header.createdAt); assert.equal(join(f.home, row.path, row.transcript.path), location.path);
      assert.deepEqual(row.transcript, { path: basename(location.path), sizeBytes: bytes.length, sha256: hash('sha256', bytes) });
    }
    assert.equal(contentHashes(), request.plan.ids.length);
  } finally { await f.cleanup(); }
});

void test('unsupported host versions cannot authorize a deletion', async () => {
  const f = await fixture();
  try {
    await f.queue();
    const request = (await listRequests(f.home))[0];
    await atomicJSON(join(stateDir(f.home), 'pending', digest(f.ids.main) + '.json'), { ...request, dshVersion: 'unsupported' });
    await assert.rejects(sweep(f.home), /Invalid deletion request/);
    assert.equal(await exists(join(f.sessionProject, f.ids.main)), true);
  } finally { await f.cleanup(); }
});

const attachment = (f: Awaited<ReturnType<typeof fixture>>, hash: string, kind = 'objects') => join(f.home, 'attachments/v1', kind, hash.slice(0, 2), hash);

void test('schedule cleanup follows explicit destinations and the native legacy fallback, never actor involvement', async () => {
  const f = await fixture();
  try {
    const path = join(f.home, 'storages/schedule.json');
    await f.write(path, JSON.stringify({ unit: { name: 'schedule', version: 2 }, tables: { tasks: {
      legacy: { record: { id: 'legacy' }, sessionId: f.ids.main },
      current: { record: { id: 'current' }, target: { kind: 'session', sessionId: f.ids.main }, sessionId: f.ids.other },
      child: { record: { id: 'child' }, target: { kind: 'new_once', sessionId: f.ids.child } },
      rebound: { record: { id: 'rebound' }, target: { kind: 'session', sessionId: f.ids.other }, sessionId: f.ids.main },
      independent: { record: { id: 'independent' }, target: { kind: 'new' }, sessionId: f.ids.main },
      involved: { record: { id: 'involved' }, target: { kind: 'session', sessionId: f.ids.other }, involvedSessionIds: [f.ids.main] },
    } } }));
    assert.equal(scheduledSession({ record: { id: 'legacy-unbound' } }), 'session-schedule-' + digest('legacy-unbound'));
    assert.equal(scheduledSession({ target: { kind: 'new_once' }, record: { id: 'reserved' } }), 'session-schedule-' + digest('reserved'));
    await f.queue(); await sweep(f.home);
    const result = await readJSON<{ tables: { tasks: Record<string, unknown> } }>(path);
    assert.deepEqual(Object.keys(result.tables.tasks), ['rebound', 'independent', 'involved']);
  } finally { await f.cleanup(); }
});

void test('offline recovery refuses unclassifiable bookkeeping before removing session data', async () => {
  const f = await fixture();
  try {
    await f.queue();
    const [request] = await listRequests(f.home);
    const workspace = join(f.home, 'storages/workspace.json'), schedule = join(f.home, 'storages/schedule.json');
    const original = await fs.readFile(workspace);
    for (const data of [null, { unit: { name: 'workspace', version: 3 }, tables: {} }]) {
      await f.write(workspace, JSON.stringify(data));
      await assert.rejects(sweep(f.home), /workspace storage schema/);
    }
    await f.write(workspace, original);
    const unit = { name: 'schedule', version: 2 };
    for (const data of [null, { unit, tables: { tasks: [] } },
      { unit, tables: { tasks: { task: { record: { id: 'task' }, target: null, sessionId: f.ids.child } } } },
      { unit, tables: { tasks: { task: { record: { id: 'another-task' }, target: { kind: 'new_once' } } } } }]) {
      const saved = JSON.stringify(data);
      await f.write(schedule, saved);
      await assert.rejects(sweep(f.home), /schedule schema|schedule destination/);
      assert.equal(await fs.readFile(schedule, 'utf8'), saved);
    }
    await fs.unlink(schedule);
    await fs.mkdir(schedule);
    await assert.rejects(sweep(f.home), /Unexpected file/);
    await fs.rmdir(schedule);
    const receipt = join(stateDir(f.home), 'receipt.json');
    const malformed = JSON.stringify({ schema: 1, revision: 'prior', deletedIdHashes: digest('prior') });
    await f.write(receipt, malformed);
    await assert.rejects(sweep(f.home), /Invalid session deletion receipt/);
    assert.equal(await fs.readFile(receipt, 'utf8'), malformed);
    assert.deepEqual(await fs.readFile(workspace), original);
    assert.deepEqual(await listRequests(f.home), [request]);
    for (const row of request.plan.directories) assert.ok(await exists(join(f.home, row.path, row.transcript.path)));
  } finally { await f.cleanup(); }
});

void test('offline recovery honors storage defaults and removes only the target’s staged projection', async () => {
  const f = await fixture();
  try {
    await f.queue();
    const projections = join(f.home, 'storages/session_projcache/sessions');
    const staged = join(projections, f.ids.main + '.json.deleting'), other = join(projections, f.ids.other + '.json.deleting');
    await fs.rename(join(projections, f.ids.main + '.json'), staged);
    await f.write(other, 'unrelated');
    const backup = join(projections, f.ids.main + '.json.bak.202611201230');
    const unknown = join(projections, f.ids.main + '.json.bak.notes');
    await f.write(backup, 'native backup');
    await f.write(unknown, 'unclassified');
    for (const [name, global] of [['workspace', { initialized: true, workspaceIds: [] }], ['schedule', null]] as const)
      await f.write(join(f.home, 'storages', name + '.json'), JSON.stringify({ unit: { name, version: 2 }, global, tables: {} }));
    await assert.rejects(sweep(f.home), /Unexpected filesystem entry/);
    assert.equal(await fs.readFile(unknown, 'utf8'), 'unclassified');
    assert.ok(await exists(staged));
    await fs.unlink(unknown);
    assert.deepEqual(await sweep(f.home), [{ sessions: 3 }]);
    assert.equal(await exists(staged), false);
    assert.equal(await exists(backup), false);
    assert.equal(await fs.readFile(other, 'utf8'), 'unrelated');
  } finally { await f.cleanup(); }
});

void test('atomic writes identify their process owner and preserve the committed file when serialization fails', async () => {
  const f = await fixture();
  try {
    const path = join(stateDir(f.home), 'receipt.json');
    await atomicJSON(path, { committed: true });
    const prefix = `.session-deletion-write-${process.pid}-${await birth(process.pid)}-`;
    let temporary!: string[];
    await assert.rejects(atomicJSON(path, { toJSON() {
      // Serialization runs only after the temporary file has been opened.
      temporary = readdirSync(stateDir(f.home));
      throw new Error('serialization interrupted');
    } }), /serialization interrupted/);
    assert.ok(temporary.some(name => name.startsWith(prefix)));
    assert.deepEqual(await readJSON<{ committed: boolean }>(path), { committed: true });
    assert.deepEqual(await fs.readdir(stateDir(f.home)), ['receipt.json']);
  } finally { await f.cleanup(); }
});

void test('receipts retain all hashes and advance revision after each deletion', async () => {
  const f = await fixture();
  try {
    const path = join(stateDir(f.home), 'receipt.json');
    const previous = Array.from({ length: 4100 }, (_, i) => digest('previous-session-' + i));
    await atomicJSON(path, { schema: 1, revision: 'a'.repeat(32), deletedIdHashes: previous });
    await f.queue(); await sweep(f.home);
    const first = await readJSON<Receipt>(path);
    assert.deepEqual(first.deletedIdHashes.slice(0, previous.length), previous);
    assert.equal(first.deletedIdHashes.length, previous.length + 3);
    assert.match(first.revision, /^[a-f0-9]{32}$/);
    await f.queue(f.ids.other);
    // All transcripts for this request are already gone, but its receipt is still outstanding.
    await fs.unlink((await f.stat(f.ids.other)).location.path);
    await sweep(f.home);
    const second = await readJSON<Receipt>(path);
    assert.notEqual(second.revision, first.revision);
    assert.deepEqual(second.deletedIdHashes.slice(0, first.deletedIdHashes.length), first.deletedIdHashes);
    assert.deepEqual(second.deletedIdHashes.slice(first.deletedIdHashes.length), [digest(f.ids.other)]);
  } finally { await f.cleanup(); }
});
async function fileSnapshot(root: string) {
  const files: Record<string, string> = {};
  async function visit(path: string): Promise<void> {
    for (const entry of await fs.readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await visit(file); else files[file] = createHash('sha256').update(await fs.readFile(file)).digest('hex');
    }
  }
  await visit(root); return files;
}

void test('private deletion preserves every attachment, cache, upload mapping and temporary file', async () => {
  const f = await fixture();
  try {
    const before = await fileSnapshot(join(f.home, 'attachments'));
    const cache = await fileSnapshot(join(f.home, 'cache'));
    const upload = await fs.readFile(join(f.home, 'llm-deepseek/files-v3.json'), 'utf8');
    await f.queue();
    assert.deepEqual(await sweep(f.home), [{ sessions: 3 }]);
    assert.deepEqual([...await scanSessions(f.home)].map(([id]) => id).sort(), [f.ids.fork, f.ids.other]);
    assert.deepEqual(await fileSnapshot(join(f.home, 'attachments')), before);
    assert.deepEqual(await fileSnapshot(join(f.home, 'cache')), cache);
    assert.equal(await fs.readFile(join(f.home, 'llm-deepseek/files-v3.json'), 'utf8'), upload);
    assert.equal(await exists(f.spill), true); assert.equal(await exists(f.sharedSpill), true);
    assert.equal(await fs.readFile(f.projectFile, 'utf8'), 'user project must survive');
    const workspace = await readJSON<{ tables: { workspaces: { project: { sessionIds: string[] } } }; global: { pinnedSessionIds: string[] } }>(join(f.home, 'storages/workspace.json'));
    assert.deepEqual(workspace.tables.workspaces.project.sessionIds, [f.ids.fork, f.ids.other]);
    assert.deepEqual(workspace.global.pinnedSessionIds, [f.ids.other]);
    assert.deepEqual(Object.keys((await readJSON<{ tables: { tasks: Record<string, unknown> } }>(join(f.home, 'storages/schedule.json'))).tables.tasks), ['c']);
    assert.equal((await listRequests(f.home)).length, 0);
    assert.ok(!(await fs.readFile(join(stateDir(f.home), 'receipt.json'), 'utf8')).includes(f.ids.main));
  } finally { await f.cleanup(); }
});

for (let step = 1; step <= 11; step++) void test(`private deletion interruption ${step} recovers without touching attachments`, async () => {
  const f = await fixture();
  try {
    const before = await fileSnapshot(join(f.home, 'attachments'));
    await f.queue();
    await assert.rejects(sweep(f.home, { failAfter: step }), /Injected interruption/);
    await sweep(f.home);
    assert.equal((await scanSessions(f.home)).size, 2);
    assert.equal((await listRequests(f.home)).length, 0);
    const receipt = await readJSON<Receipt>(join(stateDir(f.home), 'receipt.json'));
    assert.deepEqual(receipt.deletedIdHashes.sort(), [f.ids.main, f.ids.child, f.ids.grand].map(digest).sort());
    assert.deepEqual(await fileSnapshot(join(f.home, 'attachments')), before);
  } finally { await f.cleanup(); }
});

void test('unrelated corrupt logs and opaque attachment storage do not block private deletion', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(join(f.sessionProject, f.ids.other, 'session.v4.jsonl.zstd'), 'corrupt');
    await f.write(join(f.home, 'storages/unrelated.bin'), 'opaque');
    await f.queue(); await sweep(f.home);
    assert.equal(await exists(join(f.sessionProject, f.ids.main)), false);
    assert.equal(await exists(attachment(f, f.exclusive)), true);
  } finally { await f.cleanup(); }
});

void test('target symlink or changed lifecycle refuses private deletion', async () => {
  const f = await fixture();
  try {
    await f.queue();
    const link = join(f.sessionProject, f.ids.main, 'external');
    await fs.symlink(f.base, link, 'junction');
    await assert.rejects(sweep(f.home), /symlink/);
    await fs.unlink(link);
    await f.session(f.ids.main, { createdAt: 999 });
    await assert.rejects(sweep(f.home), /identity changed/);
    assert.equal(await fs.readFile(f.projectFile, 'utf8'), 'user project must survive');
  } finally { await f.cleanup(); }
});

void test('an equal-length change in the last child abandons the whole request and preserves every survivor', async () => {
  const f = await fixture(false);
  try {
    await f.queue();
    const [request] = await listRequests(f.home);
    const rows = request.plan.directories;
    rows.sort((a, b) => Number(a.id === f.ids.grand) - Number(b.id === f.ids.grand));
    await atomicJSON(join(stateDir(f.home), 'pending', digest(f.ids.main) + '.json'), request);
    await fs.rm(join(f.sessionProject, f.ids.child), { recursive: true });
    const last = await f.stat(f.ids.grand);
    const original = await fs.readFile(last.location.path, 'utf8');
    const changed = original.replace('user/message', 'user/updated');
    assert.notEqual(original, changed); assert.equal(changed.length, original.length);
    await f.write(last.location.path, changed);
    const sessions = join(f.home, 'sessions'), storages = join(f.home, 'storages');
    const before = { sessions: await fileSnapshot(sessions), storages: await fileSnapshot(storages) };
    const receipt = join(stateDir(f.home), 'receipt.json');
    await atomicJSON(receipt, { schema: 1, revision: 'prior', deletedIdHashes: [digest('prior')] });
    const previous = await fs.readFile(receipt);
    const outcomes: string[] = [];
    assert.deepEqual(await sweep(f.home, { onResolved: (id, outcome) => outcomes.push(id + ' ' + outcome) }), []);
    assert.deepEqual(outcomes, [f.ids.main + ' abandoned']);
    assert.deepEqual(await listRequests(f.home), []);
    await sweep(f.home);
    assert.deepEqual(await fs.readFile(receipt), previous);
    assert.deepEqual({ sessions: await fileSnapshot(sessions), storages: await fileSnapshot(storages) }, before);
  } finally { await f.cleanup(); }
});

for (const replacement of ['lower', 'higher', 'encoding', 'project'] as const)
void test('offline recovery recognizes a replacement transcript: ' + replacement, async t => {
  const f = await fixture(false);
  try {
    const { header, location } = await f.stat(f.ids.other);
    const historical = join(dirname(location.path), 'session.jsonl');
    const { id, createdAt, cwd, delegationDepth } = header;
    await f.write(historical, JSON.stringify({ type: 'session', version: 0, id, createdAt, cwd, delegationDepth }) + '\n');
    // Only a historical capture can acquire a higher generation after confirmation.
    if (replacement === 'higher') {
      await fs.unlink(location.path);
      const request = await captureDeletionRequest(f.home, header, await f.plan(header.id), async () => ({
        header, location: { kind: 'jsonl', path: historical }, sizeBytes: (await fs.stat(historical)).size,
      }));
      await enqueue(f.home, request);
      await f.session(header.id);
    } else {
      await f.queue(header.id);
      if (replacement !== 'lower') await fs.unlink(historical);
      if (replacement === 'encoding') await f.write(location.path + '.zstd', zstdCompressSync(JSON.stringify(header) + '\n'));
      if (replacement === 'project') {
        const project = join(f.home, 'sessions/--other-~6D4B~8BD5--');
        await f.write(location.path, JSON.stringify({ ...header, cwd: '/other/测试' }) + '\n');
        await fs.mkdir(project);
        await fs.rename(dirname(location.path), join(project, header.id));
        await f.write(join(dirname(location.path), 'session.lock'), '');
      } else await fs.unlink(location.path);
    }
    const count = trackContentHashes(t);
    assert.deepEqual(await sweep(f.home), []);
    assert.equal(count(), 0);
    assert.deepEqual(await listRequests(f.home), []);
    assert.equal(await exists(join(stateDir(f.home), 'receipt.json')), false);
    assert.equal(await exists(join(f.home, 'storages/session_projcache/sessions', header.id + '.json')), true);
  } finally { await f.cleanup(); }
});

void test('offline recovery hashes only surviving authorities and keeps a newly linked child', async t => {
  const f = await fixture();
  try {
    await f.queue();
    const main = await f.stat(f.ids.main);
    await f.write(main.location.path.replace('.v4.', '.v3.'), zstdCompressSync(JSON.stringify({ ...main.header, version: 3 }) + '\n'));
    const child = (await f.stat(f.ids.child)).location.path;
    await fs.unlink(child);
    await f.write(child + '.123456abcdef.tmp', 'unfinished materialization');
    await f.write(join(dirname(child), 'session.migration.0123456789abcdef.jsonl.zstd.tmp'), 'unfinished migration');
    await f.session('new-child', { parentSession: f.ids.main, origin: 'subagent' });
    const count = trackContentHashes(t);
    assert.deepEqual(await sweep(f.home), [{ sessions: 3 }]);
    assert.equal(count(), 2);
    assert.equal(await exists((await f.stat('new-child')).location.path), true);
    assert.deepEqual(await listRequests(f.home), []);
    const receipt = await readJSON<Receipt>(join(stateDir(f.home), 'receipt.json'));
    assert.deepEqual(receipt.deletedIdHashes.sort(), [f.ids.main, f.ids.child, f.ids.grand].map(digest).sort());
  } finally { await f.cleanup(); }
});

for (const compressed of [false, true]) void test(`offline recovery requires a complete native ${compressed ? 'header frame' : 'first line'}`, async () => {
  const f = await fixture(compressed);
  try {
    await f.queue(f.ids.other);
    const [request] = await listRequests(f.home);
    const { header, location: { path } } = await f.stat(f.ids.other);
    const line = JSON.stringify(header);
    const encode = (text: string) => compressed ? zstdCompressSync(text) : Buffer.from(text);
    const invalid = [encode(line), encode('\n' + line + '\n'), encode(JSON.stringify({ ...header, delegationDepth: '0' }) + '\n')];
    if (compressed) invalid.push(encode(line + '\n{}\n'), Buffer.concat([encode(line), encode('\n')]));
    for (const bytes of invalid) {
      await f.write(path, bytes);
      await assert.rejects(sweep(f.home), /Cannot read session log/);
      assert.deepEqual(await listRequests(f.home), [request]);
      assert.deepEqual(await fs.readFile(path), bytes);
    }
    // Once identity and a length change are known, the event body need not be decodable.
    const changed = Buffer.concat([encode(line + '\n'), Buffer.from('torn')]);
    await f.write(path, changed);
    assert.deepEqual(await sweep(f.home), []);
    assert.deepEqual(await listRequests(f.home), []);
    assert.deepEqual(await fs.readFile(path), changed);
    assert.equal(await exists(join(stateDir(f.home), 'receipt.json')), false);
  } finally { await f.cleanup(); }
});

for (const conflict of ['none', 'unreadable', 'identity', 'wrong project', 'mixed encodings', 'unknown artifact', 'unidentified directory', 'duplicate log', 'flat log'] as const)
void test('a length change skips further hashes while the guard checks for conflicts: ' + conflict, async t => {
  const f = await fixture(false);
  try {
    await f.queue();
    const [request] = await listRequests(f.home);
    const first = request.plan.directories[0], last = request.plan.directories.at(-1)!;
    await fs.appendFile(join(f.home, first.path, first.transcript.path), '\n');
    const path = join(f.home, last.path, last.transcript.path);
    if (conflict === 'unreadable') await f.write(path, 'broken header');
    if (conflict === 'identity') await f.session(last.id, { createdAt: last.createdAt + 1 });
    if (conflict === 'wrong project') await f.session(last.id, { cwd: '/elsewhere' });
    if (conflict === 'mixed encodings') await f.write(path + '.zstd', zstdCompressSync(await fs.readFile(path)));
    if (conflict === 'unknown artifact') await f.write(path + '.bak', 'unclassified');
    if (conflict === 'unidentified directory') await f.write(join(f.home, 'sessions/shadow', last.id, 'session.lock'), '');
    if (conflict === 'duplicate log') await f.write(join(f.home, 'sessions/--shadow--', last.id, last.transcript.path),
      JSON.stringify({ ...f.headers[last.id], cwd: '/shadow' }) + '\n');
    if (conflict === 'flat log') await f.write(join(f.sessionProject, last.id + '.jsonl'), '{}');
    const count = trackContentHashes(t);
    if (conflict === 'none') {
      assert.deepEqual(await sweep(f.home), []);
      assert.deepEqual(await listRequests(f.home), []);
    } else {
      await assert.rejects(sweep(f.home), /Cannot read session log|identity changed|identity mismatch|Unclassified backup|Unexpected filesystem entry|Duplicate session/);
      assert.deepEqual(await listRequests(f.home), [request]);
    }
    assert.equal(count(), 0);
    for (const row of request.plan.directories) {
      assert.equal(await exists(join(f.home, row.path, row.transcript.path)), true);
      assert.equal(await exists(join(f.home, 'storages/session_projcache/sessions', row.id + '.json')), true);
    }
    assert.equal(await exists(join(stateDir(f.home), 'receipt.json')), false);
  } finally { await f.cleanup(); }
});

void test('path checks reject symlink/junction ancestors even when the leaf does not exist', async () => {
  const f = await fixture();
  try {
    const link = join(f.home, 'external');
    await fs.symlink(f.base, link, 'junction');
    await assert.rejects(safePath(join(link, 'project-file.txt')), /symlink/);
    await assert.rejects(safePath(join(link, 'missing'), { missing: true }), /symlink/);
  } finally { await f.cleanup(); }
});

void test('plan validation rejects invalid schemas and traversal', async () => {
  const f = await fixture();
  try {
    assert.equal(encodeSegment('../outside'), '..~002Foutside');
    const plan = await f.plan();
    if (process.platform === 'win32') {
      const outside = { ...plan, directories: plan.directories.map(row => ({ ...row, path: `${f.home[0].toUpperCase() === 'Z' ? 'Y' : 'Z'}:\\${row.id}` })) };
      await assert.rejects(captureDeletionRequest(f.home, f.headers[f.ids.main], outside, f.stat), /Invalid deletion plan path/);
    }
    await assert.rejects(captureDeletionRequest(f.home, { ...f.headers[f.ids.main], createdAt: 9 }, plan, f.stat), /lifecycle/);
    await f.queue();
    const path = join(stateDir(f.home), 'pending', digest(f.ids.main) + '.json');
    const request = await readJSON<DeletionRequest>(path);
    await f.write(path, JSON.stringify({ ...request, schema: 'invalid' }));
    await assert.rejects(sweep(f.home), /Invalid deletion request/);
    const transcript = request.plan.directories[0].transcript;
    for (const key of ['path', 'sha256'] as const) {
      request.plan.directories[0].transcript = { ...transcript, [key]: [transcript[key]] };
      await f.write(path, JSON.stringify(request));
      await assert.rejects(listRequests(f.home), /Invalid deletion request/);
    }
    plan.directories[0].path = '../outside';
    await f.write(path, JSON.stringify({ ...request, plan }));
    await assert.rejects(sweep(f.home), /Invalid deletion plan path/);
  } finally { await f.cleanup(); }
});

void test('even a lock-only directory in another project prevents an ambiguous deletion', async () => {
  const f = await fixture();
  try {
    await f.write(join(f.home, 'sessions/other-project', f.ids.child, 'session.lock'), '');
    await assert.rejects(f.queue(), /Invalid deletion plan identities/);
    assert.deepEqual(await listRequests(f.home), []);
  } finally { await f.cleanup(); }
});

void test('uncommitted requests are ignored and never authorize deletion', async () => {
  const f = await fixture();
  try {
    await f.queue();
    const committed = join(stateDir(f.home), 'pending', digest(f.ids.main) + '.json');
    const temp = join(stateDir(f.home), 'pending', `.session-deletion-write-${process.pid}-0-${'a'.repeat(24)}`);
    await fs.rename(committed, temp);
    assert.deepEqual(await listRequests(f.home), []); assert.equal(await exists(temp), true);
    await sweep(f.home);
    assert.equal((await scanSessions(f.home)).size, 5); assert.equal(await exists(temp), false);
  } finally { await f.cleanup(); }
});

void test('GC size preview is read-only, excludes live attachments and counts hard-linked aliases once', async () => {
  const f = await fixture();
  try {
    const orphan = digest('never referenced');
    const object = attachment(f, orphan, 'file-objects');
    await f.write(object, Buffer.alloc(2048));
    const aliases = attachment(f, orphan, 'files');
    await fs.mkdir(aliases, { recursive: true });
    await fs.link(object, join(aliases, 'first.txt'));
    await fs.link(object, join(aliases, 'second.txt'));
    const linked = attachment(f, digest('unfinished staging'));
    const temp = join(f.home, 'attachments/v1/tmp', randomBytes(16).toString('hex'));
    await f.write(linked, 'staged bytes');
    await fs.mkdir(join(temp, '..'), { recursive: true });
    await fs.link(linked, temp);
    const before = await fileSnapshot(f.home);
    assert.equal(await garbageSize(f.home), 2048 + Buffer.byteLength('derived image'));
    assert.deepEqual(await fileSnapshot(f.home), before);
    await collectGarbage(f.home);
    assert.equal(await exists(linked), false);
    assert.equal(await fs.readFile(temp, 'utf8'), 'staged bytes');
    assert.equal(await garbageSize(f.home), 0);
  } finally { await f.cleanup(); }
});

void test('failed size reads stop dispatching and finish outstanding reads before returning', async () => {
  const f = await fixture(); const lstat = fs.lstat;
  let started = 0, active = 0;
  const failure = new Error('Injected size read failure');
  try {
    for (let i = 0; i < 32; i++) await f.write(attachment(f, digest('orphan-' + i)), 'orphan');
    fs.lstat = (async (...[path, ...args]: Parameters<typeof lstat>) => {
      if (args[0]?.bigint) {
        if (++started === 1) throw failure;
        active++;
        try { await new Promise(resolve => setTimeout(resolve, 10)); return await lstat(path, ...args); }
        finally { active--; }
      }
      return lstat(path, ...args);
    }) as typeof lstat;
    syncBuiltinESMExports();
    await assert.rejects(garbageSize(f.home), error => error === failure);
    assert.equal(active, 0, 'no I/O may outlive a failed scan');
    assert.ok(started <= 16, 'failure must stop workers from picking up the remaining files');
  } finally { fs.lstat = lstat; syncBuiltinESMExports(); await f.cleanup(); }
});

void test('GC removes all unreferenced objects and aliases, including never-referenced orphans', async () => {
  const f = await fixture();
  try {
    await f.queue(); await sweep(f.home);
    const orphan = digest('never referenced');
    await f.write(attachment(f, orphan), 'orphan');
    await f.write(join(attachment(f, orphan, 'files'), 'orphan.txt'), 'orphan');
    const result = await collectGarbage(f.home);
    assert.deepEqual(result, { total: 3, objects: 3, fileLinks: 2, cacheFiles: 1, uploadMappings: 1 });
    assert.equal(await exists(attachment(f, f.exclusive)), false);
    assert.equal(await exists(attachment(f, orphan)), false);
    assert.equal(await exists(attachment(f, f.shared)), true);
    assert.equal(await exists(join(f.home, 'cache/attachments/request-images')), false);
    assert.equal((await scanSessions(f.home)).size, 2);
    assert.equal(await exists(f.spill), true);
    assert.deepEqual(await collectGarbage(f.home), { total: 0, objects: 0, fileLinks: 0, cacheFiles: 0, uploadMappings: 0 });
  } finally { await f.cleanup(); }
});

void test('a live snapshot adds references to those in the persisted session', async () => {
  const f = await fixture();
  try {
    // Leave the log as the exclusive image's only reference.
    await fs.rm(join(f.home, 'storages/session_projcache/sessions', f.ids.main + '.json'));
    const hash = digest('staged alongside a disk log');
    const object = attachment(f, hash);
    await f.write(object, 'staged');
    const snapshots = [{ header: f.headers[f.ids.main], events: ['sha256:' + hash] }];
    assert.equal(await garbageSize(f.home, { snapshots }), Buffer.byteLength('derived image'));
    await collectGarbage(f.home, { snapshots });
    assert.ok(await exists(object));
    assert.ok(await exists(attachment(f, f.exclusive)));
  } finally { await f.cleanup(); }
});

void test('GC protects staged uploads in a live session without a materialized log', async () => {
  const f = await fixture();
  try {
    await f.queue(); await sweep(f.home);
    const hooks = { snapshots: [{
      header: { id: 'unsaved', version: 4, createdAt: 999 }, events: [{ attachmentId: 'sha256:' + f.exclusive }],
    }] };
    assert.equal(await garbageSize(f.home, hooks), Buffer.byteLength('derived image'));
    await collectGarbage(f.home, hooks);
    assert.equal(await exists(attachment(f, f.exclusive)), true);
  } finally { await f.cleanup(); }
});

for (const separator of ['/', '\\']) void test(`GC protects literal attachment paths using ${separator} and non-session storage references`, async () => {
  const f = await fixture();
  try {
    await f.queue(); await sweep(f.home);
    await f.session(f.ids.other, {}, [join(attachment(f, f.exclusive, 'files'), 'name.txt').replaceAll('\\', '/').replaceAll('/', separator)]);
    const stored = digest('stored elsewhere'); await f.write(attachment(f, stored), 'keep');
    await f.write(join(f.home, 'storages/other.json'), JSON.stringify({ tables: { bookmarks: { ['sha256:' + stored]: { note: 'keep' } } } }));
    await collectGarbage(f.home);
    assert.equal(await exists(attachment(f, f.exclusive)), true); assert.equal(await exists(attachment(f, stored)), true);
  } finally { await f.cleanup(); }
});

for (const backup of ['session-other/session.v4.jsonl~', 'SESSION.V4.JSONL.BAK']) {
  void test(`GC stops before reclaiming an image referenced only by ${backup}`, async () => {
    const f = await fixture();
    try {
      const hash = digest('backup-only image'), image = attachment(f, hash);
      await f.write(image, 'image bytes');
      await f.write(join(f.sessionProject, backup), JSON.stringify(f.headers[f.ids.other]) + '\n'
        + JSON.stringify({ attachmentId: 'sha256:' + hash }) + '\n');
      await assert.rejects(garbageSize(f.home), /Unclassified backup log/);
      await assert.rejects(collectGarbage(f.home), /Unclassified backup log/);
      assert.equal(await fs.readFile(image, 'utf8'), 'image bytes');
    } finally { await f.cleanup(); }
  });
}

for (const mode of ['corrupt', 'torn', 'backup-only', 'symlink', 'referenced-symlink', 'opaque']) void test(`GC ${mode} preflight failure deletes nothing`, async () => {
  const f = await fixture();
  try {
    const log = join(f.sessionProject, f.ids.other, 'session.v4.jsonl.zstd');
    if (mode === 'corrupt') await fs.writeFile(log, 'corrupt');
    if (mode === 'backup-only') await fs.rename(log, log + '.bak');
    if (mode === 'torn') await fs.appendFile(log, zstdCompressSync('{"tail":true}\n').subarray(0, 7));
    if (mode === 'symlink') await fs.symlink(f.base, join(f.home, 'attachments/v1/objects', 'ff'), 'junction');
    if (mode === 'referenced-symlink') await fs.symlink(join(f.home, 'attachments/v1/objects'), join(attachment(f, f.exclusive, 'files'), 'bad-link'), 'junction');
    if (mode === 'opaque') await f.write(join(f.home, 'storages/unknown.bin'), 'opaque');
    await assert.rejects(garbageSize(f.home));
    await assert.rejects(collectGarbage(f.home));
    assert.equal(await exists(attachment(f, f.exclusive)), true);
    assert.equal(await exists(join(f.home, 'cache/attachments/request-images/ab/cache')), true);
  } finally { await f.cleanup(); }
});

for (let step = 1; step <= 5; step++) void test(`GC interruption ${step} permits a fresh safe scan`, async () => {
  const f = await fixture();
  try {
    await f.queue(); await sweep(f.home);
    await assert.rejects(collectGarbage(f.home, { failAfter: step }), /Injected GC interruption/);
    // A new upload/reference after the failure must not be swept by a stale plan.
    await f.write(attachment(f, f.exclusive), 'new upload');
    await f.session(f.ids.other, {}, ['sha256:' + f.exclusive]);
    await collectGarbage(f.home);
    assert.equal(await fs.readFile(attachment(f, f.exclusive), 'utf8'), 'new upload');
    assert.equal(await exists(attachment(f, f.shared)), true);
    assert.deepEqual(await listRequests(f.home), []);
  } finally { await f.cleanup(); }
});
