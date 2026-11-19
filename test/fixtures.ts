import * as fs from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { zstdCompressSync } from 'node:zlib';
import { digest, encodeSegment, enqueue, planSessionDeletion } from '../lib/core.js';
import type { SessionHeader } from '../lib/core.js';

export async function fixture() {
  const base = await fs.mkdtemp(join(tmpdir(), 'dsh-deletion-测试 空格-'));
  const home = join(base, 'home'); const temporary = join(base, 'tmp');
  await fs.mkdir(home, { mode: 0o700 }); await fs.mkdir(temporary, { mode: 0o700 });
  const exclusive = digest('exclusive attachment'); const shared = digest('shared attachment');
  const ids = { main: 'session-main', child: 'session-child', grand: 'session-grand', fork: 'session-fork', other: 'session-other' };
  const write = async (path: string, value: string | Buffer) => { await fs.mkdir(join(path, '..'), { recursive: true, mode: 0o700 }); await fs.writeFile(path, value, { mode: 0o600 }); };
  const headers: Record<string, SessionHeader> = {};
  async function session(id: string, extra: Partial<SessionHeader> = {}, refs: unknown[] = []) {
    const header: SessionHeader = { type: 'session', version: 4, id, createdAt: 1234, cwd: '/project', isSeeded: false, ...extra };
    headers[id] = header;
    const path = join(home, 'sessions', 'project', encodeSegment(id), 'session.v4.jsonl.zstd');
    // Real persistence uses concatenated independent Zstandard frames.
    await write(path, Buffer.concat([zstdCompressSync(JSON.stringify(header) + '\n'),
      zstdCompressSync(JSON.stringify({ type: 'user/message', seq: 0, data: { content: refs } }) + '\n')]));
    if (process.platform !== 'win32') await write(join(path, '..', 'session.lock'), '');
    await write(join(home, 'storages/session_projcache/sessions', encodeSegment(id) + '.json'), JSON.stringify({ version: 1, record: { title: id, refs } }));
  }
  const spillRoot = await fs.mkdtemp(join(temporary, 'dsh-spill-'));
  const spillDir = join(spillRoot, 'session-' + digest(ids.main).slice(0,12));
  const spill = join(spillDir, 'abcdef-output.txt'); const sharedSpill = join(spillDir, 'abcdef-shared.txt');
  await write(spill, 'private transcript spill'); await write(sharedSpill, 'inherited spill');
  await session(ids.main, {}, ['sha256:' + exclusive, 'sha256:' + shared, spill, sharedSpill]);
  await session(ids.child, { parentSession: ids.main, origin: 'subagent', delegationDepth: 1 });
  await session(ids.grand, { parentSession: ids.child, origin: 'subagent', delegationDepth: 2 });
  await session(ids.fork, { parentSession: ids.main, isSeeded: true }, ['sha256:' + shared, sharedSpill]);
  await session(ids.other);
  for (const hash of [exclusive, shared]) {
    await write(join(home, 'attachments/v1/objects', hash.slice(0,2), hash), 'image');
    await write(join(home, 'attachments/v1/file-objects', hash.slice(0,2), hash), 'file');
    await write(join(home, 'attachments/v1/files', hash.slice(0,2), hash, 'name.txt'), 'file');
  }
  await write(join(home, 'cache/attachments/request-images/ab/cache'), 'derived image');
  await write(join(home, 'storages/workspace.json'), JSON.stringify({ unit: { name: 'workspace', version: 1 },
    global: { archivedSessionIds: [ids.main], pinnedSessionIds: [ids.child, ids.other], initialized: true },
    tables: { workspaces: { project: { title: 'Project', path: '/project', sessionIds: Object.values(ids), createdAt: 0, updatedAt: 1 } } } }));
  await write(join(home, 'storages/schedule.json'), JSON.stringify({ unit: { name: 'schedule', version: 1 },
    tables: { tasks: { a: { sessionId: ids.main }, b: { sessionId: ids.child }, c: { sessionId: ids.fork } } } }));
  await write(join(home, 'llm-deepseek/files-v3.json'), JSON.stringify({ formatVersion: 3, records: [exclusive, shared].map(hash => ({
    scope: 'c'.repeat(64), attachmentId: 'sha256:' + hash, variantId: 'sha256:' + hash, fileId: 'file-' + hash,
    bytes: 5, createdAt: 1, expiresAt: 3600001,
  })) }));
  const projectFile = join(base, 'project-file.txt'); await write(projectFile, 'user project must survive');
  return { base, home, temporary, ids, headers, exclusive, shared, spillRoot, spill, sharedSpill, write, session, projectFile,
    queue: async () => enqueue(home, headers[ids.main], await planSessionDeletion(home, new Map(Object.entries(headers)), ids.main)),
    cleanup: () => fs.rm(base, { recursive: true, force: true }) };
}

