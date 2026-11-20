import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile, readdir } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';

import type { DeletionClientContext, DeletionPreview, DeletionReceipt, PendingDeletion } from '../src/client.js';
import type { LocalizedProps } from '../src/locale/shared.js';

type ClientFixture = Partial<Omit<DeletionClientContext, 'slots'>> & { slots: Partial<DeletionClientContext['slots']> };
interface ClientPlugin { apply(ctx: ClientFixture): void }
function applyClient(plugin: ClientPlugin, ctx: ClientFixture, dispose = async () => {}) {
  const mounted = Promise.withResolvers<void>();
  plugin.apply({ ...ctx, plugin(apply) {
    const child = apply(ctx as DeletionClientContext);
    void child.then(mounted.resolve, mounted.reject);
    return Object.assign(child, { dispose });
  } });
  return mounted.promise;
}
interface ClientModule { factory(require: (name: string) => unknown): ClientPlugin }
type MenuContribution = Parameters<DeletionClientContext['contextMenus']['register']>[0];
type MockNode = MockElement | string | number | boolean | null | undefined | MockNode[];
interface MockElement {
  type: unknown;
  props: Record<string, unknown> & { children?: MockNode; description?: MockNode; footer?: MockNode };
}
const createElement = (type: unknown, props: Record<string, unknown> | null, ...children: MockNode[]): MockElement =>
  ({ type, props: { ...props, ...(children.length ? { children } : {}) } });
function isElement(value: MockNode): value is MockElement { return !!value && typeof value === 'object' && !Array.isArray(value); }
function element(value: MockNode): MockElement { assert(isElement(value)); return value; }
function nodes(value: MockNode): MockNode[] {
  if (Array.isArray(value)) return value.flatMap(nodes);
  if (value === null || value === undefined) return [];
  return isElement(value) ? [value, ...nodes(value.props.description), ...nodes(value.props.children), ...nodes(value.props.footer)] : [value];
}
interface ReceiptControl {
  poll(): Promise<void>;
  readonly receiptRequests: number;
  update(value: DeletionReceipt): void;
  failNextReceipt(): void;
}

const dictionaries = Object.fromEntries(await Promise.all(['zh', 'en'].map(async locale => {
  const data = JSON.parse(await readFile(new URL(`../locale/${locale}.json`, import.meta.url), 'utf8')) as { messages?: Record<string, string> };
  return [locale, data.messages ?? {}];
}))) as Record<string, Record<string, string>>;

void test('the English catalog contains exactly the messages used by the plugin', async () => {
  const root = new URL('../src/', import.meta.url);
  const keys = new Set<string>();
  for (const file of await readdir(root, { recursive: true })) {
    if (!file.endsWith('.ts')) continue;
    const source = await readFile(new URL(file.replaceAll('\\', '/'), root), 'utf8');
    const pattern = file === 'client.ts'
      ? /['"]((?:error|activity|common|session|delete|gc|records|recovery)\.\w+)['"]/g
      : /['"]((?:error|activity)\.\w+)['"]/g;
    for (const [, key] of source.matchAll(pattern)) keys.add(key);
  }
  assert.deepEqual(new Set(Object.keys(dictionaries.en)), keys);
});

function localeFixture() {
  const registered = new Map<string, Record<string, string>>();
  const listeners = new Set<() => void>();
  let snapshot = { active: 'zh', revision: 0 };
  return {
    register(_namespace: string, dictionaries: Record<string, Record<string, string>>) {
      for (const [locale, entries] of Object.entries(dictionaries)) registered.set(locale, entries);
      return () => registered.clear();
    },
    bind(namespace: string) { assert.equal(namespace, 'session-deletion'); return (key: string, params?: Record<string, unknown>) =>
      (registered.get(snapshot.active)?.[key] ?? registered.get('en')?.[key] ?? key)
        .replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match)); },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setLocale(active: string) { snapshot = { active, revision: snapshot.revision + 1 }; for (const listener of listeners) listener(); },
  };
}

for (const held of ['status', 'locales', 'receipt', 'selection hash']) void test(`Cordis unload during initial ${held} releases the client without navigation`, { timeout: 2000 }, async () => {
  const require = createRequire(import.meta.resolve('@deepseek-ai/dsh-client-connection'));
  const { Context } = await import(pathToFileURL(require.resolve('@deepseek-ai/cordis')).href);
  const root = new Context();
  let menus = 0, navigations = 0, timerCleared = false;
  root.provide('contextMenus', { register() { menus++; return () => { menus--; }; } });
  root.provide('locale', localeFixture());
  root.provide('slots', { inject() {} });
  const id = 'selected-session';
  root.provide('sessions', { list: { getSnapshot: () => ({ byId: { [id]: { id, retainedBy: { mainView: 1 } } } }), subscribe: () => () => {} } });
  root.provide('uiWorkspace', { startSession() { navigations++; } });

  const requested = Promise.withResolvers<void>(), reply = Promise.withResolvers<void>();
  let pending: AbortSignal | null | undefined;
  let plugin!: ClientPlugin;
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    AbortController, TextEncoder, localStorage: {}, sessionStorage: {},
    crypto: { subtle: { async digest(_: string, bytes: Uint8Array) {
      requested.resolve();
      await reply.promise;
      return createHash('sha256').update(bytes).digest();
    } } },
    window: {
      __ModuleLoader__: { load(definition: ClientModule) { plugin = definition.factory(() => ({ createElement })); } },
      addEventListener() {}, removeEventListener() {},
    },
    document: { body: {}, head: { append() {} }, querySelectorAll: () => [], createElement: () => ({ remove() {} }) },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval() { return 1; }, clearInterval() { timerCleared = true; },
    async fetch(url: string, options: RequestInit) {
      pending = options.signal;
      if (url.endsWith('/' + held)) {
        pending?.addEventListener('abort', () => reply.reject(pending?.reason), { once: true });
        requested.resolve();
        await reply.promise;
      }
      if (url.endsWith('/receipt')) return Response.json({ revision: '', deletedIdHashes: [createHash('sha256').update(id).digest('hex')] });
      return Response.json(url.endsWith('/locales') ? { ok: true, dictionaries }
        : { ok: true, pending: [], locked: [], archived: [], receipt: { revision: '', count: 1 } });
    },
  });
  const scope = root.plugin(plugin);
  await requested.promise;
  assert.equal(menus, held === 'receipt' || held === 'selection hash' ? 1 : 0);
  let unloaded = false;
  const disposal = scope.dispose().then(() => { unloaded = true; });
  try {
    await new Promise(setImmediate);
    assert.equal(pending?.aborted, true);
    if (held === 'selection hash') {
      reply.resolve(); // WebCrypto finishes after the parent has already unloaded its timer.
      await new Promise(setImmediate);
    }
    assert.equal(unloaded, true);
    assert.equal(navigations, 0);
    assert.equal(timerCleared, true);
    assert.equal(menus, 0);
  } finally {
    reply.resolve();
    await disposal;
  }
});

// Run the shipped browser entry point. No helper is extracted or reimplemented:
// a successful refresh must finish its actual cleanup before startSession fires.
function browserStorage(values: Record<string, string>) {
  const storage = { ...values };
  Object.defineProperties(storage, {
    getItem: { value: (key: string) => storage[key] ?? null },
    setItem: { value: (key: string, value: string) => { storage[key] = String(value); } },
    removeItem: { value: (key: string) => { delete storage[key]; } },
  });
  return storage as unknown as Pick<Storage, 'getItem' | 'setItem' | 'removeItem'>;
}

async function refreshClient(localStorage: ReturnType<typeof browserStorage>, sessionStorage: ReturnType<typeof browserStorage>, deletedId: string,
  verify: (control: ReceiptControl) => Promise<void> = async () => {}) {
  let plugin!: ClientPlugin;
  let cleanup: (() => void) | undefined;
  let finish!: () => void;
  let poll!: () => void;
  let receiptRequests = 0, failReceipt = false;
  let receipt = { revision: 'first', deletedIdHashes: [createHash('sha256').update(deletedId).digest('hex')] };
  const finished = new Promise<void>(resolve => { finish = resolve; });
  const sandbox = {
    AbortController, TextEncoder,
    crypto: { subtle: { digest: async (_: string, bytes: Uint8Array) => createHash('sha256').update(bytes).digest() } },
    localStorage,
    sessionStorage,
    window: {
      __ModuleLoader__: { load(definition: ClientModule) { plugin = definition.factory(() => ({ createElement() {} })); } },
      addEventListener() {}, removeEventListener() {},
    },
    document: {
      body: {}, head: { append() {} }, querySelectorAll: () => [],
      createElement: () => ({ remove() {} }),
    },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval(callback: () => void) { poll = callback; return 1; }, clearInterval() {},
    fetch: async (url: string) => {
      if (url === 'api/session-deletion/locales') return { ok: true, json: async () => ({ ok: true, dictionaries }) };
      if (url.endsWith('/receipt')) {
        receiptRequests++;
        if (failReceipt) { failReceipt = false; return Response.json({ error: 'retry' }, { status: 503 }); }
        return { ok: true, json: async () => receipt };
      }
      return { ok: true, json: async () => ({ pending: [], locked: [], archived: [], ok: true,
        receipt: { revision: receipt.revision, count: receipt.deletedIdHashes.length } }) };
    },
  };
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox);
  await applyClient(plugin,{
    locale: localeFixture(), fiber: { uid: 1 },
    slots: { inject() {} },
    contextMenus: { register() { return () => {}; } },
    sessions: { list: {
      getSnapshot: () => ({ byId: { [deletedId]: { id: deletedId, running: false, retainedBy: { mainView: 1 } } } }),
      subscribe: () => () => {},
    } },
    uiWorkspace: { startSession() { finish(); } },
    effect(callback) { cleanup = callback(); },
  });
  try {
    await finished;
    await verify({
      poll: async () => { poll(); await new Promise(setImmediate); },
      get receiptRequests() { return receiptRequests; },
      update: value => { receipt = value; },
      failNextReceipt: () => { failReceipt = true; },
    });
  }
  finally { cleanup?.(); }
}

void test('browser cleanup removes only owned session keys and preserves another draft quoting the deleted ID', { timeout: 2000 }, async () => {
  const deleted = 'session-deleted-123';
  const survivor = 'session-surviving-456';
  const scopedPrefixes = ['dsh.conversation.', 'dsh.sidebar-right.v1.', 'dsh.schedule.task-tab.v1.'];
  const values: Record<string, string> = {
    [`dsh.conversation.${survivor}`]: JSON.stringify({ draft: deleted, view: null, viewRequest: null }),
    'dsh.unrelated.preferences': JSON.stringify({ id: deleted, nested: { [deleted]: deleted } }),
    'dsh.conversation.contentWidth': '760',
    'dsh.sessions.current': JSON.stringify({ sessionId: deleted }),
    'dsh.workspace.view.v5': JSON.stringify({
      groupBy: 'workspace', orderBy: 'manual', groupExpansion: { project: true, [deleted]: false },
      sessionOrderByAccount: { project: [deleted, survivor], [deleted]: [survivor] }, archivedFilter: 'default',
    }),
  };
  for (const prefix of scopedPrefixes) values[prefix + deleted] = JSON.stringify({ draft: 'target private state' });
  const local = browserStorage(values);
  const session = browserStorage(values);
  await refreshClient(local, session, deleted);
  for (const storage of [local, session]) {
    for (const prefix of scopedPrefixes) assert.equal(storage.getItem(prefix + deleted), null);
    assert.equal(storage.getItem(`dsh.conversation.${survivor}`), values[`dsh.conversation.${survivor}`]);
    assert.equal(storage.getItem('dsh.unrelated.preferences'), values['dsh.unrelated.preferences']);
    assert.equal(storage.getItem('dsh.conversation.contentWidth'), '760');
    assert.equal(storage.getItem('dsh.sessions.current'), null);
    const view = JSON.parse(storage.getItem('dsh.workspace.view.v5')!);
    assert.deepEqual(view.sessionOrderByAccount, { project: [survivor], [deleted]: [survivor] });
    assert.deepEqual(view.groupExpansion, { project: true, [deleted]: false });
  }
});

void test('receipt sync fetches only on revision changes, retries failures and keeps cleaning late browser writes', { timeout: 2000 }, async () => {
  const first = 'deleted-first', second = 'deleted-second';
  const local = browserStorage({});
  await refreshClient(local, browserStorage({}), first, async client => {
    assert.equal(client.receiptRequests, 1);
    local.setItem('dsh.conversation.' + first, 'late old-tab draft');
    await client.poll();
    assert.equal(local.getItem('dsh.conversation.' + first), null);
    assert.equal(client.receiptRequests, 1);
    local.setItem('dsh.conversation.' + second, 'second draft');
    client.update({ revision: 'second', deletedIdHashes: [first, second].map(id => createHash('sha256').update(id).digest('hex')) });
    client.failNextReceipt();
    await client.poll();
    assert.equal(local.getItem('dsh.conversation.' + second), 'second draft');
    await client.poll();
    assert.equal(local.getItem('dsh.conversation.' + second), null);
    assert.equal(client.receiptRequests, 3);
    await client.poll();
    assert.equal(client.receiptRequests, 3);
    client.update({ revision: 'cleared', deletedIdHashes: [] });
    local.setItem('dsh.conversation.' + first, 'written after cleanup');
    await client.poll();
    assert.equal(client.receiptRequests, 4);
    assert.equal(local.getItem('dsh.conversation.' + first), 'written after cleanup');
  });
});

for (const held of ['draft hash', 'workspace order hash', 'selection hash', 'status response', 'status 404', 'receipt response']) void test(`clearing records supersedes a pending ${held}`, { timeout: 2000 }, async () => {
  const id = 'deleted-session', survivor = 'surviving-session';
  const draftKey = 'dsh.conversation.' + id, viewKey = 'dsh.workspace.view.v5';
  const view = JSON.stringify({ sessionOrderByAccount: { account: [id, survivor] } });
  const local = browserStorage({}), session = browserStorage({});
  if (held === 'draft hash') local.setItem(draftKey, 'draft');
  if (held === 'workspace order hash') local.setItem(viewKey, view);
  const pending = Promise.withResolvers<void>(), resume = Promise.withResolvers<void>();
  let plugin!: ClientPlugin, poll!: () => void, navigations = 0, mounted = false, disposed = false;
  const pause = async (stage: string) => { if (mounted && stage === held) { pending.resolve(); await resume.promise; } };
  let receipt: DeletionReceipt = { revision: 'initial', deletedIdHashes: [createHash('sha256').update('earlier deletion').digest('hex')] };
  const locale = localeFixture();
  const components: Record<string, (props: LocalizedProps) => MockNode> = {};
  const react = { createElement, useLayoutEffect() {}, useSyncExternalStore: <T>(_: unknown, read: () => T) => read() };
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    AbortController, TextEncoder, localStorage: local, sessionStorage: session,
    crypto: { subtle: { async digest(_: string, bytes: Uint8Array) {
      if (held.endsWith('hash') && Buffer.from(bytes).toString() === (held === 'workspace order hash' ? survivor : id)) await pause(held);
      return createHash('sha256').update(bytes).digest();
    } } },
    window: { __ModuleLoader__: { load(entry: ClientModule) { plugin = entry.factory(name => name === 'react' ? react : { Button: 'button' }); } }, addEventListener() {} },
    document: { body: {}, head: { append() {} }, querySelectorAll: () => [], createElement: () => ({}) },
    MutationObserver: class { observe() {} }, setInterval(callback: () => void) { poll = callback; }, clearInterval() {},
    async fetch(url: string, options: RequestInit) {
      if (url.endsWith('/locales')) return Response.json({ ok: true, dictionaries });
      if (url.endsWith('/clear-records')) {
        assert.equal(JSON.parse(options.body as string).revision, receipt.revision);
        const cleared = receipt.deletedIdHashes.length;
        receipt = { revision: 'cleared', deletedIdHashes: [] };
        return Response.json({ cleared, receipt: { revision: receipt.revision, count: 0 } });
      }
      const status = url.endsWith('/status');
      assert.ok(status || url.endsWith('/receipt'));
      if (status && mounted && held === 'status 404') {
        await pause(held);
        return Response.json({ error: 'Not found' }, { status: 404 });
      }
      const response = Response.json(status ? { ok: true, locked: [], archived: [], pending: [],
        receipt: { revision: receipt.revision, count: receipt.deletedIdHashes.length } } : receipt);
      await pause(status ? 'status response' : 'receipt response');
      return response;
    },
  });
  await applyClient(plugin, {
    locale, fiber: { uid: 1 }, effect(callback) { callback(); },
    slots: { inject(_, setup) { setup(); }, register({ id }, component) { components[id] = component as (props: LocalizedProps) => MockNode; } },
    contextMenus: { register: () => () => {} },
    sessions: { list: { getSnapshot: () => ({ byId: { [id]: { id, running: false, retainedBy: { mainView: 1 } } } }), subscribe: () => () => {} } },
    uiWorkspace: { startSession() { navigations++; } },
  }, async () => { disposed = true; });
  await new Promise(setImmediate);
  mounted = true;
  if (!held.startsWith('status')) receipt = { revision: 'updated', deletedIdHashes: [...receipt.deletedIdHashes, createHash('sha256').update(id).digest('hex')] };
  poll();
  const render = (name: string) => nodes(components['session-deletion.' + name]({ t: locale.bind('session-deletion') }));
  const click = (name: string, label: string) => {
    const button = element(render(name).find(node => isElement(node) && node.type === 'button' && nodes(node.props.children).includes(label)));
    assert.equal(button.props.disabled, false);
    (button.props.onClick as () => void)();
  };
  try {
    await pending.promise;
    click('records', '清理'); click('gc-dialog', '确认清理');
    await new Promise(setImmediate);
    assert.ok(render('records').includes('当前无会话删除记录'));
    session.setItem(draftKey, 'written after clearing');
  } finally { resume.resolve(); await new Promise(setImmediate); }
  assert.equal(disposed, false);
  assert.ok(render('records').includes('当前无会话删除记录'));
  assert.equal(local.getItem(draftKey), held === 'draft hash' ? 'draft' : null);
  assert.equal(local.getItem(viewKey), held === 'workspace order hash' ? view : null);
  assert.equal(session.getItem(draftKey), 'written after clearing');
  assert.equal(navigations, 0);
});

void test('deletion copy and API errors follow locale changes, use English for missing translations and allow running sessions', async () => {
  const id = 'session-copy-test';
  const rows = { [id]: { id, running: false, retainedBy: { mainView: 1 } } };
  const components = new Map<string, () => MockNode>();
  let plugin!: ClientPlugin, menu!: MenuContribution, resolvePreview!: (value: DeletionPreview) => void;
  let cleanup: (() => void) | undefined;
  let previewFailed = false;
  let previewThrown = false;
  let resolveDelete!: () => void, poll!: () => void, deleteCalls = 0;
  let disconnected = false, statusFailed = false, deletionRunning = false;
  let beforeAcceptance = false, losePreview = false, missingPreview = false, completeDespiteDisconnect = false, completed = false;
  let issuedToken = '', nextToken = 0, lateDelete!: () => boolean;
  let pending: PendingDeletion[] = [];
  const closeButton = { disabled: false };
  const locale = localeFixture();
  const zh = { ...dictionaries.zh };
  delete zh['delete.confirm'];
  const translated = { zh, fr: { 'session.unnamed': 'Sans titre' }, en: { ...dictionaries.en, 'delete.checking': '[en] checking', 'delete.menu': '[en] delete', 'error.runtimeUnavailable': '[en] runtime unavailable' } };
  const preview = new Promise<DeletionPreview>(resolve => { resolvePreview = resolve; });
  const ui = { Modal: 'NativeModal', MenuItemButton: 'NativeMenu', Button: 'NativeButton', IconTrashOutlineRegular: 'NativeIcon' };
  const react = {
    Fragment: Symbol('Fragment'),
    createElement,
    useSyncExternalStore: <T>(_: unknown, read: () => T) => read(), useLayoutEffect(callback: () => void) { callback(); },
  };
  const sandbox = {
    AbortController, TextEncoder,
    crypto: { subtle: { digest: async (_: string, bytes: Uint8Array) => createHash('sha256').update(bytes).digest() } },
    localStorage: browserStorage({}), sessionStorage: browserStorage({}),
    window: { __ModuleLoader__: { load(definition: ClientModule) { plugin = definition.factory(name => name === 'react' ? react : ui); } }, addEventListener() {}, removeEventListener() {} },
    document: { body: {}, head: { append() {} }, querySelector: () => closeButton, querySelectorAll: () => [], createElement: () => ({ remove() {} }) },
    MutationObserver: class { observe() {} disconnect() {} }, setInterval(callback: () => void) { poll = callback; return 1; }, clearInterval() {},
    fetch: async (url: string, options?: { body?: string }) => {
      if (url === 'api/session-deletion/locales') return { ok: true, json: async () => ({ ok: true, dictionaries: translated }) };
      if (url.endsWith('/preview') && previewThrown) throw 0;
      if (url.endsWith('/preview')) {
        if (missingPreview) return Response.json({ error: 'Session missing', messages: [{ key: 'error.sessionMissing' }] }, { status: 404 });
        if (previewFailed) return Response.json({ error: 'Host fallback', messages: [{ key: 'error.runtimeUnavailable' }], diagnostic: 'system detail\n<&>' }, { status: 409 });
        const token = issuedToken = 'fixture-' + ++nextToken;
        if (losePreview) throw new Error('Replacement response lost');
        return { ok: true, json: async () => ({ ...await preview, token }) };
      }
      if (url.endsWith('/delete')) {
        deleteCalls++; const request = JSON.parse(options!.body!);
        assert.equal(request.confirmation, 'DELETE_SESSION'); assert.equal(request.token, issuedToken);
        if (beforeAcceptance) {
          lateDelete = () => { const accepted = request.token === issuedToken; if (accepted) deletionRunning = true; return accepted; };
          throw new Error('Request body delayed');
        }
        deletionRunning = true;
        if (disconnected) {
          if (completeDespiteDisconnect) { completed = true; deletionRunning = false; }
          throw new Error('Disconnected');
        }
        await new Promise<void>(resolve => { resolveDelete = resolve; }); deletionRunning = false;
        return { ok: true, json: async () => ({ deleted: 1 }) };
      }
      if (url.endsWith('/status') && statusFailed) throw new Error('Disconnected');
      return { ok: true, json: async () => url.endsWith('/receipt')
        ? { revision: completed ? 'deleted' : 'empty', deletedIdHashes: completed ? [createHash('sha256').update(id).digest('hex')] : [] }
        : { pending, deletionRunning, locked: deletionRunning || pending.length ? [id] : [], archived: [], ok: true, receipt: { revision: completed ? 'deleted' : 'empty', count: completed ? 1 : 0 } } };
    },
  };
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox);
  await applyClient(plugin,{
    locale, fiber: { uid: 1 },
    slots: { inject(_, callback) { callback(); }, register(options, component) {
      assert.equal(options.locale, 'session-deletion');
      const render = component as (props: LocalizedProps) => MockNode;
      components.set(options.id, () => render({ t: locale.bind(options.locale) }));
    } },
    contextMenus: { register(contribution) { menu = contribution; return () => {}; } },
    sessions: { list: { getSnapshot: () => ({ byId: rows }), subscribe: () => () => {} } },
    uiWorkspace: { startSession() {} }, effect(callback) { cleanup = callback(); },
  });
  try {
    await new Promise(setImmediate);
    menu.resolve({ sessionId: id, displayTitle: 'Test' })[0].run();
    const render = () => { const component = components.get('session-deletion.dialog'); assert(component); return nodes(component()); };
    assert.ok(render().includes('正在检查会话状态…'));
    locale.setLocale('fr');
    assert.ok(render().includes('[en] checking'));
    assert.equal(menu.resolve({ sessionId: id, displayTitle: 'Test' })[0].label, '[en] delete');
    assert.ok(menu.observe().includes(locale));
    resolvePreview({ count: 1, token: 'fixture', archived: false });
    await new Promise(setImmediate);
    rows[id].running = true;
    locale.setLocale('zh');
    const current = render();
    assert.equal(current.includes('会话正在运行，暂时无法删除'), false);
    const confirm = current.find((node): node is MockElement => isElement(node) && node.type === ui.Button && nodes(node.props.children).includes(dictionaries.en['delete.confirm']));
    assert(confirm);
    assert.equal(confirm.props.disabled, false);
    assert.equal(menu.resolve({ sessionId: id, displayTitle: 'Test' })[0].disabled, false);
    assert.equal(element(current.find(node => isElement(node) && node.type === ui.Modal)).props.title, dictionaries.zh['delete.title']);
    locale.setLocale('en');
    rows[id].running = false; previewFailed = true;
    menu.resolve({ sessionId: id, displayTitle: 'Test' })[0].run();
    await new Promise(setImmediate);
    assert.ok(render().includes('[en] runtime unavailable'));
    function checkDiagnostic(lead: string, raw: string) {
      const dialog = element(render().find(node => isElement(node) && node.type === ui.Modal));
      assert.equal(dialog.props.children, undefined);
      const alert = element(nodes(dialog.props.description).find(node => isElement(node) && node.props.role === 'alert'));
      const content = nodes(alert.props.children);
      const block = element(content.find(node => isElement(node) && node.type === 'code'));
      assert.ok(content.includes(lead) && content.indexOf(lead) < content.indexOf(block));
      assert.deepEqual(block.props.children, [raw]);
      const style = block.props.style as React.CSSProperties;
      assert.deepEqual([style.display, style.marginTop, style.whiteSpace], ['block', 4, 'pre-wrap']);
    }
    checkDiagnostic('[en] runtime unavailable', 'system detail\n<&>');
    locale.setLocale('zh');
    assert.ok(render().includes('会话删除插件已停用。请在启用后重新打开菜单。'));
    previewThrown = true;
    menu.resolve({ sessionId: id, displayTitle: 'Test' })[0].run();
    await new Promise(setImmediate);
    checkDiagnostic('未知错误。', '0');
    previewThrown = previewFailed = false;
    const buttons = () => render().filter((node): node is MockElement => isElement(node) && node.type === ui.Button);
    const modal = () => render().find((node): node is MockElement => isElement(node) && node.type === ui.Modal);
    const tick = async () => { poll(); await new Promise(setImmediate); };
    menu.resolve({ sessionId: id, displayTitle: 'Test' })[0].run(); await new Promise(setImmediate);
    assert.equal(modal()!.props.title, '删除此会话？');
    (buttons().at(-1)!.props.onClick as () => void)(); await new Promise(setImmediate);
    assert(buttons().every(button => button.props.disabled)); assert.equal(closeButton.disabled, true);
    (modal()!.props.onClose as () => void)(); assert(modal());
    (buttons().at(-1)!.props.onClick as () => void)(); assert.equal(deleteCalls, 1);
    resolveDelete(); await new Promise(setImmediate); assert.equal(modal(), undefined);

    menu.resolve({ sessionId: id, displayTitle: 'Test' })[0].run(); await new Promise(setImmediate);
    disconnected = statusFailed = true;
    (buttons().at(-1)!.props.onClick as () => void)(); await new Promise(setImmediate);
    assert(buttons().every(button => button.props.disabled)); assert.equal(closeButton.disabled, true);
    await tick(); assert(buttons().every(button => button.props.disabled), 'failed status reads cannot release unknown server work');
    missingPreview = true; statusFailed = false; await tick(); assert(buttons().every(button => button.props.disabled));
    deletionRunning = false; pending = [{ sessionId: 'another-root', queuedAt: 'fixture' }];
    await tick();
    assert.deepEqual(buttons().map(button => button.props.disabled), [false, true], 'the pending request can be dismissed even when its target has no preview');
    assert.equal(closeButton.disabled, false);
    assert.equal(menu.resolve({ sessionId: 'unrelated', displayTitle: 'Other' })[0].disabled, true);
    (modal()!.props.onClose as () => void)(); assert.equal(modal(), undefined);

    pending = []; missingPreview = false; await tick();
    disconnected = false; beforeAcceptance = true;
    menu.resolve({ sessionId: id, displayTitle: 'Test' })[0].run(); await new Promise(setImmediate);
    losePreview = true;
    (buttons().at(-1)!.props.onClick as () => void)(); await new Promise(setImmediate);
    assert.equal(deletionRunning, false);
    assert(buttons().every(button => button.props.disabled), 'an idle status cannot revoke a delayed delete body');
    await tick(); assert(buttons().every(button => button.props.disabled), 'a lost replacement response is not proof of revocation');
    losePreview = false; await tick();
    assert(buttons().every(button => !button.props.disabled));
    assert.equal(lateDelete(), false, 'the delayed request cannot consume the replacement token');
    beforeAcceptance = false;
    pending = [{ sessionId: 'another-root', queuedAt: 'fixture' }]; await tick();
    assert.equal(buttons().at(-1)!.props.disabled, true);
    pending = []; await tick();
    (buttons().at(-1)!.props.onClick as () => void)(); await new Promise(setImmediate);
    resolveDelete(); await new Promise(setImmediate); assert.equal(modal(), undefined);

    menu.resolve({ sessionId: id, displayTitle: 'Test' })[0].run(); await new Promise(setImmediate);
    disconnected = completeDespiteDisconnect = missingPreview = true;
    (buttons().at(-1)!.props.onClick as () => void)(); await new Promise(setImmediate);
    assert.equal(modal(), undefined, 'a durable deletion receipt resolves a lost success response even when preview now returns 404');

    missingPreview = disconnected = false;
    menu.resolve({ sessionId: id, displayTitle: 'Test' })[0].run(); await new Promise(setImmediate);
    // The delete reply was lost, then a different client cleared the receipt before this tab reconnected.
    disconnected = missingPreview = true;
    statusFailed = true;
    (buttons().at(-1)!.props.onClick as () => void)(); await new Promise(setImmediate);
    completed = statusFailed = false;
    await tick();
    assert.deepEqual(buttons().map(button => button.props.disabled), [false, true], 'a missing session can be dismissed after its deletion record is cleared');
    (modal()!.props.onClose as () => void)(); assert.equal(modal(), undefined);
  } finally { cleanup?.(); }
});

void test('GC menu shows a native spinner, formats binary units and reports failed or invalid size previews', async () => {
  let plugin!: ClientPlugin, menu!: (props: LocalizedProps & { onDismiss(): void }) => MockNode, mount!: () => () => void;
  let bytes: number | null | undefined, response: unknown, fail: boolean | 'network' = false, requests = 0;
  const locale = localeFixture();
  const ui = { MenuItemButton: 'NativeMenu', StateDot: 'NativeSpinner' };
  const react = {
    Fragment: Symbol('Fragment'),
    createElement,
    useSyncExternalStore: <T>(_: unknown, read: () => T) => read(),
    useState: () => [bytes, (value: typeof bytes) => { bytes = value; }],
    useEffect: (callback: () => () => void) => { mount = callback; },
  };
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    AbortController,
    window: { __ModuleLoader__: { load(definition: ClientModule) { plugin = definition.factory(name => name === 'react' ? react : ui); } } },
    fetch: async (url: string) => {
      if (url === 'api/session-deletion/locales') return { ok: true, json: async () => ({ ok: true, dictionaries }) };
      if (url.endsWith('/status')) return Response.json({ ok: true, pending: [], locked: [], archived: [], receipt: { revision: '', count: 0 } });
      if (url.endsWith('/receipt')) return Response.json({ revision: '', deletedIdHashes: [] });
      assert.equal(url, '/session-deletion/api/gc-size'); requests++;
      if (fail === 'network') throw new Error('Disconnected');
      return fail ? Response.json({ error: 'Cannot scan' }, { status: 500 }) : { ok: true, json: async () => ({ bytes: response }) };
    },
  });
  await applyClient(plugin,{
    locale, fiber: { uid: 1 },
    slots: { inject(_, callback) { callback(); }, register(options, component) { if (options.id === 'session-deletion.gc') {
      assert.equal(options.locale, 'session-deletion'); menu = component as typeof menu;
    } } },
    effect(callback, label) { if (label === 'locale dictionaries') callback(); },
  });
  const props = { t: locale.bind('session-deletion'), onDismiss() {} };
  const icon = element(element(menu(props)).props.icon as MockNode);
  assert.equal(icon.type, 'svg');
  assert.equal(icon.props.viewBox, '0 0 256 256');
  assert.match(String(element(nodes(icon.props.children)[0]).props.d), /^M235\.5 216\.81c/, 'the cleanup action keeps its broom artwork');
  const render = () => element(element(menu(props)).props.children);
  const text = (value: MockNode): string => typeof value === 'string' ? value : Array.isArray(value) ? value.map(text).join('') : isElement(value) ? text(value.props.children) : '';
  const cases: Array<[number, string]> = [
    [0, '0 B'], [1, '1 B'], [1023, '1023 B'], [1024, '1 KiB'], [1536, '1.5 KiB'], [1264, '1.23 KiB'],
    [1024 ** 2 - 1, '1024 KiB'], [1024 ** 2, '1 MiB'],
    [1024 ** 3 - 1, '1024 MiB'], [1024 ** 3, '1 GiB'],
    [1024 ** 4 - 1, '1024 GiB'], [1024 ** 4, '1 TiB'], [1024 ** 5, '1024 TiB'],
  ];
  for (const [value, expected] of cases) {
    bytes = undefined; response = value;
    const loading = nodes(render()).find((node): node is MockElement => isElement(node) && node.props.role === 'status');
    assert(loading);
    assert.equal(loading.props.role, 'status');
    assert.equal(loading.props['aria-label'], '正在计算可清理体积');
    const spinner = nodes(loading).find((node): node is MockElement => isElement(node) && node.type === ui.StateDot);
    assert(spinner);
    assert.equal(spinner.props.state, 'ongoing');
    const unmount = mount();
    await new Promise(setImmediate);
    assert.equal(text(render()), `释放空间（${expected}）`);
    unmount();
  }
  const failures: Array<[boolean | 'network', unknown]> = [[true, 0], ['network', 0], [false, undefined], [false, null], [false, -1], [false, NaN], [false, Infinity], [false, '1024']];
  for (const [failure, value] of failures) {
    bytes = undefined; fail = failure; response = value; render();
    const unmount = mount();
    await new Promise(setImmediate);
    assert.equal(text(render()), '释放空间（大小未知）');
    unmount();
  }
  // Closing an unfinished menu must not publish its eventual result.
  bytes = undefined; fail = false; response = 1024; render();
  const unmount = mount();
  unmount();
  await new Promise(setImmediate);
  assert.equal(bytes, undefined);
  assert.equal(requests, cases.length + failures.length + 1, 'each menu opening fetches once; rendering does not rescan');
});
