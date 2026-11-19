import { type Failure, type LocalizedMessage } from './shared.ts';
type Params = LocalizedMessage['params'];
export declare function describeFailure(error: unknown): Failure;
export declare class LocalizedError extends Error {
    readonly messages: LocalizedMessage[];
    readonly diagnostic?: string;
    constructor(key: string | LocalizedMessage[], params?: Params, options?: ErrorOptions & {
        failures?: readonly unknown[];
        fallback?: string;
    });
}
export declare class LocalizedAggregateError extends AggregateError {
    readonly messages: LocalizedMessage[];
    readonly diagnostic?: string;
    constructor(errors: Iterable<unknown>, key?: string | LocalizedMessage[], params?: Params, options?: ErrorOptions);
}
export {};
