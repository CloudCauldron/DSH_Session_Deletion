import { readFileSync, readdirSync } from 'node:fs';
const directory = new URL('../locale/', import.meta.url);
function readMessages(file) {
    const { messages } = JSON.parse(readFileSync(new URL(file, directory), 'utf8'));
    if (!messages || typeof messages !== 'object' || Array.isArray(messages)
        || !Object.values(messages).every(value => typeof value === 'string'))
        throw new Error(`Invalid locale dictionary: ${file}`);
    return messages;
}
const english = readMessages('en.json');
export const dictionaries = { en: english };
let files = [];
try {
    files = readdirSync(directory);
}
catch { /* en.json can be readable even when the directory cannot be listed. */ }
for (const file of files) {
    if (file.toLowerCase() === 'en.json' || !/^[a-z]{2,8}(?:-[a-z0-9]{1,8})*\.json$/i.test(file))
        continue;
    try {
        dictionaries[file.slice(0, -5).toLowerCase()] = readMessages(file);
    }
    catch { /* An unavailable translation leaves DSH's English fallback in effect. */ }
}
export function message(key, params) {
    return { key, ...params === undefined ? {} : { params } };
}
export class LocalizedError extends Error {
    messages;
    diagnostic;
    constructor(key, params, options) {
        const locale = options?.locale?.toLowerCase() ?? 'en';
        const dict = dictionaries[locale] ?? dictionaries[locale.split('-')[0]];
        const template = (key) => dict?.[key] ?? english[key] ?? key;
        const messages = typeof key === 'string' ? [message(key, params)] : [...key];
        const raw = [];
        for (const cause of options?.failures ?? []) {
            if (cause instanceof LocalizedError) {
                messages.push(...cause.messages);
                if (cause.diagnostic !== undefined)
                    raw.push(cause.diagnostic);
            }
            else
                raw.push(cause instanceof Error ? cause.message : String(cause));
        }
        const translated = messages.map(item => template(item.key).replace(/\{(\w+)\}/g, (match, name) => String(item.params?.[name] ?? match)));
        super([...translated, ...raw].join(template('error.separator')), options);
        this.messages = messages;
        if (raw.length)
            this.diagnostic = raw.join('\n');
    }
}
