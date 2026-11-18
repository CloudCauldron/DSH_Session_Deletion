import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { createHash, randomBytes } from 'node:crypto';
import { join } from 'node:path';
import { zstdCompressSync, constants } from 'node:zlib';
import { syncBuiltinESMExports } from 'node:module';
import { scanSessions, sweep, collectGarbage, garbageSize, exists, digest, encodeSegment, listRequests, readJSON, stateDir, enqueue, planSessionDeletion, atomicJSON, safePath, readLog, SUPPORTED_DSH, scheduledSession } from '../lib/core.js';
import type { Receipt, DeletionRequest } from '../lib/core.js';
import { birth } from '../lib/platform/index.js';
import { fixture } from './fixtures.ts';

void test('compressed logs retain every frame across blocks, checksums and input boundaries', async () => {
  const f = await fixture();
  try {
    const header = zstdCompressSync(JSON.stringify(f.headers[f.ids.other]) + '\n');
    const rle = Buffer.from([0x28, 0xb5, 0x2f, 0xfd, 0x20, 20, 0xa3, 0, 0, 10]);
    const metadata = Buffer.alloc(65534 - header.length - rle.length);
    metadata.writeUInt32LE(0x184d2a50); metadata.writeUInt32LE(metadata.length - 8, 4);
    const event = JSON.stringify({ content: randomBytes(2 * 1024 * 1024).toString('base64'), attachmentId: 'sha256:' + f.exclusive }) + '\n';
    const frame = zstdCompressSync(event, { params: { [constants.ZSTD_c_checksumFlag]: 1 } });
    const path = join(f.home, 'sessions/project', f.ids.other, 'session.v4.jsonl.zstd');
    await fs.writeFile(path, Buffer.concat([header, rle, metadata, frame]));
    assert.deepEqual([...(await readLog(path)).refs.hashes], [f.exclusive]);
    await fs.truncate(path, (await fs.stat(path)).size - 1);
    await assert.rejects(readLog(path));
    await fs.writeFile(path, zstdCompressSync('not JSON\n'));
    await assert.rejects(readLog(path), {
      messages: [{ key: 'error.readSessionLog', params: { path } }, { key: 'error.invalidJsonl', params: { path, record: 1 } }],
    });
  } finally { await f.cleanup(); }
});

void test('journals identify the reviewed host version', async () => {
  const f = await fixture();
  try {
    const plan = await planSessionDeletion(f.home, new Map(Object.entries(f.headers)), f.ids.main);
    await enqueue(f.home, f.headers[f.ids.main], plan);
    assert.equal((await listRequests(f.home))[0].dshVersion, SUPPORTED_DSH);
    await sweep(f.home);
    assert.equal((await listRequests(f.home)).length, 0);
  } finally { await f.cleanup(); }
});

void test('unsupported host versions cannot authorize a deletion', async () => {
  const f = await fixture();
  try {
    await f.queue();
    const request = (await listRequests(f.home))[0];
    await atomicJSON(join(stateDir(f.home), 'pending', digest(f.ids.main) + '.json'), { ...request, dshVersion: 'unsupported' });
    await assert.rejects(sweep(f.home), /Invalid deletion request/);
    assert.equal(await exists(join(f.home, 'sessions/project', f.ids.main)), true);
  } finally { await f.cleanup(); }
});

const attachment = (f: Awaited<ReturnType<typeof fixture>>, hash: string, kind = 'objects') => join(f.home, 'attachments/v1', kind, hash.slice(0, 2), hash);

void test('schedule cleanup follows explicit destinations and the native legacy fallback, never actor involvement', async () => {
  const f = await fixture();
  try {
    const path = join(f.home, 'storages/schedule.json');
    await f.write(path, JSON.stringify({ unit: { name: 'schedule', version: 2 }, tables: { tasks: {
      legacy: { sessionId: f.ids.main },
      current: { target: { kind: 'session', sessionId: f.ids.main }, sessionId: f.ids.other },
      child: { target: { kind: 'new_once', sessionId: f.ids.child } },
      rebound: { target: { kind: 'session', sessionId: f.ids.other }, sessionId: f.ids.main },
      independent: { target: { kind: 'new' }, sessionId: f.ids.main },
      involved: { target: { kind: 'session', sessionId: f.ids.other }, involvedSessionIds: [f.ids.main] },
    } } }));
    assert.equal(scheduledSession({ record: { id: 'legacy-unbound' } }), 'session-schedule-' + digest('legacy-unbound'));
    assert.equal(scheduledSession({ target: { kind: 'new_once' }, record: { id: 'reserved' } }), 'session-schedule-' + digest('reserved'));
    await f.queue(); await sweep(f.home);
    const result = await readJSON<{ tables: { tasks: Record<string, unknown> } }>(path);
    assert.deepEqual(Object.keys(result.tables.tasks), ['rebound', 'independent', 'involved']);
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
    await enqueue(f.home, f.headers[f.ids.other], await planSessionDeletion(f.home, new Map(Object.entries(f.headers)), f.ids.other));
    await sweep(f.home);
    const second = await readJSON<Receipt>(path);
    assert.notEqual(second.revision, first.revision);
    assert.deepEqual(second.deletedIdHashes.slice(0, first.deletedIdHashes.length), first.deletedIdHashes);
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
    assert.deepEqual(await fileSnapshot(join(f.home, 'attachments')), before);
  } finally { await f.cleanup(); }
});

void test('unrelated corrupt logs and opaque attachment storage do not block private deletion', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(join(f.home, 'sessions/project', f.ids.other, 'session.v4.jsonl.zstd'), 'corrupt');
    await f.write(join(f.home, 'storages/unrelated.bin'), 'opaque');
    await f.queue(); await sweep(f.home);
    assert.equal(await exists(join(f.home, 'sessions/project', f.ids.main)), false);
    assert.equal(await exists(attachment(f, f.exclusive)), true);
  } finally { await f.cleanup(); }
});

void test('target symlink or changed lifecycle refuses private deletion', async () => {
  const f = await fixture();
  try {
    await f.queue();
    const link = join(f.home, 'sessions/project', f.ids.main, 'external');
    await fs.symlink(f.base, link, 'junction');
    await assert.rejects(sweep(f.home), /symlink/);
    await fs.unlink(link);
    await f.session(f.ids.main, { createdAt: 999 });
    await assert.rejects(sweep(f.home), /identity changed/);
    assert.equal(await fs.readFile(f.projectFile, 'utf8'), 'user project must survive');
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
    const plan = await planSessionDeletion(f.home, new Map(Object.entries(f.headers)), f.ids.main);
    if (process.platform === 'win32') {
      const outside = { ...plan, directories: plan.directories.map(row => ({ ...row, path: `${f.home[0].toUpperCase() === 'Z' ? 'Y' : 'Z'}:\\${row.id}` })) };
      await assert.rejects(enqueue(f.home, f.headers[f.ids.main], outside), /Invalid deletion plan path/);
    }
    await assert.rejects(enqueue(f.home, { ...f.headers[f.ids.main], createdAt: 9 }, plan), /lifecycle/);
    await f.queue();
    const path = join(stateDir(f.home), 'pending', digest(f.ids.main) + '.json');
    const request = await readJSON<DeletionRequest>(path);
    await f.write(path, JSON.stringify({ ...request, schema: 'invalid' }));
    await assert.rejects(sweep(f.home), /Invalid deletion request/);
    plan.directories[0].path = '../outside';
    await f.write(path, JSON.stringify({ ...request, plan }));
    await assert.rejects(sweep(f.home), /Invalid deletion plan path/);
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
    const before = await fileSnapshot(f.home);
    assert.equal(await garbageSize(f.home), 2048 + Buffer.byteLength('derived image'));
    assert.deepEqual(await fileSnapshot(f.home), before);
    await collectGarbage(f.home);
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

void test('GC protects staged uploads in a live session without a materialized log', async () => {
  const f = await fixture();
  try {
    await f.queue(); await sweep(f.home);
    const hooks = { snapshots: async () => new Map([['unsaved', {
      header: { id: 'unsaved', version: 4, createdAt: 999 }, events: [{ attachmentId: 'sha256:' + f.exclusive }],
    }]]) };
    assert.equal(await garbageSize(f.home, hooks.snapshots), Buffer.byteLength('derived image'));
    await collectGarbage(f.home, { hooks });
    assert.equal(await exists(attachment(f, f.exclusive)), true);
  } finally { await f.cleanup(); }
});

for (const separator of ['/', '\\']) void test(`GC protects literal attachment paths using ${separator} and non-session storage references`, async () => {
  const f = await fixture();
  try {
    await f.queue(); await sweep(f.home);
    await f.session(f.ids.other, {}, [join(attachment(f, f.exclusive, 'files'), 'name.txt').replaceAll('\\', '/').replaceAll('/', separator)]);
    const stored = digest('stored elsewhere'); await f.write(attachment(f, stored), 'keep');
    await f.write(join(f.home, 'storages/other.json'), JSON.stringify({ image: 'sha256:' + stored }));
    await collectGarbage(f.home);
    assert.equal(await exists(attachment(f, f.exclusive)), true); assert.equal(await exists(attachment(f, stored)), true);
  } finally { await f.cleanup(); }
});

for (const mode of ['corrupt', 'torn', 'symlink', 'referenced-symlink', 'opaque']) void test(`GC ${mode} preflight failure deletes nothing`, async () => {
  const f = await fixture();
  try {
    const log = join(f.home, 'sessions/project', f.ids.other, 'session.v4.jsonl.zstd');
    if (mode === 'corrupt') await fs.writeFile(log, 'corrupt');
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
