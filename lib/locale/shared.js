export function message(key, params) {
    return params === undefined ? { key } : { key, params };
}
export function isDictionary(value) {
    return value !== null && typeof value === 'object' && !Array.isArray(value)
        && Object.values(value).every(entry => typeof entry === 'string');
}
export function catalogUrl(id) { return `api/${id}/locales`; }
