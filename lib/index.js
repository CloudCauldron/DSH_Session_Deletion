import * as gate from './gate.js';
import * as runtime from './runtime.js';
import * as host from './host.js';
export const name = 'session-deletion';
export async function apply(ctx) {
    // Awaiting a pending fiber does not wait for its dependencies. Keep this Loader
    // entry loading until HTTP registration finishes, while each child owns its lifecycle.
    await new Promise((resolve, reject) => {
        const off = ctx.on('internal/plugin', fiber => {
            if (fiber === ctx.fiber && fiber.uid === null)
                resolve();
        });
        const mount = (plugin, ready) => {
            ctx.plugin({ ...plugin, async apply(child) {
                    try {
                        await plugin.apply(child);
                        ready?.();
                    }
                    catch (error) {
                        off();
                        reject(error);
                        throw error;
                    }
                } });
        };
        mount(gate);
        mount(runtime);
        mount(host, () => { off(); resolve(); });
    });
}
