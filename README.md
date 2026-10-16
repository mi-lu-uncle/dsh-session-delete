# @mi-lu-uncle/dsh-session-delete

English | [简体中文](README.zh-CN.md) | [日本語](README.ja.md)

Adds a **Delete session** action to the session "…" menu of DeepSeek Harness (DSH).

DSH `0.2.0-rc.2` only ships **archive** (a soft delete: hidden, but all data is kept). This plugin fills the gap — one click **permanently deletes** a session together with its on-disk data.

## Features

- In the session row's "…" menu, right after the built-in Pin / Rename / Fork / Archive, a new **Delete session** entry appears.
- Clicking it opens a confirmation dialog (showing the session title); confirming invokes the host-side delete.
- Deleting cleans up three data locations:
  1. The session itself: `~/.dsh/sessions/<workspace>/<session-id>/`
  2. The projection cache: `~/.dsh/storages/session_projcache/sessions/<session-id>.json`
  3. The session's registration in the workspace index (`sessionIds` / archive / pin marks)
- After a successful delete, the open UI **needs no refresh** — the row disappears via the `api-session/removed` event.
- **Auto-repairs the default workspace**: DSH's built-in "Delete workspace", if it ever deleted the default one, leaves dangling pointers — its sessions fall into "Ungrouped" and new sessions can no longer be created. On startup this plugin rebuilds the registration and re-homes the sessions **for the default workspace only** (identified via `defaultWorkspaceId` or the last remembered path). Other workspaces you deleted on purpose are not "revived".

## Safety

- **Running sessions refuse deletion**: it uses the same `workspace/session-activity` detection as DSH's archive. Only genuinely running work (an in-flight conversation turn, background jobs, …) is blocked with "this session is running"; idle old sessions (even if still kept alive in DSH's memory) delete normally.
- Deletion goes through DSH's own workspace-registry write paths (`detachSession` / `unarchiveSession` / `unpinSession`), so persisted state stays consistent.
- Routes are same-origin fenced; only requests coming from the DSH UI itself are accepted.

## Install

This plugin targets DSH `0.2.0-rc.2` and is linked into the `desktop` profile as a local directory:

```sh
dsh plugin --profile desktop add "link:/absolute/path/dsh-session-delete"
```

Then **restart DSH** for it to take effect.

You can also edit `~/.dsh/profiles/desktop/package.json` manually:

```jsonc
{
  "dependencies": {
    "@mi-lu-uncle/dsh-session-delete": "link:/absolute/path/dsh-session-delete"
  },
  "dsh": {
    "profile": {
      "bundles": [
        // ... existing ...
        "@mi-lu-uncle/dsh-session-delete"
      ]
    }
  }
}
```

Then run `pnpm install` in the profile directory and restart DSH.

## Usage

1. In the session list on the left, hover a session and click its "…".
2. Choose **Delete session**.
3. Click **Delete** in the confirmation dialog.

> ⚠️ Deletion is **permanent and irreversible**. Make sure the session really is no longer needed.

## Limitations / notes

- This is a community plugin built on DSH's public extension points (the session-menu slot `sidebar.workspaces.session.menu.item` plus host-side file/registry cleanup). If a future DSH release ships an official "delete session" API, prefer that.
- Running sessions refuse deletion; if you really need one gone, stop it first (finish/archive its work) and then delete.
- The full-text search index is a rebuildable read model of DSH's; right after a delete there may be briefly stale results until the next rebuild.

## License

MIT
