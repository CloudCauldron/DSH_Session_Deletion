import { createRuntime, type DeletionRuntime, type RuntimeContext } from './runtime.js';
import { registerRoutes, type HostContext } from './host.js';

interface PluginContext {
  plugin(apply: (ctx: RuntimeContext & HostContext) => Promise<void>): PromiseLike<unknown> & { dispose(): Promise<void> };
  effect(register: () => Iterable<() => void | Promise<void>>, label: string): unknown;
}

export const name = 'session-deletion';
export const inject = ['dshHomePath', 'agents', 'sessions', 'sessionPersistence', 'sessionProjectionCache', 'sessionQuery',
  'workspaceRegistry', 'attachments', 'fileUploads', 'subagents', 'jobs', 'sessionController', 'schedule', 'webServer', 'connection'];

export async function apply(ctx: PluginContext): Promise<void> {
  let runtime: DeletionRuntime | undefined;
  const scope = ctx.plugin(async child => {
    runtime = await createRuntime(child);
    await runtime.initialize();
    child.provide('sessionDeletionRuntime', runtime);
    registerRoutes(child, runtime);
  });
  // Cordis drains a single effect in reverse order. Keep the child and its
  // native event subscriptions live until admitted maintenance finishes.
  ctx.effect(function* () {
    yield scope.dispose;
    yield () => runtime?.closeAdmission();
  }, 'session-deletion lifecycle');
  await scope;
}
