import { ApiError, asFailure, readFailure, registerClientLocale, renderFailure, type LocaleClientContext } from './locale/client.js';
import type { Failure, LocalizedMessage, LocalizedProps } from './locale/shared.js';

type ReactAPI = typeof import('react');
type ElementNode = import('react').ReactNode;
type ClientScope = PromiseLike<unknown> & { dispose(): Promise<void> };
export interface DeletionClientContext extends LocaleClientContext {
  plugin(apply: (ctx: DeletionClientContext) => Promise<void>): ClientScope;
  locale: LocaleClientContext['locale'] & {
    bind(namespace: string): LocalizedProps['t'];
    getSnapshot(): { active: string; revision: number };
    subscribe(listener: () => void): () => void;
  };
  slots: { inject(name: string, callback: () => unknown): unknown; register(options: { name: string; id: string; key?: string; order?: number; locale: string; inject?: () => object }, component: unknown): unknown };
  contextMenus: { register(options: {
    id: string; target: 'session'; order: number;
    observe(): { getSnapshot(): unknown; subscribe(callback: () => void): () => void }[];
    resolve(target: { sessionId: string; displayTitle: string }): {
      id: string; label: string; disabled: boolean; danger: boolean; separatorBefore: boolean; afterContent: boolean; icon: { key: string }; run(): void;
    }[];
  }): () => void };
  sessions: { list: { getSnapshot(): { byId: Record<string, { id: string; running: boolean; retainedBy: Record<string, number> }> }; subscribe(callback: () => void): () => void } };
  uiWorkspace: { startSession(): void };
}
declare global {
  interface Window {
    __ModuleLoader__: { load(module: { id: string; factory(require: (name: string) => unknown): unknown }): void };
  }
}
export interface PendingDeletion { sessionId: string; queuedAt: string }
interface GcResult { total: number }
interface CleanupDialog { kind: 'gc' | 'records'; busy?: boolean; error?: Failure }
export interface DeletionReceipt { revision: string; deletedIdHashes: string[] }
interface DeletionStatus { gcRunning?: boolean; clearingRecords?: boolean; deletionRunning?: boolean; pending: PendingDeletion[]; locked: string[]; archived: string[]; ok: boolean; receipt: { revision: string; count: number } }
export interface DeletionPreview { count: number; token: string; archived: boolean }
interface DeletionDialog { id: string; title: string; preview?: DeletionPreview; busy?: boolean; error?: Failure }

async function api<T>(path: string, data?: object, signal?: AbortSignal): Promise<T> {
  const response = await fetch('/session-deletion/api/' + path, { credentials: 'same-origin', cache: 'no-store', signal,
    method: data ? 'POST' : 'GET', headers: data ? { 'Content-Type': 'application/json', 'X-DSH-Session-Deletion': '1' } : {},
    ...(data ? { body: JSON.stringify(data) } : {}) });
  if (!response.ok) throw new ApiError(await readFailure(response), response.status);
  return await response.json() as T;
}

type Refresh = () => Promise<void>;

window.__ModuleLoader__.load({ id: 'dsh-session-deletion', factory: require => ({
  inject: ['slots', 'sessions', 'uiWorkspace', 'contextMenus', 'locale'],
  apply(ctx: DeletionClientContext) {
    const controller = new AbortController();
    const { signal } = controller;
    let scope: ClientScope | undefined;
    let refresh: Refresh | undefined;
    let polling = false;
    // rc.5 can retain this browser bundle while its host entry is disabled.
    async function poll(): Promise<void> {
      if (signal.aborted || polling) return;
      polling = true;
      try {
        if (refresh) { await refresh(); return; }
        const status = await api<DeletionStatus>('status', undefined, signal);
        if (signal.aborted || !status.ok || ctx.fiber.uid === null) return;
        scope = ctx.plugin(async child => {
          try { refresh = await mountClient(child, require, poll, status, signal); }
          catch (error) { if (!signal.aborted) throw error; }
        });
        await scope;
      } catch (error) {
        if (!refresh || (error instanceof ApiError && error.status === 404)) {
          refresh = undefined;
          await scope?.dispose();
          scope = undefined;
        }
      } finally { polling = false; }
    }
    ctx.effect(() => {
      const timer = setInterval(() => { void poll(); }, 1000);
      // Cordis waits for child setup during disposal, including pending network reads.
      return () => { clearInterval(timer); controller.abort(); };
    }, 'session-deletion status');
    // DSH waits for client plugins before opening its gateway connection.
    void poll();
  },
}) });

async function mountClient(ctx: DeletionClientContext, require: (name: string) => unknown, poll: () => Promise<void>, initial: DeletionStatus, signal: AbortSignal): Promise<Refresh | undefined> {
  const namespace = 'session-deletion';
  await registerClientLocale(ctx, namespace, signal);
  if (signal.aborted || ctx.fiber.uid === null) return;
  const React = require('react') as ReactAPI;
  const h = React.createElement;
  function errorContent(error: Failure, t: LocalizedProps['t']): ElementNode {
    return h('span', { role: 'alert', style: { display: 'block', color: 'var(--dsw-alias-state-error-primary)',
      marginTop: 8, fontSize: 12, overflowWrap: 'anywhere' } }, renderFailure(React, t, error));
  }
  const ui = require('@deepseek-ai/dsh-client-ui-primitives') as {
    MenuItemButton: import('react').ComponentType<{ children: ElementNode; disabled?: boolean; danger?: boolean; separatorBefore?: boolean; icon?: ElementNode; title?: string; onSelect(): void }>;
    Modal: import('react').ComponentType<{ open: boolean; onClose(): void; closeLabel: string; title: string; description?: ElementNode; footer?: ElementNode; children?: ElementNode; className?: string }>;
    Button: import('react').ComponentType<import('react').ButtonHTMLAttributes<HTMLButtonElement> & { variant: 'outline'; size?: 'sm' }>;
    Toast: import('react').ComponentType<{ text: string; tone?: 'success'; icon?: ElementNode; holdMs?: number; onDone(): void }>;
    IconWarningOutlineRegular: import('react').ComponentType<{ size?: number }>;
    StateDot: import('react').ComponentType<{ state: 'ongoing'; size?: number }>;
  };
  // The native Modal portals to document.body, outside our overlay slot wrapper.
  const pluginUiSelector = '.dsh-session-deletion-modal';
  const listeners = new Set<() => void>();
  let dialog: DeletionDialog | undefined;
  let cleanupDialog: CleanupDialog | undefined;
  let status = initial;
  let receipt: { revision: string; deleted: ReadonlySet<string> } | undefined;
  let toast: { id: number; message: LocalizedMessage } | undefined;
  let toastId = 0;
  let active = true;
  let submitting = false;
  let lastMainId: string | undefined;
  const inputStates = new Map<HTMLElement, { inert: boolean; aria: string | null }>();
  function maintenanceReady(state: DeletionStatus): boolean {
    return state.ok && !submitting && !cleanupDialog?.busy && !state.clearingRecords && !state.gcRunning && !state.deletionRunning && !state.pending.length;
  }
  function affected(): boolean {
    if (!active) return false;
    if ((cleanupDialog?.kind === 'gc' && cleanupDialog.busy) || status.gcRunning) return true;
    if (submitting && dialog?.id === lastMainId) return true;
    if (!status.deletionRunning) return false;
    if (lastMainId && status.locked.includes(lastMainId)) return true;
    const rows = Object.values(ctx.sessions.list.getSnapshot().byId);
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
  let snapshot = { dialog, status, cleanupDialog, toast };
  const publish = () => { snapshot = { dialog, status, cleanupDialog, toast }; for (const listener of listeners) listener(); protectInputs(); };
  const stateSource = { getSnapshot: () => snapshot, subscribe: (callback: () => void) => { listeners.add(callback); return () => { listeners.delete(callback); }; } };
  const useSnapshot = () => React.useSyncExternalStore(stateSource.subscribe, stateSource.getSnapshot);
  async function hash(value: string): Promise<string> {
    const bytes = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return [...new Uint8Array(bytes)].map(v => v.toString(16).padStart(2, '0')).join('');
  }
  async function cleanBrowserState(deleted: ReadonlySet<string>, isCurrent: () => boolean): Promise<void> {
    const matches = async (value: string) => deleted.has(await hash(value));
    for (const storage of [localStorage, sessionStorage]) {
      for (const key of Object.keys(storage)) {
        if (!isCurrent()) return;
        // The three session-scoped stores plus two navigation stores.
        // Never recursively rewrite arbitrary DSH preferences or other drafts.
        const prefix = ['dsh.conversation.', 'dsh.sidebar-right.v1.', 'dsh.schedule.task-tab.v1.'].find(p => key.startsWith(p));
        if (!prefix && key !== 'dsh.sessions.current' && key !== 'dsh.workspace.view.v5') continue;
        const original = storage.getItem(key); if (original === null) continue;
        const unchanged = () => isCurrent() && storage.getItem(key) === original;
        if (prefix) {
          if (await matches(key.slice(prefix.length)) && unchanged()) storage.removeItem(key);
          continue;
        }
        try {
          const parsed: unknown = JSON.parse(original);
          if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) continue;
          const data = parsed as Record<string, unknown>;
          if (key === 'dsh.sessions.current') {
            if (typeof data.sessionId === 'string' && await matches(data.sessionId) && unchanged()) storage.removeItem(key);
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
          if (changed && unchanged()) storage.setItem(key, JSON.stringify(data));
        } catch { /* Non-JSON app preferences contain no structured session state. */ }
      }
    }
  }
  async function refresh(initial?: DeletionStatus): Promise<void> {
    if (!active || signal.aborted) return;
    const own = generation, wasSubmitting = submitting;
    // Replacing the existing preview revokes a delete request whose body has
    // not arrived yet. An idle status alone cannot prove that request ended.
    const failed = dialog?.error && !submitting && !dialog.preview && !status.pending.length ? dialog : undefined;
    let missing = false;
    if (failed) {
      try {
        const preview = await api<DeletionPreview>('preview', { sessionId: failed.id });
        if (own === generation && dialog === failed) dialog = { ...failed, preview };
      } catch (error) {
        // The host revokes the previous token even when the deleted session has no receipt left.
        missing = error instanceof ApiError && error.status === 404 && !!error.failure.messages?.some(item => item.key === 'error.sessionMissing');
      }
    }
    const previousReceipt = receipt;
    try {
      const next = initial ?? await api<DeletionStatus>('status', undefined, signal);
      if (receipt !== previousReceipt) return; // A clear response superseded this poll.
      status = next;
    }
    catch (error) {
      if (receipt !== previousReceipt) return;
      if (!signal.aborted && status.ok) { status = { ...status, ok: false }; publish(); }
      throw error;
    }
    if (!active || signal.aborted) return;
    if (own === generation && !wasSubmitting && !submitting && dialog?.busy && dialog.error && status.deletionRunning === false
      && (dialog.preview || missing || status.pending.length)) dialog = { ...dialog, busy: false };
    if (cleanupDialog?.kind === 'records' && status.receipt.count === 0 && !cleanupDialog.busy && !cleanupDialog.error) cleanupDialog = undefined;
    publish();
    try {
      if (!receipt || receipt.revision !== status.receipt.revision) {
        const next = await api<DeletionReceipt>('receipt', undefined, signal);
        if (receipt !== previousReceipt) return;
        receipt = { revision: next.revision, deleted: new Set(next.deletedIdHashes) };
      }
      const currentReceipt = receipt;
      const isCurrent = () => active && !signal.aborted && receipt === currentReceipt;
      if (!currentReceipt.deleted.size || !isCurrent()) return;
      // Keep applying cached tombstones: an old tab may write a deleted session's state back later.
      const { deleted } = currentReceipt;
      await cleanBrowserState(deleted, isCurrent);
      const current = dialog;
      if (current?.error && !submitting && deleted.has(await hash(current.id))
        && dialog === current && !submitting && isCurrent()) completeDeletion(current.title);
      const selected = lastMainId;
      if (selected && deleted.has(await hash(selected)) && selected === lastMainId && isCurrent()) {
        lastMainId = undefined; ctx.uiWorkspace.startSession();
      }
    } catch { /* A disconnected host is expected during shutdown. */ }
  }
  async function open(id: string, title: string): Promise<void> {
    const own = ++generation;
    dialog = { id, title, busy: true }; publish();
    try {
      const preview = await api<DeletionPreview>('preview', { sessionId: id });
      if (own === generation) { dialog = { id, title, preview }; publish(); }
    } catch (e) {
      if (own === generation) { dialog = { id, title, error: asFailure(e) }; publish(); }
    }
  }
  function close(): void { generation++; dialog = undefined; publish(); }
  function completeDeletion(title: string): void {
    toast = { id: ++toastId, message: title ? { key: 'delete.success', params: { title } } : { key: 'delete.successUnnamed' } };
    close();
  }
  async function confirm(): Promise<void> {
    if (!dialog?.preview || dialog.busy || submitting || !maintenanceReady(status)) return;
    const current = dialog;
    generation++; submitting = true; toast = undefined; dialog = { ...current, busy: true, error: undefined }; publish();
    try {
      await api('delete', { sessionId: current.id, token: current.preview!.token, confirmation: 'DELETE_SESSION' });
      submitting = false;
      completeDeletion(current.title);
    } catch (e) { submitting = false; dialog = { ...current, preview: undefined, busy: true, error: asFailure(e) }; publish(); }
    finally { await poll(); protectInputs(); }
  }
  function useDisabledClose(selector: string, open: boolean, busy: boolean): void {
    React.useLayoutEffect(() => {
      // Modal exposes no disabled-close prop. Synchronize only its native
      // close button; footer buttons remain controlled by React.
      const closeButton = document.querySelector<HTMLButtonElement>(selector + ' button[aria-label]');
      if (closeButton) closeButton.disabled = busy;
    }, [selector, open, busy]);
  }
  function formatBytes(bytes: number): string {
    const units = ['B', 'KiB', 'MiB', 'GiB', 'TiB']; let unit = 0;
    while (bytes >= 1024 && unit < units.length - 1) { bytes /= 1024; unit++; }
    return `${Number(bytes.toFixed(2))} ${units[unit]}`;
  }
  function GcMenuItem({ onDismiss, t }: LocalizedProps & { onDismiss(): void }): ElementNode {
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
    return h(ui.MenuItemButton, { disabled: !maintenanceReady(state.status), separatorBefore: true,
      // Phosphor Broom (MIT): its 16-unit outline renders at DSH's regular 1px weight at 16px.
      icon: h('svg', { width: 16, height: 16, viewBox: '0 0 256 256', fill: 'currentColor', 'aria-hidden': true, focusable: false },
        h('path', { d: 'M235.5 216.81c-22.56-11-35.5-34.58-35.5-64.8v-17.28a15.94 15.94 0 0 0-10.09-14.87L165 110a8 8 0 0 1-4.48-10.34l21.32-53a28 28 0 0 0-16.1-37a28.14 28.14 0 0 0-35.82 16a.6.6 0 0 0 0 .12L108.9 79a8 8 0 0 1-10.37 4.49L73.11 73.14a15.89 15.89 0 0 0-17.37 3.66C34.68 98.45 24 123.75 24 152a111.45 111.45 0 0 0 31.18 77.53A8 8 0 0 0 61 232h171a8 8 0 0 0 3.5-15.19M67.14 88l25.41 10.3a24 24 0 0 0 31.23-13.45l21-53c2.56-6.11 9.47-9.27 15.43-7a12 12 0 0 1 6.88 15.92l-21.4 52.99a24 24 0 0 0 13.43 31.14l24.88 9.83V153L55.77 101.71A109 109 0 0 1 67.14 88m48 128a87.53 87.53 0 0 1-24.34-42a8 8 0 0 0-15.49 4a105.2 105.2 0 0 0 18.36 38H64.44A95.54 95.54 0 0 1 40 152a85.9 85.9 0 0 1 7.73-36.29l137.8 55.12c3 18 10.56 33.48 21.89 45.16Z' })),
      onSelect: () => { onDismiss(); cleanupDialog = { kind: 'gc' }; publish(); }, children: h(React.Fragment, null, before, size, after) });
  }
  function RecordSettings({ t }: LocalizedProps): ElementNode {
    const { status } = useSnapshot();
    const { count } = status.receipt;
    return h('div', { style: { display: 'grid', gridTemplateColumns: 'minmax(0, 1fr) max-content', alignItems: 'center', gap: '0.5rem', padding: '12px 0' } },
      h('div', { style: { lineHeight: 1.5 } },
        h('div', { style: { fontSize: 13, fontWeight: 500, color: 'var(--dsw-alias-label-primary)' } },
          count ? t('records.count', { count }) : t('records.empty')),
        h('div', { style: { marginTop: 6, fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' } }, t('records.hint'))),
      h(ui.Button, { variant: 'outline', size: 'sm', disabled: !count || !maintenanceReady(status),
        onClick: () => { cleanupDialog = { kind: 'records' }; publish(); } }, t('records.clear')));
  }
  async function confirmCleanup(revision: string): Promise<void> {
    if (!cleanupDialog || !maintenanceReady(status)) return;
    const { kind } = cleanupDialog;
    cleanupDialog = { kind, busy: true }; toast = undefined; publish();
    try {
      if (kind === 'records') {
        const result = await api<{ cleared: number; receipt: DeletionStatus['receipt'] }>('clear-records', { confirmation: 'CLEAR_DELETION_RECORDS', revision });
        if (status.receipt.revision === revision || status.receipt.revision === result.receipt.revision) {
          status = { ...status, receipt: result.receipt };
          receipt = { revision: result.receipt.revision, deleted: new Set() };
        }
        if (result.cleared > 0) toast = { id: ++toastId, message: { key: 'records.success', params: { count: result.cleared } } };
      } else {
        const result = await api<GcResult>('gc', { confirmation: 'COLLECT_ORPHAN_ATTACHMENTS' });
        toast = { id: ++toastId, message: { key: 'gc.success', params: { count: result.total } } };
      }
      cleanupDialog = undefined;
    }
    catch (error) { cleanupDialog = { kind, error: asFailure(error) }; }
    finally { publish(); await poll(); }
  }
  function CleanupOverlay({ t }: LocalizedProps): ElementNode {
    const state = useSnapshot(); const d = state.cleanupDialog;
    const records = d?.kind === 'records';
    const busy = !!d?.busy || (!records && !!state.status.gcRunning);
    const className = records ? 'dsh-session-deletion-records' : 'dsh-session-deletion-gc';
    useDisabledClose('.' + className, !!d, busy);
    if (!d) return null;
    const dismiss = () => { if (!busy) { cleanupDialog = undefined; publish(); } };
    const { count, revision } = state.status.receipt;
    const description = records ? t(count ? 'records.description' : 'records.empty', { count }) : t('gc.description');
    return h(ui.Modal, {
      open: true, onClose: dismiss, closeLabel: t('common.close'), className: 'dsh-session-deletion-modal ' + className,
      title: t(records ? 'records.title' : 'gc.title'),
      description: h(React.Fragment, null, description, d.error ? errorContent(d.error, t) : null),
      footer: h(React.Fragment, null,
        h(ui.Button, { variant: 'outline', onClick: dismiss, disabled: busy }, t('common.cancel')),
        h(ui.Button, { variant: 'outline', onClick: () => { void confirmCleanup(revision); }, disabled: busy || !maintenanceReady(state.status) || (records && !count) },
          t(busy ? (records ? 'records.busy' : 'gc.busy') : 'gc.confirm'))),
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

  function Overlay({ t }: LocalizedProps): ElementNode {
    const state = useSnapshot(); const d = state.dialog;
    const busy = !!d?.busy || submitting || !!state.status.gcRunning || !!state.status.deletionRunning;
    useDisabledClose('.dsh-session-deletion-confirmation', !!d, busy);
    const gcBusy = !!state.status.gcRunning || (state.cleanupDialog?.kind === 'gc' && state.cleanupDialog.busy);
    const recovering = !gcBusy && state.status.pending.length > 0 && !submitting && state.status.deletionRunning === false;
    const noticeKey = gcBusy ? 'gc.busy'
      : recovering ? 'recovery.pending'
      : submitting || state.status.deletionRunning || state.status.locked.length ? 'delete.busy' : undefined;
    const notice = state.toast ? h(ui.Toast, {
      key: state.toast.id, text: t(state.toast.message.key, state.toast.message.params), tone: 'success',
      onDone: () => { if (toast === state.toast) { toast = undefined; publish(); } },
    }) : noticeKey ? h(StatusToast, { key: noticeKey, text: t(noticeKey), warning: recovering }) : null;
    if (!d) return h(React.Fragment, null, notice, null);
    const children = Math.max(0, (d.preview?.count ?? 1) - 1);
    const removalText = t(children > 0 ? 'delete.descriptionWithChildren' : 'delete.description', { count: children });
    const dismiss = () => { if (!busy) close(); };
    return h(React.Fragment, null, notice,
      h(ui.Modal, {
        open: true, onClose: dismiss, closeLabel: t('common.close'), className: 'dsh-session-deletion-modal dsh-session-deletion-confirmation',
        title: t('delete.title'),
        description: h(React.Fragment, null,
          h('strong', { style: { display: 'block', fontWeight: 600, overflowWrap: 'anywhere' } }, d.title?.trim() ? d.title : t('session.unnamed')),
          h('code', { style: { display: 'block', marginTop: 4, fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 12, color: 'var(--dsw-alias-label-secondary)', overflowWrap: 'anywhere' } }, d.id),
          d.preview ? h('span', { style: { display: 'block', marginTop: 12 } }, removalText)
            : d.busy ? h('span', { style: { display: 'block', marginTop: 12 } }, t('delete.checking')) : null,
          d.error ? errorContent(d.error, t) : null),
        footer: h(React.Fragment, null,
          h(ui.Button, { variant: 'outline', onClick: dismiss, disabled: busy }, t('common.cancel')),
          h(ui.Button, { variant: 'outline', className: 'dsh-session-deletion-danger', onClick: () => { void confirm(); }, disabled: busy || !d.preview || !maintenanceReady(state.status) }, t(submitting ? 'delete.submitting' : 'delete.confirm'))),
      }));
  }
  const t = ctx.locale.bind(namespace);
  ctx.effect(() => ctx.contextMenus.register({ id: 'session-deletion.action', target: 'session', order: 10000,
    observe: () => [stateSource, ctx.sessions.list, ctx.locale],
    resolve({ sessionId, displayTitle }) {
      const disabled = status.locked.includes(sessionId) || !maintenanceReady(status) || !globalThis.crypto?.subtle;
      return [{ id: 'delete', label: t('delete.menu'), disabled, danger: true, separatorBefore: true,
        afterContent: true, icon: { key: 'workspace.delete' }, run: () => { void open(sessionId, displayTitle); } }];
    } }), 'session-deletion menu');
  ctx.slots.inject('plugins.bundle.config', () => ctx.slots.register({ name: 'plugins.bundle.config', key: 'dsh-session-deletion', id: 'session-deletion.records', locale: namespace }, RecordSettings));
  ctx.slots.inject('sidebar.panellist.actions', () => ctx.slots.register({ name: 'sidebar.panellist.actions', id: 'session-deletion.gc', order: 10000, locale: namespace }, GcMenuItem));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'session-deletion.gc-dialog', order: 560, locale: namespace }, CleanupOverlay));
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({ name: 'shell.overlay', id: 'session-deletion.dialog', order: 550, locale: namespace }, Overlay));
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
    return () => { active = false; unsubscribe(); observer.disconnect(); for (const event of events) window.removeEventListener(event, prevent, true); protectInputs(); style.remove(); listeners.clear(); };
  }, 'session-deletion input protection');
  await refresh(initial);
  return refresh;
}
