/**
 * DSH session delete — host half.
 *
 * DSH 0.2.0-rc.2 ships no "delete session" surface: the session menu only has
 * pin / rename / fork / archive, and neither the client `session` remote
 * namespace nor the workspace registry exposes a delete. Archiving hides a
 * session but keeps every byte on disk.
 *
 * This host half closes that gap with one same-origin route the client half
 * calls from the new "删除会话" menu item:
 *
 *   POST /api/session-delete/delete   { sessionId }
 *
 * A delete does four things, in order, so the durable state stays consistent:
 *   1. Refuses the delete while the session has work in flight — the same
 *      `workspace/session-activity` admission the archive path uses (running
 *      turns, background jobs, …). An idle session deletes fine even if its
 *      agent is still warm in memory.
 *   2. Detaches the session from its workspace and clears any archive/pin mark
 *      through the workspace registry (the same durable write path DSH uses).
 *   3. Removes the persisted log under <dshHome>/sessions/<workspace>/<session-id>/
 *      and its projection cache under <dshHome>/storages/session_projcache/.
 *   4. Emits `api-session/removed` so the open client drops the row live.
 */
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';

/** Cordis plugin identity. */
export const name = 'session-delete';

/** Only the web server is a hard dependency; the workspace registry is taken as an optional dependency at repair time so a future rename degrades gracefully instead of blocking the plugin load. */
export const inject = ['webServer'];

/** Default DSH state root; overridable via `config.dshHome` (also for tests). */
const DEFAULT_DSH_HOME = () => join(homedir(), '.dsh');

const SESSIONS_DIR = (base) => join(base, 'sessions');
const PROJECTION_CACHE_DIR = (base) => join(base, 'storages', 'session_projcache', 'sessions');

/** `session-<uuid>` — the durable identity DSH mints for every conversation. */
const SESSION_ID = /^session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Find the persisted log directory for a session across every workspace. */
function findSessionDir(sessionId, base = DEFAULT_DSH_HOME()) {
  let workspaces;
  try {
    workspaces = readdirSync(SESSIONS_DIR(base));
  } catch {
    return null;
  }
  for (const ws of workspaces) {
    const dir = join(SESSIONS_DIR(base), ws, sessionId);
    if (existsSync(dir)) return dir;
  }
  return null;
}

/** Every `session-<uuid>` directory id currently persisted on disk. */
function listSessionIdsOnDisk(base = DEFAULT_DSH_HOME()) {
  const ids = [];
  let workspaces;
  try {
    workspaces = readdirSync(SESSIONS_DIR(base));
  } catch {
    return ids;
  }
  for (const ws of workspaces) {
    let entries;
    try {
      entries = readdirSync(join(SESSIONS_DIR(base), ws));
    } catch {
      continue;
    }
    for (const entry of entries) {
      if (SESSION_ID.test(entry) && existsSync(join(SESSIONS_DIR(base), ws, entry))) ids.push(entry);
    }
  }
  return ids;
}

/** Plugin state file: remembers the default workspace path across restarts. */
function pluginStatePath(base) {
  return join(base, 'plugins', 'session-delete', 'state.json');
}

/** Read the persisted default workspace path, if any. */
function readPersistedDefaultPath(base) {
  try {
    const parsed = JSON.parse(readFileSync(pluginStatePath(base), 'utf8'));
    const path = parsed?.defaultWorkspacePath;
    return typeof path === 'string' && path !== '' ? path : undefined;
  } catch {
    return undefined;
  }
}

/** Persist the default workspace path for future runs. */
function writePersistedDefaultPath(base, path) {
  try {
    mkdirSync(dirname(pluginStatePath(base)), { recursive: true });
    writeFileSync(pluginStatePath(base), JSON.stringify({ defaultWorkspacePath: path }, null, 2));
  } catch (error) {
    console.error('[session-delete] failed to persist default workspace path:', error);
  }
}

/**
 * Rebuild the DEFAULT workspace registration only when it was lost. DSH's own
 * `delete` removes a workspace's row and order entry but leaves its sessions
 * (and, for the default workspace, a dangling `defaultWorkspaceId` pointer), so
 * the directory's sessions fall into the "未分组" bucket and the directory can
 * no longer take new sessions.
 *
 * Deliberately-deleted non-default workspaces are left alone: this repair
 * targets the default workspace only, identified by `defaultWorkspaceId` (live)
 * or the path persisted from a previous healthy run. DSH 0.2.1-rc.2 has no
 * public API to reset a dangling defaultWorkspaceId, so this is only a partial
 * recovery. Idempotent; never touches DSH's program files or session logs.
 */
async function repairDefaultWorkspace(ctx, base = DEFAULT_DSH_HOME()) {
  const registry = ctx.get?.('workspaceRegistry');
  if (!registry) return;

  // 1. Resolve the default workspace path: live defaultWorkspaceId first, then
  //    the path remembered from a previous healthy run.
  let defaultPath;
  const defaultId = registry.state?.defaultWorkspaceId;
  if (defaultId !== undefined) {
    const entity = registry.get(defaultId);
    if (entity !== undefined) defaultPath = entity.path;
  }
  if (defaultPath === undefined) defaultPath = readPersistedDefaultPath(base);
  if (defaultPath === undefined) return; // unknown — nothing to repair safely

  // 2. Keep the resolved path for future runs (covers a later dangling id).
  writePersistedDefaultPath(base, defaultPath);

  // 3. Recreate the registration when it is missing.
  let entity;
  try {
    entity = await registry.resolveByPath(defaultPath);
  } catch {
    entity = undefined;
  }
  if (entity !== undefined) return; // already registered

  try {
    entity = await registry.create(defaultPath, basename(defaultPath) || 'workspace');
    console.log('[session-delete] recreated default workspace', defaultPath);
  } catch (error) {
    console.error('[session-delete] failed to recreate default workspace', defaultPath, error);
    return;
  }

  // 4. Re-attach the sessions that belong to it; `attachSession` validates the
  //    cwd and throws for foreign sessions, which we skip.
  const sessions = ctx.get?.('sessions');
  const ids = new Set();
  if (sessions) for (const session of sessions.list()) ids.add(session.id);
  for (const id of listSessionIdsOnDisk(base)) ids.add(id);
  for (const id of ids) {
    try {
      await entity.attachSession(id);
    } catch {
      /* not this workspace's session */
    }
  }
}

/** Send a JSON response. */
function json(res, status, body) {
  res.writeHead(status, { 'content-type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(body));
}

/** Read and JSON-parse a request body, bounded to 1 MiB. */
async function readJson(req, maxBytes = 1024 * 1024) {
  if (req.body !== undefined) {
    if (typeof req.body === 'string') return req.body === '' ? {} : JSON.parse(req.body);
    if (Buffer.isBuffer(req.body)) return req.body.length === 0 ? {} : JSON.parse(req.body.toString('utf8'));
    return req.body ?? {};
  }
  const chunks = [];
  let received = 0;
  for await (const chunk of req) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    received += buffer.byteLength;
    if (received > maxBytes) throw new Error('请求体过大');
    chunks.push(buffer);
  }
  if (chunks.length === 0) return {};
  return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

/** Reject cross-site requests (same-origin fence, per the skin-center pattern). */
function isSameOriginRequest(req) {
  const site = req.headers['sec-fetch-site'];
  if (typeof site === 'string' && site === 'cross-site') return false;
  const origin = req.headers.origin;
  if (typeof origin === 'string' && origin !== '' && origin !== 'null') {
    const host = req.headers.host;
    if (typeof host !== 'string' || host === '') return false;
    try {
      if (new URL(origin).host !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}

function requireSameOrigin(req, res) {
  if (isSameOriginRequest(req)) return true;
  json(res, 403, { ok: false, error: 'cross-site-request-rejected' });
  return false;
}

/**
 * Perform one permanent session deletion, guarding live sessions.
 * @param ctx - Host context (its `sessions` store, `workspaces` registry).
 * @param sessionId - The durable session id to delete.
 * @param base - DSH state root (defaults to `~/.dsh`).
 * @returns `{ ok, sessionId }` or `{ ok:false, error }`.
 */
async function performDelete(ctx, sessionId, base = DEFAULT_DSH_HOME()) {
  // 1. A session with running work must not be torn down mid-flight: ask the
  //    same `workspace/session-activity` admission the archive path uses (it
  //    reports the `turn`/`job`/… families only while work is in flight). A
  //    merely warm session — attached in memory but idle — reports nothing and
  //    is safe to delete.
  let activity;
  try {
    if (typeof ctx.waterfall !== 'function') throw new Error('activity check unavailable');
    activity = await ctx.waterfall('workspace/session-activity', { sessionId }, () => Promise.resolve([]));
    if (!Array.isArray(activity)) throw new Error('invalid activity check result');
  } catch {
    // Without a reliable activity check, deleting may destroy a running session.
    return { ok: false, error: '无法确认会话的运行状态，请稍后重试' };
  }
  if (activity.length > 0) {
    const kinds = [...new Set(activity.map((entry) => entry?.kind).filter(Boolean))];
    const what = kinds.length > 0 ? kinds.join('、') : '有活动';
    return { ok: false, error: `该会话正在运行中（${what}），请先停止它再删除` };
  }

  // 2. Locate the persisted log directory before touching the registry, so a
  //    typo or an already-gone session reports cleanly.
  const dir = findSessionDir(sessionId, base);
  if (dir === null) {
    return { ok: false, error: `找不到会话 ${sessionId}（它可能已被删除）` };
  }

  // 3. Drop the workspace accounting and any archive/pin mark through the
  //    registry's own durable write path (idempotent for unknown ids).
  const workspaces = ctx.get?.('workspaceRegistry');
  if (workspaces) {
    try {
      for (const ws of workspaces.list()) {
        if (ws.sessionIds.includes(sessionId)) await ws.detachSession(sessionId);
      }
      await workspaces.unarchiveSession(sessionId);
      await workspaces.unpinSession(sessionId);
    } catch (error) {
      return { ok: false, error: `更新工作区索引失败：${error instanceof Error ? error.message : String(error)}` };
    }
  }

  // 4. Delete the persisted log and its projection cache.
  try {
    rmSync(dir, { recursive: true, force: true });
    rmSync(join(PROJECTION_CACHE_DIR(base), `${sessionId}.json`), { force: true });
  } catch (error) {
    return { ok: false, error: `删除会话文件失败：${error instanceof Error ? error.message : String(error)}` };
  }

  // 5. Tell the open client(s) to drop the row without a reload.
  try {
    ctx.emit?.('api-session/removed', sessionId);
  } catch {
    /* a missed client refresh is non-fatal; the list re-reads on next reload */
  }

  return { ok: true, sessionId };
}

/**
 * Register the delete route on the web server.
 * @param ctx - Context carrying the web server registry.
 * @param config - `{ dshHome? }` override (defaults to `~/.dsh`).
 */
export function apply(ctx, config = {}) {
  const base = typeof config.dshHome === 'string' && config.dshHome ? config.dshHome : DEFAULT_DSH_HOME();

  const route = (method, path, handler) => ({
    kind: 'exact',
    path,
    handler: async (req, res) => {
      if (req.method !== method) return json(res, 405, { ok: false, error: 'method-not-allowed' });
      if (!requireSameOrigin(req, res)) return;
      try {
        await handler(req, res);
      } catch (error) {
        json(res, 500, { ok: false, error: error instanceof Error ? error.message : String(error) });
      }
    },
  });

  try {
    ctx.effect(() => {
      const disposers = [
        route('POST', '/api/session-delete/delete', async (req, res) => {
          const { sessionId } = await readJson(req);
          if (typeof sessionId !== 'string' || !SESSION_ID.test(sessionId)) {
            return json(res, 400, { ok: false, error: '会话 ID 不合法' });
          }
          const result = await performDelete(ctx, sessionId, base);
          json(res, result.ok ? 200 : 400, result);
        }),
      ].map((r) => ctx.webServer.register(r));
      return () => {
        for (const d of disposers) d();
      };
    }, 'session-delete: routes');
  } catch (error) {
    console.error('[session-delete] route registration failed:', error);
  }

  // Auto-repair the default workspace registration when DSH's launch directory
  // lost its workspace record (e.g. deleted like any other workspace). Taken as
  // an OPTIONAL dependency so the plugin still loads if `workspaceRegistry` is
  // ever renamed upstream; the repair then simply never runs.
  try {
    ctx.inject(['workspaceRegistry'], (wsCtx) => {
      wsCtx.effect(() => {
        repairDefaultWorkspace(wsCtx, base).catch((error) => {
          console.error('[session-delete] default-workspace repair failed:', error);
        });
      }, 'session-delete: default-workspace repair');
    });
  } catch (error) {
    console.error('[session-delete] default-workspace repair registration failed:', error);
  }
}

/** Exposed for tests. */
export { DEFAULT_DSH_HOME, findSessionDir, listSessionIdsOnDisk, performDelete, repairDefaultWorkspace, SESSION_ID };
