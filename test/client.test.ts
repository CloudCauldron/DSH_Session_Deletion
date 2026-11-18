import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

type ClientFixture = Partial<Omit<DeletionClientContext, 'slots'>> & { slots: Partial<DeletionClientContext['slots']> };
interface ClientPlugin { apply(ctx: ClientFixture): Promise<void> }
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

function localeFixture() {
  const registered = new Map<string, Record<string, string>>();
  const listeners = new Set<() => void>();
  let snapshot = { active: 'zh', revision: 0 };
  return {
    register(_namespace: string, locale: string, dictionary: Record<string, string>) {
      registered.set(locale, dictionary); return () => { registered.delete(locale); };
    },
    bind() { return (key: string, params?: Record<string, unknown>) =>
      (registered.get(snapshot.active)?.[key] ?? registered.get('en')?.[key] ?? key)
        .replace(/\{(\w+)\}/g, (match, name: string) => String(params?.[name] ?? match)); },
    getSnapshot: () => snapshot,
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    setLocale(active: string) { snapshot = { active, revision: snapshot.revision + 1 }; for (const listener of listeners) listener(); },
  };
}

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
    TextEncoder,
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
      if (url.endsWith('/locales')) return { ok: true, json: async () => ({ dictionaries }) };
      if (url.endsWith('/receipt')) {
        receiptRequests++;
        if (failReceipt) { failReceipt = false; return { ok: false, status: 503, json: async () => ({ error: 'retry' }) }; }
        return { ok: true, json: async () => receipt };
      }
      return { ok: true, json: async () => ({ pending: [], locked: [], archived: [], guardHealthy: true,
        receipt: { revision: receipt.revision, count: receipt.deletedIdHashes.length } }) };
    },
  };
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox);
  await plugin.apply({
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
  });
});

void test('deletion copy and API errors follow locale changes, retain Chinese fallback and allow running sessions', async () => {
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
  const translated = { ...dictionaries, en: { 'delete.checking': '[en] checking', 'delete.menu': '[en] delete', 'error.guardUnavailable': '[en] guard unavailable' } };
  const preview = new Promise<DeletionPreview>(resolve => { resolvePreview = resolve; });
  const ui = { Modal: 'NativeModal', MenuItemButton: 'NativeMenu', Button: 'NativeButton', IconTrashOutlineRegular: 'NativeIcon' };
  const react = {
    Fragment: Symbol('Fragment'),
    createElement,
    useSyncExternalStore: <T>(_: unknown, read: () => T) => read(), useLayoutEffect(callback: () => void) { callback(); },
  };
  const sandbox = {
    TextEncoder,
    crypto: { subtle: { digest: async (_: string, bytes: Uint8Array) => createHash('sha256').update(bytes).digest() } },
    localStorage: browserStorage({}), sessionStorage: browserStorage({}),
    window: { __ModuleLoader__: { load(definition: ClientModule) { plugin = definition.factory(name => name === 'react' ? react : ui); } }, addEventListener() {}, removeEventListener() {} },
    document: { body: {}, head: { append() {} }, querySelector: () => closeButton, querySelectorAll: () => [], createElement: () => ({ remove() {} }) },
    MutationObserver: class { observe() {} disconnect() {} }, setInterval(callback: () => void) { poll = callback; return 1; }, clearInterval() {},
    fetch: async (url: string, options?: { body?: string }) => {
      if (url.endsWith('/locales')) return { ok: true, json: async () => ({ dictionaries: translated }) };
      if (url.endsWith('/preview') && previewThrown) throw 0;
      if (url.endsWith('/preview')) {
        if (missingPreview) return { ok: false, status: 404, json: async () => ({ error: 'Session missing' }) };
        if (previewFailed) return { ok: false, json: async () => ({ error: 'Host fallback', messages: [{ key: 'error.guardUnavailable' }] }) };
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
        : { pending, deletionRunning, locked: deletionRunning ? [id] : [], archived: [], guardHealthy: true, receipt: { revision: completed ? 'deleted' : 'empty', count: completed ? 1 : 0 } } };
    },
  };
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox);
  await plugin.apply({
    locale, fiber: { uid: 1 },
    slots: { inject(_, callback) { callback(); }, register(options, component) {
      assert.equal(typeof component, 'function'); components.set(options.id, component as () => MockNode);
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
    locale.setLocale('en');
    assert.ok(render().includes('[en] checking'));
    assert.equal(menu.resolve({ sessionId: id, displayTitle: 'Test' })[0].label, '[en] delete');
    assert.ok(menu.observe().includes(locale));
    resolvePreview({ count: 1, token: 'fixture', archived: false });
    await new Promise(setImmediate);
    rows[id].running = true;
    const current = render();
    assert.equal(current.includes('会话正在运行，暂时无法删除'), false);
    const confirm = current.find((node): node is MockElement => isElement(node) && node.type === ui.Button && nodes(node.props.children).includes('确认删除'));
    assert(confirm);
    assert.equal(confirm.props.disabled, false);
    assert.equal(menu.resolve({ sessionId: id, displayTitle: 'Test' })[0].disabled, false);
    rows[id].running = false; previewFailed = true;
    menu.resolve({ sessionId: id, displayTitle: 'Test' })[0].run();
    await new Promise(setImmediate);
    assert.ok(render().includes('[en] guard unavailable'));
    locale.setLocale('zh');
    assert.ok(render().includes('恢复监测不可用，请重启 DSH。'));
    previewThrown = true;
    menu.resolve({ sessionId: id, displayTitle: 'Test' })[0].run();
    await new Promise(setImmediate);
    const pre = element(render().find(node => isElement(node) && node.type === 'pre'));
    const code = element(nodes(pre.props.children)[0]);
    assert.equal(code.type, 'code');
    assert.deepEqual(code.props.children, ['0'], 'unkeyed diagnostics preserve the original text inside pre/code');
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
    statusFailed = false; await tick(); assert(buttons().every(button => button.props.disabled));
    deletionRunning = false; pending = [{ sessionId: id, queuedAt: 'fixture' }];
    await tick(); assert(buttons().every(button => button.props.disabled), 'a journal awaiting recovery still owns the target');
    pending = []; await tick();
    assert(buttons().every(button => !button.props.disabled)); assert.equal(closeButton.disabled, false);
    (modal()!.props.onClose as () => void)(); assert.equal(modal(), undefined);

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
    (buttons().at(-1)!.props.onClick as () => void)(); await new Promise(setImmediate);
    resolveDelete(); await new Promise(setImmediate); assert.equal(modal(), undefined);

    menu.resolve({ sessionId: id, displayTitle: 'Test' })[0].run(); await new Promise(setImmediate);
    disconnected = completeDespiteDisconnect = missingPreview = true;
    (buttons().at(-1)!.props.onClick as () => void)(); await new Promise(setImmediate);
    assert.equal(modal(), undefined, 'a durable deletion receipt resolves a lost success response even when preview now returns 404');
  } finally { cleanup?.(); }
});

void test('GC menu shows a native spinner, formats binary units and reports failed or invalid size previews', async () => {
  let plugin!: ClientPlugin, menu!: (props: { onDismiss(): void }) => MockNode, mount!: () => () => void;
  let bytes: number | null | undefined, response: unknown, fail: boolean | 'network' = false, requests = 0;
  const ui = { MenuItemButton: 'NativeMenu', StateDot: 'NativeSpinner' };
  const react = {
    Fragment: Symbol('Fragment'),
    createElement,
    useSyncExternalStore: <T>(_: unknown, read: () => T) => read(),
    useState: () => [bytes, (value: typeof bytes) => { bytes = value; }],
    useEffect: (callback: () => () => void) => { mount = callback; },
  };
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), {
    window: { __ModuleLoader__: { load(definition: ClientModule) { plugin = definition.factory(name => name === 'react' ? react : ui); } } },
    fetch: async (url: string) => {
      if (url.endsWith('/locales')) return { ok: true, json: async () => ({ dictionaries }) };
      assert.equal(url, '/session-deletion/api/gc-size'); requests++;
      if (fail === 'network') throw new Error('Disconnected');
      return { ok: !fail, json: async () => fail ? { error: 'Cannot scan' } : { bytes: response } };
    },
  });
  await plugin.apply({
    locale: localeFixture(), fiber: { uid: 1 },
    slots: { inject(_, callback) { callback(); }, register(options, component) { if (options.id === 'session-deletion.gc') {
      assert.equal(typeof component, 'function'); menu = component as typeof menu;
    } } },
    effect(callback, label) { if (label.startsWith('session-deletion locale')) callback(); },
  });
  const render = () => element(element(menu({ onDismiss() {} })).props.children);
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
