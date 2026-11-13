/** Browser bundle in DSH's module-loader format; React comes from the host. */
type ReactAPI = typeof import('react');
type ElementNode = import('react').ReactNode;
type ClientMessage = import('./locale.js').LocalizedMessage;
interface DeletionClientContext {
  fiber: { uid: number | null };
  locale: {
    register(namespace: string, locale: string, dictionary: Record<string, string>): () => void;
    bind(namespace: string): (key: string, params?: Record<string, unknown>) => string;
    getSnapshot(): { active: string; revision: number };
    subscribe(listener: () => void): () => void;
  };
  slots: { inject(name: string, callback: () => unknown): unknown; register(options: { name: string; id: string; order: number; inject?: () => object }, component: unknown): unknown };
  contextMenus: { register(options: {
    id: string; target: 'session'; order: number;
    observe(): { getSnapshot(): unknown; subscribe(callback: () => void): () => void }[];
    resolve(target: { sessionId: string; displayTitle: string }): {
      id: string; label: string; disabled: boolean; danger: boolean; separatorBefore: boolean; afterContent: boolean; icon: { key: string }; run(): void;
    }[];
  }): () => void };
  effect(callback: () => () => void, label: string): unknown;
  sessions: { list: { getSnapshot(): { byId: Record<string, { id: string; running: boolean; retainedBy: Record<string, number> }> }; subscribe(callback: () => void): () => void } };
  uiWorkspace: { startSession(): void };
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- Augments the host's global Window without turning this browser entry into a module.
interface Window {
  __ModuleLoader__: { load(module: { id: string; factory(require: (name: string) => unknown): unknown }): void };
}
interface PendingDeletion { sessionId: string; queuedAt: string }
interface GcResult { total: number }
interface GcDialog { busy?: boolean; error?: Error }
interface DeletionReceipt { revision: string; deletedIdHashes: string[] }
interface DeletionStatus { gcRunning?: boolean; deletionRunning?: boolean; pending: PendingDeletion[]; locked: string[]; archived: string[]; guardHealthy: boolean; receipt: { revision: string; count: number } }
interface DeletionPreview { count: number; token: string; archived: boolean }
interface DeletionDialog { id: string; title: string; preview?: DeletionPreview; busy?: boolean; error?: Error }

window.__ModuleLoader__.load({ id: 'dsh-session-deletion', factory(require) {
  const React = require('react') as ReactAPI;
  const h = React.createElement;
  const namespace = 'session-deletion';
  let t: ReturnType<DeletionClientContext['locale']['bind']>;
  class ApiError extends Error { constructor(text: string, readonly messages?: ClientMessage[]) { super(text); } }
  const asError = (error: unknown): Error => error instanceof Error ? error : new Error(String(error));
  const translate = (message: ClientMessage) => t(message.key, message.params);
  const errorText = (error: unknown): string => error instanceof ApiError && error.messages?.length
    ? error.messages.map(translate).join(t('error.separator')) : error instanceof Error ? error.message : String(error);
  const ui = require('@deepseek-ai/dsh-client-ui-primitives') as {
    MenuItemButton: import('react').ComponentType<{ children: ElementNode; disabled?: boolean; danger?: boolean; separatorBefore?: boolean; icon?: ElementNode; title?: string; onSelect(): void }>;
    Modal: import('react').ComponentType<{ open: boolean; onClose(): void; closeLabel: string; title: string; description?: ElementNode; footer?: ElementNode; children?: ElementNode; className?: string }>;
    Button: import('react').ComponentType<import('react').ButtonHTMLAttributes<HTMLButtonElement> & { variant: 'outline' }>;
    Toast: import('react').ComponentType<{ text: string; icon?: ElementNode; holdMs?: number; onDone(): void }>;
    IconWarningOutlineRegular: import('react').ComponentType<{ size?: number }>;
    StateDot: import('react').ComponentType<{ state: 'ongoing'; size?: number }>;
  };
  // The native Modal portals to document.body, outside our overlay slot wrapper.
  const pluginUiSelector = '.dsh-session-deletion-modal';
  const listeners = new Set<() => void>();
  let dialog: DeletionDialog | undefined;
  let gcDialog: GcDialog | undefined;
  let status: DeletionStatus = { pending: [], locked: [], archived: [], guardHealthy: false, receipt: { revision: '', count: 0 } };
  let receipt: DeletionReceipt | undefined;
  let toast: { id: number; message: ClientMessage } | undefined;
  let toastId = 0;
  let context: DeletionClientContext | undefined;
  let submitting = false;
  let refreshing = false;
  let lastMainId: string | undefined;
  const inputStates = new Map<HTMLElement, { inert: boolean; aria: string | null }>();
  function affected(): boolean {
    if (gcDialog?.busy || status.gcRunning) return true;
    if (submitting && dialog?.id === lastMainId) return true;
    if (!context) return false;
    if (lastMainId && status.locked.includes(lastMainId)) return true;
    const rows = Object.values(context.sessions.list.getSnapshot().byId);
    return rows.some(row => status.locked.includes(row.id) && Object.values(row.retainedBy).some(n => n > 0));
  }
  function protectInputs(): void {
    if (!affected()) {
      for (const [element, original] of inputStates) {
        element.inert = original.inert;
        if (original.aria === null) element.removeAttribute('aria-disabled'); else element.setAttribute('aria-disabled', original.aria);
        element.classList.remove('dsh-deletion-input-locked');
      }
      inputStates.clear(); return;
    }
    for (const element of document.querySelectorAll<HTMLElement>('input, textarea, button, select, [contenteditable="true"]')) {
      if (element.closest(pluginUiSelector)) continue;
      if (!inputStates.has(element)) inputStates.set(element, { inert: element.inert, aria: element.getAttribute('aria-disabled') });
      element.inert = true; element.setAttribute('aria-disabled', 'true'); element.classList.add('dsh-deletion-input-locked');
    }
  }
  let generation = 0;
  let snapshot = { dialog, status, gcDialog, toast };
  const publish = () => { snapshot = { dialog, status, gcDialog, toast }; for (const listener of listeners) listener(); protectInputs(); };
  const stateSource = { getSnapshot: () => snapshot, subscribe: (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; } };
  const useSnapshot = () => React.useSyncExternalStore(stateSource.subscribe, stateSource.getSnapshot);
  async function api<T>(path: string, data?: object): Promise<T> {
    const response = await fetch('/session-deletion/api/' + path, { credentials: 'same-origin', cache: 'no-store',
      method: data ? 'POST' : 'GET', headers: data ? { 'Content-Type': 'application/json', 'X-DSH-Session-Deletion': '1' } : {},
      ...(data ? { body: JSON.stringify(data) } : {}) });
    const result = await response.json() as T & { error?: string; messages?: ClientMessage[] };
    if (!response.ok) throw new ApiError(result.error || `HTTP ${response.status}`, result.messages);
    return result;
  }
  async function hash(value: string): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  async function cleanBrowserState(hashes: string[]): Promise<void> {
    if (!hashes.length) return;
    const deleted = new Set(hashes);
    const matches = async (value: string) => deleted.has(await hash(value));
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of Object.keys(storage)) {
        // The three session-scoped stores plus two navigation stores.
        // Never recursively rewrite arbitrary DSH preferences or other drafts.
        const prefix = ['dsh.conversation.', 'dsh.sidebar-right.v1.', 'dsh.schedule.task-tab.v1.'].find(p => key.startsWith(p));
        if (!prefix && key !== 'dsh.sessions.current' && key !== 'dsh.workspace.view.v5') continue;
        const original = storage.getItem(key); if (original === null) continue;
        if (prefix) {
          if (await matches(key.slice(prefix.length)) && storage.getItem(key) === original) storage.removeItem(key);
          continue;
        }
        try {
          const parsed: unknown = JSON.parse(original);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
          const data = parsed as Record<string, unknown>;
          if (key === 'dsh.sessions.current') {
            if (typeof data.sessionId === 'string' && await matches(data.sessionId) && storage.getItem(key) === original) storage.removeItem(key);
            continue;
          }
          const orders = data.sessionOrderByAccount;
          if (!orders || typeof orders !== 'object' || Array.isArray(orders)) continue;
          let changed = false;
          for (const [account, order] of Object.entries(orders)) {
            if (!Array.isArray(order)) continue;
            const kept: unknown[] = [];
            for (const id of order) {
              if (typeof id === 'string' && await matches(id)) changed = true;
              else kept.push(id);
            }
            (orders as Record<string, unknown>)[account] = kept;
          }
          // Workspace keys, expansion state and unrelated preferences are not session identities.
          if (changed && storage.getItem(key) === original) storage.setItem(key, JSON.stringify(data));
        } catch { /* Non-JSON app preferences contain no structured session state. */ }
      }
    }
  }
  async function refresh(): Promise<void> {
    if (refreshing) return;
    refreshing = true;
    try {
      status = await api<DeletionStatus>('status'); publish();
      if (!receipt || receipt.revision !== status.receipt.revision) receipt = await api<DeletionReceipt>('receipt');
      // Keep applying cached tombstones: an old tab may write a deleted session's state back later.
      await cleanBrowserState(receipt.deletedIdHashes);
      if (lastMainId && receipt.deletedIdHashes.includes(await hash(lastMainId))) {
        lastMainId = undefined; context?.uiWorkspace.startSession();
      }
    } catch { /* A disconnected host is expected during shutdown. */ }
    finally { refreshing = false; }
  }
  async function open(id: string, title: string): Promise<void> {
    const own = ++generation;
    dialog = { id, title, busy: true }; publish();
    try {
      const preview = await api<DeletionPreview>('preview', { sessionId: id });
      if (own === generation) { dialog = { id, title, preview }; publish(); }
    } catch (e) {
      if (own === generation) { dialog = { id, title, error: asError(e) }; publish(); }
    }
  }
  function close(): void { generation++; dialog = undefined; publish(); }
  async function confirm(): Promise<void> {
    if (!dialog?.preview || dialog.busy || submitting || status.gcRunning) return;
    const current = dialog;
    submitting = true; toast = undefined; dialog = { ...current, busy: true, error: undefined }; publish();
    try {
      await api('delete', { sessionId: current.id, token: current.preview!.token, confirmation: 'DELETE_IDLE_SESSION' });
      toast = { id: ++toastId, message: current.title ? { key: 'delete.success', params: { title: current.title } } : { key: 'delete.successUnnamed' } };
      close(); await refresh();
    } catch (e) { dialog = { ...current, busy: false, error: asError(e) }; publish(); }
    finally { submitting = false; await refresh(); protectInputs(); }
  }
  function useDisabledClose(selector: string, open: boolean, busy: boolean): void {
    React.useLayoutEffect(() => {
      // Modal exposes no disabled-close prop. Synchronize only its native
      // close button; footer buttons remain controlled by React.
      const closeButton = document.querySelector<HTMLButtonElement>(selector + ' button[aria-label]');
      if (closeButton) closeButton.disabled = busy;
    }, [selector, open, busy]);
  }
  function sessionMenuActions({ sessionId, displayTitle }: { sessionId: string; displayTitle: string }) {
    const running = context?.sessions.list.getSnapshot().byId[sessionId]?.running;
    const secure = !!globalThis.crypto?.subtle;
    const disabled = running || status.locked.includes(sessionId) || !status.guardHealthy || !secure;
    return [{ id: 'delete', label: t('delete.menu'), disabled: !!disabled || !!status.gcRunning, danger: true, separatorBefore: true,
      afterContent: true, icon: { key: 'workspace.delete' }, run: () => { void open(sessionId, displayTitle); } }];
  }
  function formatBytes(bytes: number): string {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let unit = 0;
    while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit++; }
    return `${Number(bytes.toFixed(2))} ${units[unit]}`;
  }
  function GcMenuItem({ onDismiss }: { onDismiss(): void }): ElementNode {
    const state = useSnapshot();
    const [bytes, setBytes] = React.useState<number | null>();
    React.useEffect(() => {
      let active = true;
      void api<{ bytes: number }>('gc-size')
        .then(result => { if (active) setBytes(Number.isFinite(result.bytes) && result.bytes >= 0 ? result.bytes : null); })
        .catch(() => { if (active) setBytes(null); });
      return () => { active = false; };
    }, []);
    const size = bytes === undefined
      ? h('span', { role: 'status', 'aria-label': t('gc.calculating'), style: { display: 'inline-flex', verticalAlign: 'middle' } }, h(ui.StateDot, { state: 'ongoing', size: 12 }))
      : bytes === null ? t('gc.sizeUnavailable') : formatBytes(bytes);
    const [before, after] = t('gc.menu', { size: '{size}' }).split('{size}');
    return h(ui.MenuItemButton, { disabled: !state.status.guardHealthy || !!state.status.gcRunning, separatorBefore: true,
      // Phosphor Broom (MIT): its 16-unit outline renders at DSH's regular 1px weight at 16px.
      icon: h('svg', { width: 16, height: 16, viewBox: '0 0 256 256', fill: 'currentColor', 'aria-hidden': true, focusable: false },
        h('path', { d: 'M235.5 216.81c-22.56-11-35.5-34.58-35.5-64.8v-17.28a15.94 15.94 0 0 0-10.09-14.87L165 110a8 8 0 0 1-4.48-10.34l21.32-53a28 28 0 0 0-16.1-37a28.14 28.14 0 0 0-35.82 16a.6.6 0 0 0 0 .12L108.9 79a8 8 0 0 1-10.37 4.49L73.11 73.14a15.89 15.89 0 0 0-17.37 3.66C34.68 98.45 24 123.75 24 152a111.45 111.45 0 0 0 31.18 77.53A8 8 0 0 0 61 232h171a8 8 0 0 0 3.5-15.19M67.14 88l25.41 10.3a24 24 0 0 0 31.23-13.45l21-53c2.56-6.11 9.47-9.27 15.43-7a12 12 0 0 1 6.88 15.92l-21.4 52.99a24 24 0 0 0 13.43 31.14l24.88 9.83V153L55.77 101.71A109 109 0 0 1 67.14 88m48 128a87.53 87.53 0 0 1-24.34-42a8 8 0 0 0-15.49 4a105.2 105.2 0 0 0 18.36 38H64.44A95.54 95.54 0 0 1 40 152a85.9 85.9 0 0 1 7.73-36.29l137.8 55.12c3 18 10.56 33.48 21.89 45.16Z' })),
      onSelect: () => { onDismiss(); gcDialog = {}; publish(); }, children: h(React.Fragment, null, before, size, after) });
  }
  async function collect(): Promise<void> {
    if (gcDialog?.busy || status.gcRunning) return;
    gcDialog = { busy: true }; toast = undefined; publish();
    try {
      const result = await api<GcResult>('gc', { confirmation: 'COLLECT_ORPHAN_ATTACHMENTS' });
      gcDialog = undefined;
      toast = { id: ++toastId, message: { key: 'gc.success', params: { count: result.total } } };
    }
    catch (error) { gcDialog = { error: asError(error) }; }
    finally { publish(); await refresh(); }
  }
  function GcOverlay(): ElementNode {
    const state = useSnapshot(); const d = state.gcDialog;
    const busy = !!d?.busy || !!state.status.gcRunning;
    useDisabledClose('.dsh-session-deletion-gc', !!d, busy);
    if (!d) return null;
    const dismiss = () => { if (!busy) { gcDialog = undefined; publish(); } };
    return h(ui.Modal, {
      open: true, onClose: dismiss, closeLabel: t('common.close'), className: 'dsh-session-deletion-modal dsh-session-deletion-gc',
      title: t('gc.title'),
      description: t('gc.description'),
      footer: h(React.Fragment, null,
        h(ui.Button, { variant: 'outline', onClick: dismiss, disabled: busy }, t('common.cancel')),
        h(ui.Button, { variant: 'outline', onClick: () => { void collect(); }, disabled: busy }, t(busy ? 'gc.busy' : 'gc.confirm'))),
      children: d.error ? h('div', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', marginTop: 8, fontSize: 12, lineHeight: '18px' } }, errorText(d.error)) : undefined,
    });
  }

  function StatusToast({ text, warning }: { text: string; warning: boolean }): ElementNode {
    const [dismissed, setDismissed] = React.useState(false);
    // A keyed occurrence expires once; polling the same state must not reopen it.
    return dismissed ? null : h(ui.Toast, {
      text, onDone: () => { setDismissed(true); },
      ...(warning ? { icon: h(ui.IconWarningOutlineRegular, {}), holdMs: 8000 } : {}),
    });
  }

  function Overlay(): ElementNode {
    const state = useSnapshot(); const d = state.dialog;
    const busy = !!d?.busy || submitting || !!state.status.gcRunning;
    useDisabledClose('.dsh-session-deletion-confirmation', !!d, busy);
    const gcBusy = !!state.status.gcRunning || !!state.gcDialog?.busy;
    const recovering = !gcBusy && state.status.pending.length > 0 && !submitting && state.status.deletionRunning === false;
    const noticeKey = gcBusy ? 'gc.busy'
      : recovering ? 'recovery.pending'
      : submitting || state.status.deletionRunning || state.status.locked.length ? 'delete.busy' : undefined;
    const notice = state.toast ? h(ui.Toast, {
      key: state.toast.id, text: translate(state.toast.message),
      onDone: () => { if (toast === state.toast) { toast = undefined; publish(); } },
    }) : noticeKey ? h(StatusToast, { key: noticeKey, text: t(noticeKey), warning: recovering }) : null;
    if (!d) return h(React.Fragment, null, notice, null);
    const active = context?.sessions.list.getSnapshot().byId[d.id]?.running && !submitting;
    const archived = state.status.archived.includes(d.id);
    const children = Math.max(0, (d.preview?.count ?? 1) - 1);
    const removalText = t(children > 0 ? 'delete.descriptionWithChildren' : 'delete.description', { count: children });
    const dismiss = () => { if (!busy) close(); };
    return h(React.Fragment, null, notice,
      h(ui.Modal, {
        open: true, onClose: dismiss, closeLabel: t('common.close'), className: 'dsh-session-deletion-modal dsh-session-deletion-confirmation',
        title: t(archived ? 'delete.title' : 'delete.archiveTitle'),
        description: h(React.Fragment, null,
          h('strong', { style: { display: 'block', fontWeight: 600, overflowWrap: 'anywhere' } }, d.title || t('session.unnamed')),
          h('code', { style: { display: 'block', marginTop: 4, fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' } }, d.id),
          d.preview ? h('span', { style: { display: 'block', marginTop: 12 } }, removalText)
            : d.busy ? h('span', { style: { display: 'block', marginTop: 12 } }, t('delete.checking')) : null),
        footer: h(React.Fragment, null,
          h(ui.Button, { variant: 'outline', onClick: dismiss, disabled: busy }, t('common.cancel')),
          h(ui.Button, { variant: 'outline', className: 'dsh-session-deletion-danger', onClick: () => { void confirm(); }, disabled: busy || !d.preview || !!active }, t(submitting ? 'delete.submitting' : 'delete.confirm'))),
        children: active || d.error ? h(React.Fragment, null,
          active ? h('div', { role: 'status', style: { color: 'var(--dsw-alias-label-secondary)', fontSize: 12, lineHeight: '18px' } }, t('delete.running')) : null,
          d.error ? h('div', { role: 'alert', style: { color: 'var(--dsw-alias-state-error-primary)', marginTop: 8, fontSize: 12, lineHeight: '18px', overflowWrap: 'anywhere' } }, errorText(d.error)) : null) : undefined,
      }));
  }
  return { inject: ['slots', 'sessions', 'uiWorkspace', 'contextMenus', 'locale'], async apply(ctx: DeletionClientContext) {
    const { dictionaries } = await api<{ dictionaries: Record<string, Record<string, string>> }>('locales');
    if (ctx.fiber.uid === null) return;
    ctx.effect(() => {
      const disposers = Object.entries(dictionaries).map(([locale, dictionary]) =>
        ctx.locale.register(namespace, locale, { ...dictionaries.zh, ...dictionary }));
      return () => { for (const dispose of disposers.reverse()) dispose(); };
    }, 'session-deletion locale dictionaries');
    t = ctx.locale.bind(namespace);
    ctx.effect(() => ctx.locale.subscribe(publish), 'session-deletion locale changes');
    context = ctx;
    ctx.effect(() => ctx.contextMenus.register({ id: 'session-deletion.action', target: 'session', order: 10000,
      observe: () => [stateSource, ctx.sessions.list, ctx.locale], resolve: sessionMenuActions }), 'session-deletion menu');
    ctx.slots.inject('sidebar.panellist.actions', () => ctx.slots.register({ name: 'sidebar.panellist.actions', id: 'session-deletion.gc', order: 10000 }, GcMenuItem));
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'session-deletion.gc-dialog', order: 560 }, GcOverlay));
    ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'session-deletion.dialog', order: 550 }, Overlay));
    ctx.effect(() => {
      const watchSelection = () => {
        const current = Object.values(ctx.sessions.list.getSnapshot().byId).find(row => (row.retainedBy.mainView || 0) > 0);
        if (current) lastMainId = current.id;
        publish();
      };
      const unsubscribe = ctx.sessions.list.subscribe(watchSelection); watchSelection();
      const observer = new MutationObserver(protectInputs); observer.observe(document.body, { childList: true, subtree: true });
      const prevent = (event: Event) => {
        if (affected() && !(event.target instanceof Element && event.target.closest(pluginUiSelector))) { event.preventDefault(); event.stopImmediatePropagation(); }
      };
      const events = ['click', 'submit', 'keydown', 'beforeinput', 'paste', 'drop'];
      for (const event of events) window.addEventListener(event, prevent, true);
      const style = document.createElement('style'); style.textContent = '.dsh-deletion-input-locked{opacity:.45!important;pointer-events:none!important}.dsh-session-deletion-danger:not(:disabled){color:var(--dsw-alias-state-error-primary)}.dsh-session-deletion-confirmation .dsh-session-deletion-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}.dsh-session-deletion-modal button[aria-label]:disabled{opacity:.4;pointer-events:none}'; document.head.append(style);
      void refresh();
      const timer = setInterval(() => { void refresh(); }, 1000);
      return () => { clearInterval(timer); unsubscribe(); observer.disconnect(); for (const event of events) window.removeEventListener(event, prevent, true); submitting = false; gcDialog = undefined; toast = undefined; receipt = undefined; status.gcRunning = false; status.locked = []; protectInputs(); style.remove(); listeners.clear(); };
    }, 'session-deletion status');
  } };
} });
