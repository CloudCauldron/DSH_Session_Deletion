import { catalogUrl, isDictionary, message } from './shared.js';
export async function registerClientLocale(ctx, namespace, id = namespace) {
    const response = await fetch(catalogUrl(id), { cache: 'no-store', redirect: 'error' });
    if (ctx.fiber.uid === null)
        return;
    if (!response.ok)
        throw Object.assign(new Error(`Locale catalogs: HTTP ${response.status}`), {
            messages: [message('error.localeHttp', { status: String(response.status) })],
        });
    const data = await response.json();
    if (ctx.fiber.uid === null)
        return;
    const catalogs = data?.dictionaries;
    if (data?.ok !== true || !catalogs || !isDictionary(catalogs.en)) {
        throw Object.assign(new Error('Invalid locale catalogs.'), { messages: [message('error.invalidLocaleDictionaries')] });
    }
    const dictionaries = Object.fromEntries(Object.entries(catalogs).filter((entry) => isDictionary(entry[1])));
    ctx.effect(() => ctx.locale.register(namespace, dictionaries), 'locale dictionaries');
}
export class ApiError extends Error {
    status;
    failure;
    constructor(failure, status) {
        super(failure.error);
        this.status = status;
        this.failure = failure;
    }
}
export function asFailure(error) {
    return error instanceof ApiError ? error.failure : { error: error instanceof Error ? error.message : String(error) };
}
export async function readFailure(response) {
    const text = await response.text();
    const status = `HTTP ${response.status}`;
    if (response.headers.get('content-type')?.includes('application/json')) {
        try {
            const failure = JSON.parse(text);
            if (typeof failure?.error === 'string')
                return { ...failure, error: failure.error };
            if (failure && typeof failure === 'object') {
                return { error: status, messages: failure.messages ?? [message('error.httpStatus', { status: response.status })], diagnostic: failure.diagnostic };
            }
        }
        catch { /* Keep the original response when a proxy sends malformed JSON. */ }
    }
    return text ? { error: text } : { error: status, messages: [message('error.httpStatus', { status: response.status })] };
}
// Insert values after splitting the template so braces in a path stay literal.
export function withCode(React, template, params) {
    if (!params)
        return template;
    return template.split(/(\{\w+\})/g).map((part, index) => {
        const name = part.slice(1, -1);
        return part.startsWith('{') && Object.hasOwn(params, name)
            ? React.createElement('code', { key: index, style: { overflowWrap: 'anywhere' } }, String(params[name])) : part;
    });
}
export function renderFailure(React, t, failure) {
    const h = React.createElement;
    const explanations = [];
    for (const item of failure.messages ?? []) {
        const template = t(item.key);
        if (!template.trim() || template === item.key)
            continue;
        explanations.push(h(React.Fragment, { key: explanations.length }, explanations.length ? t('error.separator') : null, withCode(React, template, item.params)));
    }
    const raw = failure.diagnostic ?? (explanations.length ? undefined : failure.error);
    return h(React.Fragment, null, explanations.length ? explanations : t('error.unknown'), raw ? h('code', { style: { display: 'block', marginTop: 4, fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 12,
            color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } }, raw) : null);
}
