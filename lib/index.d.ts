import { type RuntimeContext } from './runtime.js';
import { type HostContext } from './host.js';
interface PluginContext {
    plugin(apply: (ctx: RuntimeContext & HostContext) => Promise<void>): PromiseLike<unknown> & {
        dispose(): Promise<void>;
    };
    effect(register: () => Iterable<() => void | Promise<void>>, label: string): unknown;
}
export declare const name = "session-deletion";
export declare const inject: string[];
export declare function apply(ctx: PluginContext): Promise<void>;
export {};
