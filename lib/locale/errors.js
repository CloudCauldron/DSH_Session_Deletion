import { createRequire } from 'node:module';
import { message } from './shared.js';
const require = createRequire(import.meta.url);
/** Standalone tools use English. A missing or damaged catalog must not mask the original failure. */
function english({ key, params }) {
    try {
        const { messages } = require('../../locale/en.json');
        return (messages[key] ?? key).replace(/\{(\w+)\}/g, (token, name) => String(params?.[name] ?? token));
    }
    catch {
        return key;
    }
}
function formatError(key, params, failures = [], fallback) {
    const messages = typeof key === 'string' ? [message(key, params)] : [...key];
    const raw = [];
    for (const failure of failures) {
        const detail = describeFailure(failure);
        if (detail.messages)
            messages.push(...detail.messages);
        const diagnostic = detail.messages ? detail.diagnostic : detail.error;
        if (diagnostic !== undefined)
            raw.push(diagnostic);
    }
    const text = messages.map((item, i) => i === 0 && fallback !== undefined ? fallback : english(item));
    return { messages, diagnostic: raw.length ? raw.join('\n') : undefined, error: [...text, ...raw].join('; ') };
}
export function describeFailure(error) {
    // A failing 'using' disposal retains both the original operation and the later cleanup failure.
    if (error instanceof SuppressedError)
        return formatError([], undefined, [error.suppressed, error.error]);
    if (error instanceof LocalizedError || error instanceof LocalizedAggregateError) {
        return { error: error.message, messages: error.messages, diagnostic: error.diagnostic };
    }
    if (error instanceof AggregateError)
        return formatError([], undefined, error.message ? [error.message, ...error.errors] : error.errors);
    return { error: error instanceof Error ? error.message : String(error) };
}
export class LocalizedError extends Error {
    messages;
    diagnostic;
    constructor(key, params, options) {
        const { error, messages, diagnostic } = formatError(key, params, options?.failures, options?.fallback);
        super(error, options);
        this.messages = messages;
        this.diagnostic = diagnostic;
    }
}
export class LocalizedAggregateError extends AggregateError {
    messages;
    diagnostic;
    constructor(errors, key = [], params, options) {
        const causes = [...errors];
        const { error, messages, diagnostic } = formatError(key, params, causes);
        super(causes, error, options);
        this.messages = messages;
        this.diagnostic = diagnostic;
    }
}
