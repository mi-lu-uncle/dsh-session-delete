// dsh-session-delete — client half.
//
// Adds a "删除会话" entry to the session row "..." menu (the
// `sidebar.workspaces.session.menu.item` list slot, after the shipped
// pin/rename/fork/archive actions) and a confirmation dialog (a `shell.overlay`
// entry). Confirming calls the host half's `/api/session-delete/delete` route;
// the host then deletes the persisted log + cache, drops the workspace
// accounting, and emits `api-session/removed` so the row disappears live.
window.__ModuleLoader__.load({
  id: "@mi-lu-uncle/dsh-session-delete",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let react = require("react");
    let primitives = require("@deepseek-ai/dsh-client-ui-primitives");
    let MenuItemButton = primitives.MenuItemButton;
    let Modal = primitives.Modal;
    let Button = primitives.Button;
    let IconTrashOutlineRegular = primitives.IconTrashOutlineRegular;

    // ── locale ──────────────────────────────────────────────────────────
    const NS = "sessionDelete";
    const en = {
      "menu.deleteSession": "Delete session…",
      "dialog.title": "Delete session",
      "dialog.desc": "Permanently delete “{title}”? This cannot be undone.",
      "dialog.cancel": "Cancel",
      "dialog.confirm": "Delete",
      "dialog.deleting": "Deleting…",
      "dialog.error": "Delete failed: ",
    };
    const zh = {
      "menu.deleteSession": "删除会话",
      "dialog.title": "删除会话",
      "dialog.desc": "确定要永久删除「{title}」吗？此操作无法撤销。",
      "dialog.cancel": "取消",
      "dialog.confirm": "删除",
      "dialog.deleting": "正在删除…",
      "dialog.error": "删除失败：",
    };

    // A minimal useSyncExternalStore-compatible snapshot store.
    function createStore(initial) {
      let value = initial;
      const listeners = new Set();
      return {
        getSnapshot: () => value,
        subscribe: (listener) => {
          listeners.add(listener);
          return () => listeners.delete(listener);
        },
        set: (next) => {
          value = next;
          for (const listener of [...listeners]) listener();
        },
      };
    }

    const inject = ["slots", "locale"];

    function apply(ctx) {
      ctx.effect(() => ctx.locale.register(NS, { zh, en }), "session-delete: dictionaries");
      const t = ctx.locale.bind(NS);

      // One shared "request" store: the menu item opens the dialog by setting
      // it; the overlay reads it and clears it on settle/cancel.
      const deleteRequest = createStore(null);

      // Menu item inject: a `requestDelete(sessionId, displayTitle)` behavior.
      const deleteInjected = () => ({
        requestDelete: (sessionId, displayTitle) => {
          deleteRequest.set({ sessionId, displayTitle });
        },
      });

      // Overlay inject: the dialog's request hook, settle, and the host call.
      const dialogInjected = () => ({
        hooks: { deleteRequest },
        settleDelete: () => deleteRequest.set(null),
        confirmDelete: async (sessionId) => {
          const res = await fetch("/api/session-delete/delete", {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ sessionId }),
          });
          const data = await res.json().catch(() => ({ ok: false, error: String(res.status) }));
          if (!data.ok) throw new Error(data.error || "删除失败");
          return data;
        },
      });

      // Danger styling for the confirm button (the primitive has no danger variant).
      ctx.effect(() => {
        const style = document.createElement("style");
        style.setAttribute("data-session-delete", "");
        style.textContent = ".session-delete-danger{color:var(--dsw-alias-state-error, #d93025)!important;border-color:var(--dsw-alias-state-error, #d93025)!important}";
        document.head.appendChild(style);
        return () => style.remove();
      }, "session-delete: stylesheet");

      const disposers = [];

      // Session row "..." menu → the delete action.
      disposers.push(
        ctx.slots.inject("sidebar.workspaces.session.menu.item", () =>
          ctx.slots.register(
            {
              name: "sidebar.workspaces.session.menu.item",
              id: "delete-session",
              order: 500,
              locale: NS,
              inject: deleteInjected,
            },
            DeleteSessionMenuItem
          )
        )
      );

      // Confirmation dialog overlay.
      disposers.push(
        ctx.slots.inject("shell.overlay", () =>
          ctx.slots.register(
            {
              name: "shell.overlay",
              id: "session-delete.confirm",
              locale: NS,
              inject: dialogInjected,
            },
            DeleteSessionConfirmDialog
          )
        )
      );

      ctx.effect(
        () => () => {
          for (const dispose of disposers) if (typeof dispose === "function") dispose();
        },
        "session-delete: entry lifecycle"
      );
    }

    /** The menu row: open the confirm dialog, then close the menu. */
    function DeleteSessionMenuItem({ sessionId, displayTitle, useMenuOpenState, requestDelete, t }) {
      const [, setMenuOpen] = useMenuOpenState();
      return react.createElement(MenuItemButton, {
        separatorBefore: true,
        icon: react.createElement(IconTrashOutlineRegular, { size: 14 }),
        onSelect: () => {
          setMenuOpen(false);
          requestDelete(sessionId, displayTitle);
        },
        children: t("menu.deleteSession"),
      });
    }

    /** The overlay: render nothing until a delete is requested. */
    function DeleteSessionConfirmDialog({ useDeleteRequest, settleDelete, confirmDelete, t }) {
      const request = useDeleteRequest((pending) => pending);
      if (request === null) return null;
      return react.createElement(DeleteConfirmForm, {
        request,
        confirmDelete,
        onSettle: settleDelete,
        t,
      });
    }

    /** One request's dialog: in-flight and error state die with it. */
    function DeleteConfirmForm({ request, confirmDelete, onSettle, t }) {
      const [deleting, setDeleting] = react.useState(false);
      const [error, setError] = react.useState(null);
      const close = () => {
        if (deleting) return;
        onSettle();
      };
      const confirm = () => {
        setDeleting(true);
        setError(null);
        confirmDelete(request.sessionId)
          .then(() => {
            setDeleting(false);
            onSettle();
          })
          .catch((reason) => {
            setDeleting(false);
            setError(reason instanceof Error ? reason.message : String(reason));
          });
      };
      const title = request.displayTitle || request.sessionId;
      return react.createElement(
        Modal,
        {
          open: true,
          onClose: close,
          title: t("dialog.title"),
          description: t("dialog.desc", { title }),
          footer: react.createElement(
            react.Fragment,
            null,
            react.createElement(Button, {
              variant: "outline",
              disabled: deleting,
              onClick: close,
              children: t("dialog.cancel"),
            }),
            react.createElement(Button, {
              variant: "outline",
              className: "session-delete-danger",
              disabled: deleting,
              onClick: confirm,
              children: t("dialog.confirm"),
            })
          ),
        },
        deleting
          ? react.createElement("div", { role: "status", children: t("dialog.deleting") })
          : null,
        error !== null
          ? react.createElement("div", { role: "alert", children: t("dialog.error") + error })
          : null
      );
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  },
});
