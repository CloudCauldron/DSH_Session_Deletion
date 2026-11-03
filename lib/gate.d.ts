export interface Gate {
    home: string;
    version: string;
    healthy(): boolean;
}
export interface GateContext {
    provide(name: string, value: Gate): unknown;
}
export declare const name = "session-deletion-gate";
export declare function apply(ctx: GateContext): Promise<void>;
