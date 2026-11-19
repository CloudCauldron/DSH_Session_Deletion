export interface LocalizedMessage {
    key: string;
    params?: Record<string, string | number>;
}
export declare const dictionaries: Record<string, Record<string, string>>;
export declare function message(key: string, params?: LocalizedMessage['params']): LocalizedMessage;
type DiagnosticOptions = ErrorOptions & {
    locale?: string;
    failures?: readonly unknown[];
};
export declare class LocalizedError extends Error {
    readonly messages: LocalizedMessage[];
    readonly diagnostic?: string;
    constructor(key: string | LocalizedMessage[], params?: LocalizedMessage['params'], options?: DiagnosticOptions);
    /** Keep the original English CLI diagnostic while exposing its keys to the browser. */
    static english(key: string, params?: LocalizedMessage['params'], options?: DiagnosticOptions): LocalizedError;
}
export {};
