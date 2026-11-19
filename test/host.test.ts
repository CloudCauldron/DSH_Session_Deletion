import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import { WebServer } from '@deepseek-ai/dsh-host-webserver';
import { apply, type HostContext } from '../lib/host.js';

void test('the HTTP route releases its native registration before remount', async () => {
  const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-host-webserver'));
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const webServer = new WebServer(new Context(), { host: '127.0.0.1', port: 0 });
  let dispose!: () => void;
  const ctx: HostContext = {
    webServer, sessionDeletionRuntime: {} as HostContext['sessionDeletionRuntime'], connection: { fetch: { register: () => async () => {} }, admit: () => ({ rejection: 401 }) },
    sessionDeletionGate: { home: resolve('.'), version: '0.2.2-rc.5', healthy: () => true },
    sessionPersistence: { name: 'session-persistence-jsonl', root: resolve('sessions') },
    effect(register: () => () => void) { dispose = register(); },
  };
  await apply(ctx);
  dispose();
  await apply(ctx);
  dispose();
  assert.doesNotThrow(() => webServer.register({ kind: 'prefix', path: '/session-deletion/api', handler() {} })());
});
