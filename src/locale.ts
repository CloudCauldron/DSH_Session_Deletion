import { readFileSync, readdirSync } from 'node:fs';

export interface LocalizedMessage { key: string; params?: Record<string, string | number> }
interface LocaleFile { messages?: Record<string, string> }

const directory = new URL('../locale/', import.meta.url);
export const dictionaries: Record<string, Record<string, string>> = Object.fromEntries(
  readdirSync(directory).filter(file => /^[a-z]{2,8}(?:-[a-z0-9]{1,8})*\.json$/i.test(file)).map(file => {
    const locale = JSON.parse(readFileSync(new URL(file, directory), 'utf8')) as LocaleFile;
    return [file.slice(0, -5).toLowerCase(), locale.messages ?? {}];
  }),
);

// Host diagnostics keep a Chinese fallback; the browser translates the same keys
// through DSH's locale service, including errors returned by the HTTP API.
export function message(key: string, params?: LocalizedMessage['params']): LocalizedMessage {
  return { key, ...params === undefined ? {} : { params } };
}

export class LocalizedError extends Error {
  readonly messages: LocalizedMessage[];
  constructor(key: string | LocalizedMessage[], params?: LocalizedMessage['params']) {
    const messages = typeof key === 'string' ? [message(key, params)] : key;
    super(messages.map(item => (dictionaries.zh[item.key] ?? item.key).replace(/\{(\w+)\}/g,
      (match, name: string) => String(item.params?.[name] ?? match))).join(dictionaries.zh['error.separator']));
    this.messages = messages;
  }
}
