interface InternalPlugin<C> {
    name: string;
    inject?: string[];
    apply(ctx: C): Promise<void>;
}
interface Fiber {
    uid: number | null;
}
export interface PluginContext {
    fiber: Fiber;
    plugin<C>(plugin: InternalPlugin<C>): unknown;
    on(name: 'internal/plugin', listener: (fiber: Fiber) => void): () => void;
}
export declare const name = "session-deletion";
export declare function apply(ctx: PluginContext): Promise<void>;
export {};
