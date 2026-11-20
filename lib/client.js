"use strict";
(() => {
  // src/locale/shared.ts
  function message(key, params) {
    return params === void 0 ? { key } : { key, params };
  }
  function isDictionary(value) {
    return value !== null && typeof value === "object" && !Array.isArray(value) && Object.values(value).every((entry) => typeof entry === "string");
  }
  function catalogUrl(id) {
    return `api/${id}/locales`;
  }

  // src/locale/client.ts
  async function registerClientLocale(ctx, namespace, id = namespace) {
    const response = await fetch(catalogUrl(id), { cache: "no-store", redirect: "error" });
    if (ctx.fiber.uid === null) return;
    if (!response.ok) throw Object.assign(new Error(`Locale catalogs: HTTP ${response.status}`), {
      messages: [message("error.localeHttp", { status: String(response.status) })]
    });
    const data = await response.json();
    if (ctx.fiber.uid === null) return;
    const catalogs = data?.dictionaries;
    if (data?.ok !== true || !catalogs || !isDictionary(catalogs.en)) {
      throw Object.assign(new Error("Invalid locale catalogs."), { messages: [message("error.invalidLocaleDictionaries")] });
    }
    const dictionaries = Object.fromEntries(Object.entries(catalogs).filter((entry) => isDictionary(entry[1])));
    ctx.effect(() => ctx.locale.register(namespace, dictionaries), "locale dictionaries");
  }
  var ApiError = class extends Error {
    constructor(failure, status) {
      super(failure.error);
      this.status = status;
      this.failure = failure;
    }
    status;
    failure;
  };
  function asFailure(error) {
    return error instanceof ApiError ? error.failure : { error: error instanceof Error ? error.message : String(error) };
  }
  async function readFailure(response) {
    const text = await response.text();
    const status = `HTTP ${response.status}`;
    if (response.headers.get("content-type")?.includes("application/json")) {
      try {
        const failure = JSON.parse(text);
        if (typeof failure?.error === "string") return { ...failure, error: failure.error };
        if (failure && typeof failure === "object") {
          return { error: status, messages: failure.messages ?? [message("error.httpStatus", { status: response.status })], diagnostic: failure.diagnostic };
        }
      } catch {
      }
    }
    return text ? { error: text } : { error: status, messages: [message("error.httpStatus", { status: response.status })] };
  }
  function withCode(React, template, params) {
    if (!params) return template;
    return template.split(/(\{\w+\})/g).map((part, index) => {
      const name = part.slice(1, -1);
      return part.startsWith("{") && Object.hasOwn(params, name) ? React.createElement("code", { key: index, style: { overflowWrap: "anywhere" } }, String(params[name])) : part;
    });
  }
  function renderFailure(React, t, failure) {
    const h = React.createElement;
    const explanations = [];
    for (const item of failure.messages ?? []) {
      const template = t(item.key);
      if (!template.trim() || template === item.key) continue;
      explanations.push(h(
        React.Fragment,
        { key: explanations.length },
        explanations.length ? t("error.separator") : null,
        withCode(React, template, item.params)
      ));
    }
    const raw = failure.diagnostic ?? (explanations.length ? void 0 : failure.error);
    return h(
      React.Fragment,
      null,
      explanations.length ? explanations : t("error.unknown"),
      raw ? h("code", { style: {
        display: "block",
        marginTop: 4,
        fontFamily: "var(--ds-font-family-code, monospace)",
        fontSize: 12,
        color: "var(--dsw-alias-label-secondary)",
        overflowWrap: "anywhere",
        whiteSpace: "pre-wrap"
      } }, raw) : null
    );
  }

  // src/client.ts
  async function api(path, data) {
    const response = await fetch("/session-deletion/api/" + path, {
      credentials: "same-origin",
      cache: "no-store",
      method: data ? "POST" : "GET",
      headers: data ? { "Content-Type": "application/json", "X-DSH-Session-Deletion": "1" } : {},
      ...data ? { body: JSON.stringify(data) } : {}
    });
    if (!response.ok) throw new ApiError(await readFailure(response), response.status);
    return await response.json();
  }
  window.__ModuleLoader__.load({ id: "dsh-session-deletion", factory: (require2) => ({
    inject: ["slots", "sessions", "uiWorkspace", "contextMenus", "locale"],
    async apply(ctx) {
      let scope;
      let refresh;
      let active = true, polling = false;
      async function poll() {
        if (!active || polling) return;
        polling = true;
        try {
          if (refresh) {
            await refresh();
            return;
          }
          const status = await api("status");
          if (!active || !status.ok || ctx.fiber.uid === null) return;
          scope = ctx.plugin(async (child) => {
            refresh = await mountClient(child, require2, poll, status);
          });
          await scope;
        } catch (error) {
          if (!refresh || error instanceof ApiError && error.status === 404) {
            refresh = void 0;
            await scope?.dispose();
            scope = void 0;
          }
        } finally {
          polling = false;
        }
      }
      ctx.effect(() => {
        const timer = setInterval(() => {
          void poll();
        }, 1e3);
        return () => {
          active = false;
          clearInterval(timer);
        };
      }, "session-deletion status");
      await poll();
    }
  }) });
  async function mountClient(ctx, require2, poll, initial) {
    const namespace = "session-deletion";
    await registerClientLocale(ctx, namespace);
    if (ctx.fiber.uid === null) return;
    const React = require2("react");
    const h = React.createElement;
    function errorContent(error, t2) {
      return h("span", { role: "alert", style: {
        display: "block",
        color: "var(--dsw-alias-state-error-primary)",
        marginTop: 8,
        fontSize: 12,
        overflowWrap: "anywhere"
      } }, renderFailure(React, t2, error));
    }
    const ui = require2("@deepseek-ai/dsh-client-ui-primitives");
    const pluginUiSelector = ".dsh-session-deletion-modal";
    const listeners = /* @__PURE__ */ new Set();
    let dialog;
    let gcDialog;
    let status = initial;
    let receipt;
    let toast;
    let toastId = 0;
    let active = true;
    let submitting = false;
    let lastMainId;
    const inputStates = /* @__PURE__ */ new Map();
    function maintenanceReady(state) {
      return state.ok && !state.gcRunning && !state.deletionRunning && !state.pending.length;
    }
    function affected() {
      if (!active) return false;
      if (gcDialog?.busy || status.gcRunning) return true;
      if (submitting && dialog?.id === lastMainId) return true;
      if (!status.deletionRunning) return false;
      if (lastMainId && status.locked.includes(lastMainId)) return true;
      const rows = Object.values(ctx.sessions.list.getSnapshot().byId);
      return rows.some((row) => status.locked.includes(row.id) && Object.values(row.retainedBy).some((n) => n > 0));
    }
    function protectInputs() {
      if (!affected()) {
        for (const [element, original] of inputStates) {
          element.inert = original.inert;
          if (original.aria === null) element.removeAttribute("aria-disabled");
          else element.setAttribute("aria-disabled", original.aria);
          element.classList.remove("dsh-deletion-input-locked");
        }
        inputStates.clear();
        return;
      }
      for (const element of document.querySelectorAll('input, textarea, button, select, [contenteditable="true"]')) {
        if (element.closest(pluginUiSelector)) continue;
        if (!inputStates.has(element)) inputStates.set(element, { inert: element.inert, aria: element.getAttribute("aria-disabled") });
        element.inert = true;
        element.setAttribute("aria-disabled", "true");
        element.classList.add("dsh-deletion-input-locked");
      }
    }
    let generation = 0;
    let snapshot = { dialog, status, gcDialog, toast };
    const publish = () => {
      snapshot = { dialog, status, gcDialog, toast };
      for (const listener of listeners) listener();
      protectInputs();
    };
    const stateSource = { getSnapshot: () => snapshot, subscribe: (callback) => {
      listeners.add(callback);
      return () => {
        listeners.delete(callback);
      };
    } };
    const useSnapshot = () => React.useSyncExternalStore(stateSource.subscribe, stateSource.getSnapshot);
    async function hash(value) {
      const bytes = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value));
      return [...new Uint8Array(bytes)].map((v) => v.toString(16).padStart(2, "0")).join("");
    }
    async function cleanBrowserState(hashes) {
      if (!hashes.length) return;
      const deleted = new Set(hashes);
      const matches = async (value) => deleted.has(await hash(value));
      for (const storage of [localStorage, sessionStorage]) {
        for (const key of Object.keys(storage)) {
          const prefix = ["dsh.conversation.", "dsh.sidebar-right.v1.", "dsh.schedule.task-tab.v1."].find((p) => key.startsWith(p));
          if (!prefix && key !== "dsh.sessions.current" && key !== "dsh.workspace.view.v5") continue;
          const original = storage.getItem(key);
          if (original === null) continue;
          if (prefix) {
            if (await matches(key.slice(prefix.length)) && storage.getItem(key) === original) storage.removeItem(key);
            continue;
          }
          try {
            const parsed = JSON.parse(original);
            if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) continue;
            const data = parsed;
            if (key === "dsh.sessions.current") {
              if (typeof data.sessionId === "string" && await matches(data.sessionId) && storage.getItem(key) === original) storage.removeItem(key);
              continue;
            }
            const orders = data.sessionOrderByAccount;
            if (!orders || typeof orders !== "object" || Array.isArray(orders)) continue;
            let changed = false;
            for (const [account, order] of Object.entries(orders)) {
              if (!Array.isArray(order)) continue;
              const kept = [];
              for (const id of order) {
                if (typeof id === "string" && await matches(id)) changed = true;
                else kept.push(id);
              }
              orders[account] = kept;
            }
            if (changed && storage.getItem(key) === original) storage.setItem(key, JSON.stringify(data));
          } catch {
          }
        }
      }
    }
    async function refresh(initial2) {
      if (!active) return;
      const own = generation, wasSubmitting = submitting;
      const failed = dialog?.error && !submitting && !dialog.preview && !status.pending.length ? dialog : void 0;
      if (failed) {
        try {
          const preview = await api("preview", { sessionId: failed.id });
          if (own === generation && dialog === failed) dialog = { ...failed, preview };
        } catch {
        }
      }
      try {
        status = initial2 ?? await api("status");
      } catch (error) {
        if (status.ok) {
          status = { ...status, ok: false };
          publish();
        }
        throw error;
      }
      if (!active) return;
      if (own === generation && !wasSubmitting && !submitting && dialog?.busy && dialog.error && status.deletionRunning === false && (dialog.preview || status.pending.length)) dialog = { ...dialog, busy: false };
      publish();
      try {
        if (!receipt || receipt.revision !== status.receipt.revision) receipt = await api("receipt");
        if (!active) return;
        await cleanBrowserState(receipt.deletedIdHashes);
        const current = dialog;
        if (current?.error && !submitting && receipt.deletedIdHashes.includes(await hash(current.id)) && dialog === current && !submitting) completeDeletion(current.title);
        if (lastMainId && receipt.deletedIdHashes.includes(await hash(lastMainId)) && active) {
          lastMainId = void 0;
          ctx.uiWorkspace.startSession();
        }
      } catch {
      }
    }
    async function open(id, title) {
      const own = ++generation;
      dialog = { id, title, busy: true };
      publish();
      try {
        const preview = await api("preview", { sessionId: id });
        if (own === generation) {
          dialog = { id, title, preview };
          publish();
        }
      } catch (e) {
        if (own === generation) {
          dialog = { id, title, error: asFailure(e) };
          publish();
        }
      }
    }
    function close() {
      generation++;
      dialog = void 0;
      publish();
    }
    function completeDeletion(title) {
      toast = { id: ++toastId, message: title ? { key: "delete.success", params: { title } } : { key: "delete.successUnnamed" } };
      close();
    }
    async function confirm() {
      if (!dialog?.preview || dialog.busy || submitting || !maintenanceReady(status)) return;
      const current = dialog;
      generation++;
      submitting = true;
      toast = void 0;
      dialog = { ...current, busy: true, error: void 0 };
      publish();
      try {
        await api("delete", { sessionId: current.id, token: current.preview.token, confirmation: "DELETE_SESSION" });
        submitting = false;
        completeDeletion(current.title);
      } catch (e) {
        submitting = false;
        dialog = { ...current, preview: void 0, busy: true, error: asFailure(e) };
        publish();
      } finally {
        await poll();
        protectInputs();
      }
    }
    function useDisabledClose(selector, open2, busy) {
      React.useLayoutEffect(() => {
        const closeButton = document.querySelector(selector + " button[aria-label]");
        if (closeButton) closeButton.disabled = busy;
      }, [selector, open2, busy]);
    }
    function formatBytes(bytes) {
      const units = ["B", "KiB", "MiB", "GiB", "TiB"];
      let unit = 0;
      while (bytes >= 1024 && unit < units.length - 1) {
        bytes /= 1024;
        unit++;
      }
      return `${Number(bytes.toFixed(2))} ${units[unit]}`;
    }
    function GcMenuItem({ onDismiss, t: t2 }) {
      const state = useSnapshot();
      const [bytes, setBytes] = React.useState();
      React.useEffect(() => {
        let active2 = true;
        void api("gc-size").then((result) => {
          if (active2) setBytes(Number.isFinite(result.bytes) && result.bytes >= 0 ? result.bytes : null);
        }).catch(() => {
          if (active2) setBytes(null);
        });
        return () => {
          active2 = false;
        };
      }, []);
      const size = bytes === void 0 ? h("span", { role: "status", "aria-label": t2("gc.calculating"), style: { display: "inline-flex", verticalAlign: "middle" } }, h(ui.StateDot, { state: "ongoing", size: 12 })) : bytes === null ? t2("gc.sizeUnavailable") : formatBytes(bytes);
      const [before, after] = t2("gc.menu", { size: "{size}" }).split("{size}");
      return h(ui.MenuItemButton, {
        disabled: !maintenanceReady(state.status),
        separatorBefore: true,
        // Phosphor Broom (MIT): its 16-unit outline renders at DSH's regular 1px weight at 16px.
        icon: h(
          "svg",
          { width: 16, height: 16, viewBox: "0 0 256 256", fill: "currentColor", "aria-hidden": true, focusable: false },
          h("path", { d: "M235.5 216.81c-22.56-11-35.5-34.58-35.5-64.8v-17.28a15.94 15.94 0 0 0-10.09-14.87L165 110a8 8 0 0 1-4.48-10.34l21.32-53a28 28 0 0 0-16.1-37a28.14 28.14 0 0 0-35.82 16a.6.6 0 0 0 0 .12L108.9 79a8 8 0 0 1-10.37 4.49L73.11 73.14a15.89 15.89 0 0 0-17.37 3.66C34.68 98.45 24 123.75 24 152a111.45 111.45 0 0 0 31.18 77.53A8 8 0 0 0 61 232h171a8 8 0 0 0 3.5-15.19M67.14 88l25.41 10.3a24 24 0 0 0 31.23-13.45l21-53c2.56-6.11 9.47-9.27 15.43-7a12 12 0 0 1 6.88 15.92l-21.4 52.99a24 24 0 0 0 13.43 31.14l24.88 9.83V153L55.77 101.71A109 109 0 0 1 67.14 88m48 128a87.53 87.53 0 0 1-24.34-42a8 8 0 0 0-15.49 4a105.2 105.2 0 0 0 18.36 38H64.44A95.54 95.54 0 0 1 40 152a85.9 85.9 0 0 1 7.73-36.29l137.8 55.12c3 18 10.56 33.48 21.89 45.16Z" })
        ),
        onSelect: () => {
          onDismiss();
          gcDialog = {};
          publish();
        },
        children: h(React.Fragment, null, before, size, after)
      });
    }
    async function collect() {
      if (gcDialog?.busy || !maintenanceReady(status)) return;
      gcDialog = { busy: true };
      toast = void 0;
      publish();
      try {
        const result = await api("gc", { confirmation: "COLLECT_ORPHAN_ATTACHMENTS" });
        gcDialog = void 0;
        toast = { id: ++toastId, message: { key: "gc.success", params: { count: result.total } } };
      } catch (error) {
        gcDialog = { error: asFailure(error) };
      } finally {
        publish();
        await poll();
      }
    }
    function GcOverlay({ t: t2 }) {
      const state = useSnapshot();
      const d = state.gcDialog;
      const busy = !!d?.busy || !!state.status.gcRunning;
      useDisabledClose(".dsh-session-deletion-gc", !!d, busy);
      if (!d) return null;
      const dismiss = () => {
        if (!busy) {
          gcDialog = void 0;
          publish();
        }
      };
      return h(ui.Modal, {
        open: true,
        onClose: dismiss,
        closeLabel: t2("common.close"),
        className: "dsh-session-deletion-modal dsh-session-deletion-gc",
        title: t2("gc.title"),
        description: h(React.Fragment, null, t2("gc.description"), d.error ? errorContent(d.error, t2) : null),
        footer: h(
          React.Fragment,
          null,
          h(ui.Button, { variant: "outline", onClick: dismiss, disabled: busy }, t2("common.cancel")),
          h(ui.Button, { variant: "outline", onClick: () => {
            void collect();
          }, disabled: busy || !maintenanceReady(state.status) }, t2(busy ? "gc.busy" : "gc.confirm"))
        )
      });
    }
    function StatusToast({ text, warning }) {
      const [dismissed, setDismissed] = React.useState(false);
      return dismissed ? null : h(ui.Toast, {
        text,
        onDone: () => {
          setDismissed(true);
        },
        ...warning ? { icon: h(ui.IconWarningOutlineRegular, {}), holdMs: 8e3 } : {}
      });
    }
    function Overlay({ t: t2 }) {
      const state = useSnapshot();
      const d = state.dialog;
      const busy = !!d?.busy || submitting || !!state.status.gcRunning || !!state.status.deletionRunning;
      useDisabledClose(".dsh-session-deletion-confirmation", !!d, busy);
      const gcBusy = !!state.status.gcRunning || !!state.gcDialog?.busy;
      const recovering = !gcBusy && state.status.pending.length > 0 && !submitting && state.status.deletionRunning === false;
      const noticeKey = gcBusy ? "gc.busy" : recovering ? "recovery.pending" : submitting || state.status.deletionRunning || state.status.locked.length ? "delete.busy" : void 0;
      const notice = state.toast ? h(ui.Toast, {
        key: state.toast.id,
        text: t2(state.toast.message.key, state.toast.message.params),
        tone: "success",
        onDone: () => {
          if (toast === state.toast) {
            toast = void 0;
            publish();
          }
        }
      }) : noticeKey ? h(StatusToast, { key: noticeKey, text: t2(noticeKey), warning: recovering }) : null;
      if (!d) return h(React.Fragment, null, notice, null);
      const children = Math.max(0, (d.preview?.count ?? 1) - 1);
      const removalText = t2(children > 0 ? "delete.descriptionWithChildren" : "delete.description", { count: children });
      const dismiss = () => {
        if (!busy) close();
      };
      return h(
        React.Fragment,
        null,
        notice,
        h(ui.Modal, {
          open: true,
          onClose: dismiss,
          closeLabel: t2("common.close"),
          className: "dsh-session-deletion-modal dsh-session-deletion-confirmation",
          title: t2("delete.title"),
          description: h(
            React.Fragment,
            null,
            h("strong", { style: { display: "block", fontWeight: 600, overflowWrap: "anywhere" } }, d.title?.trim() ? d.title : t2("session.unnamed")),
            h("code", { style: { display: "block", marginTop: 4, fontFamily: "var(--ds-font-family-code, monospace)", fontSize: 12, color: "var(--dsw-alias-label-secondary)", overflowWrap: "anywhere" } }, d.id),
            d.preview ? h("span", { style: { display: "block", marginTop: 12 } }, removalText) : d.busy ? h("span", { style: { display: "block", marginTop: 12 } }, t2("delete.checking")) : null,
            d.error ? errorContent(d.error, t2) : null
          ),
          footer: h(
            React.Fragment,
            null,
            h(ui.Button, { variant: "outline", onClick: dismiss, disabled: busy }, t2("common.cancel")),
            h(ui.Button, { variant: "outline", className: "dsh-session-deletion-danger", onClick: () => {
              void confirm();
            }, disabled: busy || !d.preview || !maintenanceReady(state.status) }, t2(submitting ? "delete.submitting" : "delete.confirm"))
          )
        })
      );
    }
    const t = ctx.locale.bind(namespace);
    ctx.effect(() => ctx.contextMenus.register({
      id: "session-deletion.action",
      target: "session",
      order: 1e4,
      observe: () => [stateSource, ctx.sessions.list, ctx.locale],
      resolve({ sessionId, displayTitle }) {
        const disabled = status.locked.includes(sessionId) || !maintenanceReady(status) || !globalThis.crypto?.subtle;
        return [{
          id: "delete",
          label: t("delete.menu"),
          disabled,
          danger: true,
          separatorBefore: true,
          afterContent: true,
          icon: { key: "workspace.delete" },
          run: () => {
            void open(sessionId, displayTitle);
          }
        }];
      }
    }), "session-deletion menu");
    ctx.slots.inject("sidebar.panellist.actions", () => ctx.slots.register({ name: "sidebar.panellist.actions", id: "session-deletion.gc", order: 1e4, locale: namespace }, GcMenuItem));
    ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "session-deletion.gc-dialog", order: 560, locale: namespace }, GcOverlay));
    ctx.slots.inject("shell.overlay", () => ctx.slots.register({ name: "shell.overlay", id: "session-deletion.dialog", order: 550, locale: namespace }, Overlay));
    ctx.effect(() => {
      const watchSelection = () => {
        const current = Object.values(ctx.sessions.list.getSnapshot().byId).find((row) => (row.retainedBy.mainView || 0) > 0);
        if (current) lastMainId = current.id;
        publish();
      };
      const unsubscribe = ctx.sessions.list.subscribe(watchSelection);
      watchSelection();
      const observer = new MutationObserver(protectInputs);
      observer.observe(document.body, { childList: true, subtree: true });
      const prevent = (event) => {
        if (affected() && !(event.target instanceof Element && event.target.closest(pluginUiSelector))) {
          event.preventDefault();
          event.stopImmediatePropagation();
        }
      };
      const events = ["click", "submit", "keydown", "beforeinput", "paste", "drop"];
      for (const event of events) window.addEventListener(event, prevent, true);
      const style = document.createElement("style");
      style.textContent = ".dsh-deletion-input-locked{opacity:.45!important;pointer-events:none!important}.dsh-session-deletion-danger:not(:disabled){color:var(--dsw-alias-state-error-primary)}.dsh-session-deletion-confirmation .dsh-session-deletion-danger:hover:not(:disabled){background:var(--dsw-alias-interactive-bg-hover-danger)}.dsh-session-deletion-modal button[aria-label]:disabled{opacity:.4;pointer-events:none}";
      document.head.append(style);
      return () => {
        active = false;
        unsubscribe();
        observer.disconnect();
        for (const event of events) window.removeEventListener(event, prevent, true);
        protectInputs();
        style.remove();
        listeners.clear();
      };
    }, "session-deletion input protection");
    await refresh(initial);
    return refresh;
  }
})();
