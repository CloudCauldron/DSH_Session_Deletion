import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { pathToFileURL } from 'node:url';
import type { DeletionRuntime } from '../lib/runtime.js';
import { WebServer } from '@deepseek-ai/dsh-host-webserver';
import { registerRoutes, type HostContext } from '../lib/host.js';

void test('the HTTP route releases its native registration before remount', async () => {
  const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-host-webserver'));
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const webServer = new WebServer(new Context(), { host: '127.0.0.1', port: 0 });
  let dispose!: () => void;
  const ctx: HostContext = {
    webServer, connection: { fetch: { register: () => async () => {} }, admit: () => ({ rejection: 401 }) },
    effect(register: () => () => void) { dispose = register(); },
  };
  const runtime = { home: resolve('.') } as DeletionRuntime;
  registerRoutes(ctx, runtime);
  dispose();
  registerRoutes(ctx, runtime);
  dispose();
  assert.doesNotThrow(() => webServer.register({ kind: 'prefix', path: '/session-deletion/api', handler() {} })());
});
