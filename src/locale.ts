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

type DiagnosticOptions = ErrorOptions & { locale?: 'zh' | 'en'; failures?: readonly unknown[] };

export class LocalizedError extends Error {
  readonly messages: LocalizedMessage[];
  readonly diagnostic?: string;

  constructor(key: string | LocalizedMessage[], params?: LocalizedMessage['params'], options?: DiagnosticOptions) {
    const dict = dictionaries[options?.locale ?? 'zh'];
    const messages = typeof key === 'string' ? [message(key, params)] : [...key];
    const raw: string[] = [];
    for (const cause of options?.failures ?? []) {
      if (cause instanceof LocalizedError) {
        messages.push(...cause.messages);
        if (cause.diagnostic !== undefined) raw.push(cause.diagnostic);
      } else raw.push(cause instanceof Error ? cause.message : String(cause));
    }
    const translated = messages.map(item => (dict[item.key] ?? item.key).replace(/\{(\w+)\}/g,
      (match, name: string) => String(item.params?.[name] ?? match)));
    super([...translated, ...raw].join(dict['error.separator']), options);
    this.messages = messages;
    if (raw.length) this.diagnostic = raw.join('\n');
  }

  /** Keep the original English CLI diagnostic while exposing its keys to the browser. */
  static english(key: string, params?: LocalizedMessage['params'], options?: DiagnosticOptions): LocalizedError {
    return new LocalizedError(key, params, { ...options, locale: 'en' });
  }
}
