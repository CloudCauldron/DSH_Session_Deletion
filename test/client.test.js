import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import vm from 'node:vm';

// Run the shipped browser entry point. No helper is extracted or reimplemented:
// a successful refresh must finish its actual cleanup before startSession fires.
function browserStorage(values) {
  const storage = { ...values };
  Object.defineProperties(storage, {
    getItem: { value: key => storage[key] ?? null },
    setItem: { value: (key, value) => { storage[key] = String(value); } },
    removeItem: { value: key => { delete storage[key]; } },
  });
  return storage;
}

async function refreshClient(localStorage, sessionStorage, deletedId, verify = async () => {}) {
  let plugin;
  let cleanup;
  let finish;
  let poll, receiptRequests = 0, failReceipt = false;
  let receipt = { revision: 'first', deletedIdHashes: [createHash('sha256').update(deletedId).digest('hex')] };
  const finished = new Promise(resolve => { finish = resolve; });
  const sandbox = {
    TextEncoder,
    crypto: { subtle: { digest: async (_, bytes) => createHash('sha256').update(bytes).digest() } },
    localStorage,
    sessionStorage,
    window: {
      __ModuleLoader__: { load(definition) { plugin = definition.factory(() => ({ createElement() {} })); } },
      addEventListener() {}, removeEventListener() {},
    },
    document: {
      body: {}, head: { append() {} }, querySelectorAll: () => [],
      createElement: () => ({ remove() {} }),
    },
    MutationObserver: class { observe() {} disconnect() {} },
    setInterval(callback) { poll = callback; return 1; }, clearInterval() {},
    fetch: async url => {
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
  plugin.apply({
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

test('browser cleanup removes only owned session keys and preserves another draft quoting the deleted ID', { timeout: 2000 }, async () => {
  const deleted = 'session-deleted-123';
  const survivor = 'session-surviving-456';
  const scopedPrefixes = ['dsh.conversation.', 'dsh.sidebar-right.v1.', 'dsh.schedule.task-tab.v1.'];
  const values = {
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
    const view = JSON.parse(storage.getItem('dsh.workspace.view.v5'));
    assert.deepEqual(view.sessionOrderByAccount, { project: [survivor], [deleted]: [survivor] });
    assert.deepEqual(view.groupExpansion, { project: true, [deleted]: false });
  }
});

test('receipt sync fetches only on revision changes, retries failures and keeps cleaning late browser writes', { timeout: 2000 }, async () => {
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

test('deletion checks show the selected copy and refuse confirmation if the session starts running', async () => {
  const id = 'session-copy-test';
  const rows = { [id]: { id, running: false, retainedBy: { mainView: 1 } } };
  const components = new Map(); let plugin, cleanup, resolvePreview, menu;
  const preview = new Promise(resolve => { resolvePreview = resolve; });
  const ui = { Modal: 'NativeModal', MenuItemButton: 'NativeMenu', Button: 'NativeButton', IconTrashOutlineRegular: 'NativeIcon' };
  const react = {
    Fragment: Symbol('Fragment'),
    createElement: (type, props, ...children) => ({ type, props: { ...props, ...(children.length ? { children } : {}) } }),
    useSyncExternalStore: (_, read) => read(), useLayoutEffect() {},
  };
  const sandbox = {
    TextEncoder,
    crypto: { subtle: { digest: async (_, bytes) => createHash('sha256').update(bytes).digest() } },
    localStorage: browserStorage({}), sessionStorage: browserStorage({}),
    window: { __ModuleLoader__: { load(definition) { plugin = definition.factory(name => name === 'react' ? react : ui); } }, addEventListener() {}, removeEventListener() {} },
    document: { body: {}, head: { append() {} }, querySelectorAll: () => [], createElement: () => ({ remove() {} }) },
    MutationObserver: class { observe() {} disconnect() {} }, setInterval() { return 1; }, clearInterval() {},
    fetch: async url => ({ ok: true, json: () => url.endsWith('/preview') ? preview : Promise.resolve(url.endsWith('/receipt')
      ? { revision: 'empty', deletedIdHashes: [] }
      : { pending: [], locked: [], archived: [], guardHealthy: true, receipt: { revision: 'empty', count: 0 } }) }),
  };
  vm.runInNewContext(await readFile(new URL('../lib/client.js', import.meta.url), 'utf8'), sandbox);
  plugin.apply({
    slots: { inject(_, callback) { callback(); }, register(options, component) { components.set(options.id, component); } },
    contextMenus: { register(contribution) { menu = contribution; return () => {}; } },
    sessions: { list: { getSnapshot: () => ({ byId: rows }), subscribe: () => () => {} } },
    uiWorkspace: { startSession() {} }, effect(callback) { cleanup = callback(); },
  });
  function nodes(value) {
    if (Array.isArray(value)) return value.flatMap(nodes);
    if (value === null || value === undefined) return [];
    return [value, ...nodes(value?.props?.description), ...nodes(value?.props?.children), ...nodes(value?.props?.footer)];
  }
  try {
    await new Promise(setImmediate);
    menu.resolve({ sessionId: id, displayTitle: 'Test' })[0].run();
    const render = () => nodes(components.get('session-deletion.dialog')());
    assert.ok(render().includes('正在检查会话状态…'));
    resolvePreview({ count: 1, token: 'fixture', archived: false });
    await new Promise(setImmediate);
    rows[id].running = true;
    const current = render();
    assert.ok(current.includes('会话正在运行，暂时无法删除'));
    const confirm = current.find(node => node?.type === ui.Button && nodes(node.props.children).includes('确认删除'));
    assert.equal(confirm.props.disabled, true);
  } finally { cleanup?.(); }
});
