import { catalogUrl, isDictionary, message, type Dictionaries, type Failure, type LocalizedMessage, type LocalizedProps, type Messages } from './shared.ts';

export interface LocaleClientContext {
  fiber: { uid: number | null };
  effect(register: () => () => void, label: string): unknown;
  locale: { register(namespace: string, dictionaries: Dictionaries): () => void };
}

export async function registerClientLocale(ctx: LocaleClientContext, namespace: string, id = namespace): Promise<void> {
  const response = await fetch(catalogUrl(id), { cache: 'no-store', redirect: 'error' });
  if (ctx.fiber.uid === null) return;
  if (!response.ok) throw Object.assign(new Error(`Locale catalogs: HTTP ${response.status}`), {
    messages: [message('error.localeHttp', { status: String(response.status) })],
  });
  const data = await response.json() as { ok?: boolean; dictionaries?: Record<string, unknown> } | null;
  if (ctx.fiber.uid === null) return;
  const catalogs = data?.dictionaries;
  if (data?.ok !== true || !catalogs || !isDictionary(catalogs.en)) {
    throw Object.assign(new Error('Invalid locale catalogs.'), { messages: [message('error.invalidLocaleDictionaries')] });
  }
  const dictionaries = Object.fromEntries(Object.entries(catalogs).filter((entry): entry is [string, Messages] => isDictionary(entry[1])));
  ctx.effect(() => ctx.locale.register(namespace, dictionaries), 'locale dictionaries');
}

export class ApiError extends Error {
  readonly failure: Failure;
  constructor(failure: Failure) { super(failure.error); this.failure = failure; }
}

export function asFailure(error: unknown): Failure {
  return error instanceof ApiError ? error.failure : { error: error instanceof Error ? error.message : String(error) };
}

export async function readFailure(response: Response): Promise<Failure> {
  const text = await response.text();
  const status = `HTTP ${response.status}`;
  if (response.headers.get('content-type')?.includes('application/json')) {
    try {
      const failure = JSON.parse(text) as Partial<Failure> | null;
      if (typeof failure?.error === 'string') return { ...failure, error: failure.error };
      if (failure && typeof failure === 'object') {
        return { error: status, messages: failure.messages ?? [message('error.httpStatus', { status: response.status })], diagnostic: failure.diagnostic };
      }
    } catch { /* Keep the original response when a proxy sends malformed JSON. */ }
  }
  return text ? { error: text } : { error: status, messages: [message('error.httpStatus', { status: response.status })] };
}

type ReactAPI = typeof import('react');

// Insert values after splitting the template so braces in a path stay literal.
export function withCode(React: ReactAPI, template: string, params?: LocalizedMessage['params']): import('react').ReactNode {
  if (!params) return template;
  return template.split(/(\{\w+\})/g).map((part, index) => {
    const name = part.slice(1, -1);
    return part.startsWith('{') && Object.hasOwn(params, name)
      ? React.createElement('code', { key: index, style: { overflowWrap: 'anywhere' } }, String(params[name])) : part;
  });
}

export function renderFailure(React: ReactAPI, t: LocalizedProps['t'], failure: Failure): import('react').ReactNode {
  const h = React.createElement;
  const explanations: import('react').ReactNode[] = [];
  for (const item of failure.messages ?? []) {
    const template = t(item.key);
    if (!template.trim() || template === item.key) continue;
    explanations.push(h(React.Fragment, { key: explanations.length },
      explanations.length ? t('error.separator') : null, withCode(React, template, item.params)));
  }
  const raw = failure.diagnostic ?? (explanations.length ? undefined : failure.error);
  return h(React.Fragment, null, explanations.length ? explanations : t('error.unknown'),
    raw ? h('code', { style: { display: 'block', marginTop: 4, fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 12,
      color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere', whiteSpace: 'pre-wrap' } }, raw) : null);
}
