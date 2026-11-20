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
  const ctx: HostContext = {
    webServer, connection: { fetch: { register: () => async () => {} }, admit: () => ({ peer: { principal: { kind: 'owner' } } }) },
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
  const preview = await fetch(api + 'preview', { method: 'POST', headers: {
    'Content-Type': 'application/json', 'X-DSH-Session-Deletion': '1',
  }, body: JSON.stringify({ sessionId: f.ids.main }) });
  assert.equal(preview.status, 200);
  assert.equal((await preview.json()).count, 3);
  assert.equal(hashes(), 0);
  dispose();
  assert.doesNotThrow(() => webServer.register({ kind: 'prefix', path: '/session-deletion/api', handler() {} })());
});
