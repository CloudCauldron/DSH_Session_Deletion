export type Messages = Record<string, string>;
export type Dictionaries = Record<string, Messages>;
export interface LocalizedMessage {
    key: string;
    params?: Record<string, string | number>;
}
export interface Failure {
    error: string;
    messages?: LocalizedMessage[];
    diagnostic?: string;
}
export interface LocalizedProps {
    t(key: string, params?: LocalizedMessage['params']): string;
}
export declare function message(key: string, params?: LocalizedMessage['params']): LocalizedMessage;
export declare function isDictionary(value: unknown): value is Messages;
export declare function catalogUrl(id: string): string;
