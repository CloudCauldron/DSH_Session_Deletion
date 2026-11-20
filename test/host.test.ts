import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { WebServer } from '@deepseek-ai/dsh-host-webserver';
import { registerRoutes, type HostContext } from '../lib/host.js';
import type { DeletionRuntime } from '../lib/runtime.js';
import { fixture, trackContentHashes } from './fixtures.ts';
import { makeRuntime } from './runtime-fixture.ts';

void test('the remounted HTTP route serves status and deletion preview without hashing transcripts', async t => {
  const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-host-webserver'));
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const root = new Context();
  const server = root.plugin(WebServer, { host: '127.0.0.1', port: 0 });
  t.after(() => server.dispose());
  await server;
  const webServer: WebServer = root.get('webServer');
  let dispose!: () => void;
  let principal = 'owner';
  const ctx: HostContext = {
    webServer, connection: { fetch: { register: () => async () => {} }, admit: () => ({ peer: { principal: { kind: principal } } }) },
    effect(register: () => () => void) { dispose = register(); },
  };
  const f = await fixture();
  t.after(f.cleanup);
  const runtime = makeRuntime({ dshHomePath: () => f.home, workspaceRegistry: { archivedSessionIds: [] },
    sessionQuery: { listSessions: async () => Object.values(f.headers).map(header => ({ header, persisted: true })) } }) as unknown as DeletionRuntime;
  registerRoutes(ctx, runtime);
  dispose();
  registerRoutes(ctx, runtime);
  const hashes = trackContentHashes(t);
  const api = webServer.getOrigin() + '/session-deletion/api/';
  const status = await fetch(api + 'status');
  assert.equal(status.status, 200);
  assert.deepEqual((await status.json()).pending, []);
  const post = (path: string, data: object, marker = '1') => fetch(api + path, { method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-DSH-Session-Deletion': marker }, body: JSON.stringify(data) });
  const sessionId = f.ids.main;
  const preview = await post('preview', { sessionId });
  assert.equal(preview.status, 200);
  const { token, count } = await preview.json();
  assert.equal(count, 3);
  assert.equal(hashes(), 0);
  delete f.headers[sessionId];
  const missing = await post('preview', { sessionId });
  assert.equal(missing.status, 404);
  assert.deepEqual((await missing.json()).messages, [{ key: 'error.sessionMissing' }]);
  const delayed = await post('delete', { sessionId, token, confirmation: 'DELETE_SESSION' });
  assert.equal(delayed.status, 409);
  assert.deepEqual((await delayed.json()).messages, [{ key: 'error.previewExpired' }]);
  const confirmed = { confirmation: 'CLEAR_DELETION_RECORDS', revision: '' };
  assert.equal((await fetch(api + 'clear-records')).status, 405);
  assert.equal((await post('clear-records', confirmed, '')).status, 415);
  for (const data of [{}, { ...confirmed, confirmation: 'DELETE_SESSION' }, { ...confirmed, revision: null }]) {
    const failure = await post('clear-records', data);
    assert.equal(failure.status, 400);
    assert.deepEqual((await failure.json()).messages, [{ key: 'error.confirmRecords' }]);
  }
  principal = 'guest';
  assert.equal((await post('clear-records', confirmed)).status, 403);
  principal = 'owner';
  assert.deepEqual(await (await post('clear-records', confirmed)).json(), { ok: true, cleared: 0, receipt: { count: 0, revision: '' } });
  dispose();
  assert.doesNotThrow(() => webServer.register({ kind: 'prefix', path: '/session-deletion/api', handler() {} })());
});
