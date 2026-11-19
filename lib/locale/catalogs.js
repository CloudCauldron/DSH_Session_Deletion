import { readFileSync, readdirSync } from 'node:fs';
import { LocalizedError } from './errors.js';
import { catalogUrl, isDictionary } from './shared.js';
function readMessages(file) {
    const messages = JSON.parse(readFileSync(file, 'utf8'))?.messages;
    if (!isDictionary(messages))
        throw new LocalizedError('error.invalidLocaleDictionary');
    return messages;
}
export function readDictionaries(directory = new URL('../../locale/', import.meta.url)) {
    const dictionaries = { en: readMessages(new URL('en.json', directory)) };
    let files;
    try {
        files = readdirSync(directory);
    }
    catch {
        return dictionaries;
    } // English may be readable without directory-list permission.
    for (const file of files) {
        if (file.toLowerCase() === 'en.json' || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*\.json$/i.test(file))
            continue;
        try {
            dictionaries[file.slice(0, -5).toLowerCase()] = readMessages(new URL(file, directory));
        }
        catch { /* An unavailable translation leaves DSH's English fallback in effect. */ }
    }
    return dictionaries;
}
export function registerCatalogs(routes, id, directory) {
    let dictionaries;
    return routes.register({
        path: '/' + catalogUrl(id), methods: ['GET'], requestBody: 'buffered',
        async fetch() {
            try {
                dictionaries ??= readDictionaries(directory);
                return Response.json({ ok: true, dictionaries });
            }
            catch {
                return Response.json({ ok: false }, { status: 500 });
            }
        },
    });
}
