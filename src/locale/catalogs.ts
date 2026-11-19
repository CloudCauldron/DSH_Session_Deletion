import { readFileSync, readdirSync } from 'node:fs';
import type { HostConnectionFetch } from '@deepseek-ai/dsh-client-connection';
import { LocalizedError } from './errors.ts';
import { catalogUrl, isDictionary, type Dictionaries } from './shared.ts';

function readMessages(file: URL) {
  const messages: unknown = JSON.parse(readFileSync(file, 'utf8'))?.messages;
  if (!isDictionary(messages)) throw new LocalizedError('error.invalidLocaleDictionary');
  return messages;
}

export function readDictionaries(directory = new URL('../../locale/', import.meta.url)): Dictionaries {
  const dictionaries: Dictionaries = { en: readMessages(new URL('en.json', directory)) };
  let files: string[];
  try { files = readdirSync(directory); }
  catch { return dictionaries; } // English may be readable without directory-list permission.
  for (const file of files) {
    if (file.toLowerCase() === 'en.json' || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*\.json$/i.test(file)) continue;
    try { dictionaries[file.slice(0, -5).toLowerCase()] = readMessages(new URL(file, directory)); }
    catch { /* An unavailable translation leaves DSH's English fallback in effect. */ }
  }
  return dictionaries;
}

export function registerCatalogs(routes: HostConnectionFetch, id: string, directory?: URL) {
  let dictionaries: Dictionaries | undefined;
  return routes.register({
    path: '/' + catalogUrl(id), methods: ['GET'], requestBody: 'buffered',
    async fetch() {
      try {
        dictionaries ??= readDictionaries(directory);
        return Response.json({ ok: true, dictionaries });
      } catch {
        return Response.json({ ok: false }, { status: 500 });
      }
    },
  });
}
