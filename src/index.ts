import * as gate from './gate.js';
import * as runtime from './runtime.js';
import * as host from './host.js';

interface InternalPlugin<C> {
  name: string;
  inject?: string[];
  apply(ctx: C): Promise<void>;
}

interface Fiber { uid: number | null }
export interface PluginContext {
  fiber: Fiber;
  plugin<C>(plugin: InternalPlugin<C>): unknown;
  on(name: 'internal/plugin', listener: (fiber: Fiber) => void): () => void;
}

export const name = 'session-deletion';

export async function apply(ctx: PluginContext): Promise<void> {
  // Awaiting a pending fiber does not wait for its dependencies. Keep this Loader
  // entry loading until HTTP registration finishes, while each child owns its lifecycle.
  await new Promise<void>((resolve, reject) => {
    const off = ctx.on('internal/plugin', fiber => {
      if (fiber === ctx.fiber && fiber.uid === null) resolve();
    });
    const mount = <C>(plugin: InternalPlugin<C>, ready?: () => void): void => {
      ctx.plugin({ ...plugin, async apply(child: C): Promise<void> {
        try { await plugin.apply(child); ready?.(); }
        catch (error) { off(); reject(error); throw error; }
      } });
    };
    mount(gate);
    mount(runtime);
    mount(host, () => { off(); resolve(); });
  });
}
