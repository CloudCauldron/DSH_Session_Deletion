export type Messages = Record<string, string>;
export type Dictionaries = Record<string, Messages>;
export interface LocalizedMessage { key: string; params?: Record<string, string | number> }
export interface Failure { error: string; messages?: LocalizedMessage[]; diagnostic?: string }
export interface LocalizedProps { t(key: string, params?: LocalizedMessage['params']): string }

export function message(key: string, params?: LocalizedMessage['params']): LocalizedMessage {
  return params === undefined ? { key } : { key, params };
}

export function isDictionary(value: unknown): value is Messages {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    && Object.values(value).every(entry => typeof entry === 'string');
}

export function catalogUrl(id: string) { return `api/${id}/locales`; }
