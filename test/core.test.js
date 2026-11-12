import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as fs from 'node:fs/promises';
import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { zstdCompressSync } from 'node:zlib';
import { scanSessions, sweep, collectGarbage, exists, digest, encodeSegment, listRequests, readJSON, stateDir, enqueue, planSessionDeletion, atomicJSON, safePath } from '../lib/core.js';
import { birth } from '../lib/platform/index.js';
import { fixture } from './fixtures.js';

const attachment = (f, hash, kind = 'objects') => join(f.home, 'attachments/v1', kind, hash.slice(0, 2), hash);

test('atomic writes identify their process owner and preserve the committed file when serialization fails', async () => {
  const f = await fixture();
  try {
    const path = join(stateDir(f.home), 'receipt.json');
    await atomicJSON(path, { committed: true });
    const prefix = `.session-deletion-write-${process.pid}-${await birth(process.pid)}-`;
    let temporary;
    await assert.rejects(atomicJSON(path, { toJSON() {
      // Serialization runs only after the temporary file has been opened.
      temporary = readdirSync(stateDir(f.home));
      throw new Error('serialization interrupted');
    } }), /serialization interrupted/);
    assert.ok(temporary.some(name => name.startsWith(prefix)));
    assert.deepEqual(await readJSON(path), { committed: true });
    assert.deepEqual(await fs.readdir(stateDir(f.home)), ['receipt.json']);
  } finally { await f.cleanup(); }
});

test('receipts retain all hashes and advance revision after each deletion', async () => {
  const f = await fixture();
  try {
    const path = join(stateDir(f.home), 'receipt.json');
    const previous = Array.from({ length: 4100 }, (_, i) => digest('previous-session-' + i));
    await atomicJSON(path, { schema: 1, revision: 'a'.repeat(32), deletedIdHashes: previous });
    await f.queue(); await sweep(f.home);
    const first = await readJSON(path);
    assert.deepEqual(first.deletedIdHashes.slice(0, previous.length), previous);
    assert.equal(first.deletedIdHashes.length, previous.length + 3);
    assert.match(first.revision, /^[a-f0-9]{32}$/);
    await enqueue(f.home, f.headers[f.ids.other], await planSessionDeletion(f.home, new Map(Object.entries(f.headers)), f.ids.other));
    await sweep(f.home);
    const second = await readJSON(path);
    assert.notEqual(second.revision, first.revision);
    assert.deepEqual(second.deletedIdHashes.slice(0, first.deletedIdHashes.length), first.deletedIdHashes);
  } finally { await f.cleanup(); }
});
async function fileSnapshot(root) {
  const files = {};
  async function visit(path) {
    for (const entry of await fs.readdir(path, { withFileTypes: true })) {
      const file = join(path, entry.name);
      if (entry.isDirectory()) await visit(file); else files[file] = digest(await fs.readFile(file));
    }
  }
  await visit(root); return files;
}

test('private deletion preserves every attachment, cache, upload mapping and temporary file', async () => {
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
    const workspace = await readJSON(join(f.home, 'storages/workspace.json'));
    assert.deepEqual(workspace.tables.workspaces.project.sessionIds, [f.ids.fork, f.ids.other]);
    assert.deepEqual(workspace.global.pinnedSessionIds, [f.ids.other]);
    assert.deepEqual(Object.keys((await readJSON(join(f.home, 'storages/schedule.json'))).tables.tasks), ['c']);
    assert.equal((await listRequests(f.home)).length, 0);
    assert.ok(!(await fs.readFile(join(stateDir(f.home), 'receipt.json'), 'utf8')).includes(f.ids.main));
  } finally { await f.cleanup(); }
});

for (let step = 1; step <= 11; step++) test(`private deletion interruption ${step} recovers without touching attachments`, async () => {
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

test('unrelated corrupt logs and opaque attachment storage do not block private deletion', async () => {
  const f = await fixture();
  try {
    await fs.writeFile(join(f.home, 'sessions/project', f.ids.other, 'session.v4.jsonl.zstd'), 'corrupt');
    await f.write(join(f.home, 'storages/unrelated.bin'), 'opaque');
    await f.queue(); await sweep(f.home);
    assert.equal(await exists(join(f.home, 'sessions/project', f.ids.main)), false);
    assert.equal(await exists(attachment(f, f.exclusive)), true);
  } finally { await f.cleanup(); }
});

test('target symlink or changed lifecycle refuses private deletion', async () => {
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

test('path checks reject symlink/junction ancestors even when the leaf does not exist', async () => {
  const f = await fixture();
  try {
    const link = join(f.home, 'external');
    await fs.symlink(f.base, link, 'junction');
    await assert.rejects(safePath(join(link, 'project-file.txt')), /symlink/);
    await assert.rejects(safePath(join(link, 'missing'), { missing: true }), /symlink/);
  } finally { await f.cleanup(); }
});

test('plan validation rejects invalid schemas and traversal', async () => {
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
    const request = await readJSON(path);
    await f.write(path, JSON.stringify({ ...request, schema: 'invalid' }));
    await assert.rejects(sweep(f.home), /Invalid deletion request/);
    plan.directories[0].path = '../outside';
    await f.write(path, JSON.stringify({ ...request, plan }));
    await assert.rejects(sweep(f.home), /Invalid deletion plan path/);
  } finally { await f.cleanup(); }
});

test('uncommitted requests are ignored and never authorize deletion', async () => {
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

test('GC removes all unreferenced objects and aliases, including never-referenced orphans', async () => {
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

test('GC protects staged uploads in a live session without a materialized log', async () => {
  const f = await fixture();
  try {
    await f.queue(); await sweep(f.home);
    await collectGarbage(f.home, { hooks: { snapshots: async () => new Map([['unsaved', {
      header: { id: 'unsaved', version: 4, createdAt: 999 }, events: [{ attachmentId: 'sha256:' + f.exclusive }],
    }]]) } });
    assert.equal(await exists(attachment(f, f.exclusive)), true);
  } finally { await f.cleanup(); }
});

for (const separator of ['/', '\\']) test(`GC protects literal attachment paths using ${separator} and non-session storage references`, async () => {
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

for (const mode of ['corrupt', 'torn', 'symlink', 'opaque']) test(`GC ${mode} preflight failure deletes nothing`, async () => {
  const f = await fixture();
  try {
    const log = join(f.home, 'sessions/project', f.ids.other, 'session.v4.jsonl.zstd');
    if (mode === 'corrupt') await fs.writeFile(log, 'corrupt');
    if (mode === 'torn') await fs.appendFile(log, zstdCompressSync('{"tail":true}\n').subarray(0, 7));
    if (mode === 'symlink') await fs.symlink(f.base, join(f.home, 'attachments/v1/objects', 'ff'), 'junction');
    if (mode === 'opaque') await f.write(join(f.home, 'storages/unknown.bin'), 'opaque');
    await assert.rejects(collectGarbage(f.home));
    assert.equal(await exists(attachment(f, f.exclusive)), true);
    assert.equal(await exists(join(f.home, 'cache/attachments/request-images/ab/cache')), true);
  } finally { await f.cleanup(); }
});

for (let step = 1; step <= 5; step++) test(`GC interruption ${step} permits a fresh safe scan`, async () => {
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
