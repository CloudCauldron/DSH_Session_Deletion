import { type Dictionaries, type Failure, type LocalizedMessage, type LocalizedProps } from './shared.ts';
export interface LocaleClientContext {
    fiber: {
        uid: number | null;
    };
    effect(register: () => () => void, label: string): unknown;
    locale: {
        register(namespace: string, dictionaries: Dictionaries): () => void;
    };
}
export declare function registerClientLocale(ctx: LocaleClientContext, namespace: string, id?: string): Promise<void>;
export declare class ApiError extends Error {
    readonly status: number;
    readonly failure: Failure;
    constructor(failure: Failure, status: number);
}
export declare function asFailure(error: unknown): Failure;
export declare function readFailure(response: Response): Promise<Failure>;
type ReactAPI = typeof import('react');
export declare function withCode(React: ReactAPI, template: string, params?: LocalizedMessage['params']): import('react').ReactNode;
export declare function renderFailure(React: ReactAPI, t: LocalizedProps['t'], failure: Failure): import('react').ReactNode;
export {};
