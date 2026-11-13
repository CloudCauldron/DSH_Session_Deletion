export interface LocalizedMessage {
    key: string;
    params?: Record<string, string | number>;
}
export declare const dictionaries: Record<string, Record<string, string>>;
export declare function message(key: string, params?: LocalizedMessage['params']): LocalizedMessage;
export declare class LocalizedError extends Error {
    readonly messages: LocalizedMessage[];
    constructor(key: string | LocalizedMessage[], params?: LocalizedMessage['params']);
}
