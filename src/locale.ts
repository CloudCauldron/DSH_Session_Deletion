import { readFileSync, readdirSync } from 'node:fs';

export interface LocalizedMessage { key: string; params?: Record<string, string | number> }
const directory = new URL('../locale/', import.meta.url);

function readMessages(file: string): Record<string, string> {
  const { messages } = JSON.parse(readFileSync(new URL(file, directory), 'utf8'));
  if (!messages || typeof messages !== 'object' || Array.isArray(messages)
    || !Object.values(messages).every(value => typeof value === 'string')) throw new Error(`Invalid locale dictionary: ${file}`);
  return messages as Record<string, string>;
}

const english = readMessages('en.json');
export const dictionaries: Record<string, Record<string, string>> = { en: english };
let files: string[] = [];
try { files = readdirSync(directory); }
catch { /* en.json can be readable even when the directory cannot be listed. */ }
for (const file of files) {
  if (file.toLowerCase() === 'en.json' || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*\.json$/i.test(file)) continue;
  try { dictionaries[file.slice(0, -5).toLowerCase()] = readMessages(file); }
  catch { /* An unavailable translation leaves DSH's English fallback in effect. */ }
}

export function message(key: string, params?: LocalizedMessage['params']): LocalizedMessage {
  return { key, ...params === undefined ? {} : { params } };
}

type DiagnosticOptions = ErrorOptions & { locale?: string; failures?: readonly unknown[] };

export class LocalizedError extends Error {
  readonly messages: LocalizedMessage[];
  readonly diagnostic?: string;

  constructor(key: string | LocalizedMessage[], params?: LocalizedMessage['params'], options?: DiagnosticOptions) {
    const locale = options?.locale?.toLowerCase() ?? 'en';
    const dict = dictionaries[locale] ?? dictionaries[locale.split('-')[0]];
    const template = (key: string) => dict?.[key] ?? english[key] ?? key;
    const messages = typeof key === 'string' ? [message(key, params)] : [...key];
    const raw: string[] = [];
    for (const cause of options?.failures ?? []) {
      if (cause instanceof LocalizedError) {
        messages.push(...cause.messages);
        if (cause.diagnostic !== undefined) raw.push(cause.diagnostic);
      } else raw.push(cause instanceof Error ? cause.message : String(cause));
    }
    const translated = messages.map(item => template(item.key).replace(/\{(\w+)\}/g,
      (match, name: string) => String(item.params?.[name] ?? match)));
    super([...translated, ...raw].join(template('error.separator')), options);
    this.messages = messages;
    if (raw.length) this.diagnostic = raw.join('\n');
  }
}
