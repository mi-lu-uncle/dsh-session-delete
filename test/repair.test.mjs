import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { repairDefaultWorkspace, listSessionIdsOnDisk } from '../lib/index.js';

const SID = 'session-783526e1-5810-4b2a-b77b-15557a505f8c';

function makeDir(prefix) {
  return mkdtempSync(join(tmpdir(), prefix));
}

function stateFile(base) {
  return join(base, 'plugins', 'session-delete', 'state.json');
}

function makeEntity(id, path) {
  const attached = [];
  return { id, path, attachSession: async (sid) => { attached.push(sid); }, _attached: attached };
}

function mockCtx(registry, sessionsList = []) {
  return {
    get(name) {
      if (name === 'workspaceRegistry') return registry;
      if (name === 'sessions') return { list: () => sessionsList };
      return undefined;
    },
  };
}

test('recreates the default workspace identified by defaultWorkspaceId', async () => {
  const base = makeDir('dsh-repair-home-');
  const live = makeEntity('ws-default', '/tmp/default-dir');
  const created = [];
  const createdEntity = makeEntity('ws-new', live.path);
  const registry = {
    state: { defaultWorkspaceId: 'ws-default' },
    get: (id) => (id === 'ws-default' ? live : undefined),
    resolveByPath: async () => undefined,
    create: async (path, title) => { created.push({ path, title }); return createdEntity; },
  };
  const ctx = mockCtx(registry, [{ id: SID }]);

  await repairDefaultWorkspace(ctx, base);
  assert.equal(created.length, 1, 'workspace must be recreated');
  assert.equal(created[0].path, '/tmp/default-dir');
  assert.ok(createdEntity._attached.includes(SID), 'session must be re-attached');
  assert.equal(JSON.parse(readFileSync(stateFile(base), 'utf8')).defaultWorkspacePath, '/tmp/default-dir');
});

test('uses the persisted path when defaultWorkspaceId is dangling', async () => {
  const base = makeDir('dsh-repair-home-');
  const persistedPath = '/tmp/persisted-default';
  mkdirSync(join(base, 'plugins', 'session-delete'), { recursive: true });
  writeFileSync(stateFile(base), JSON.stringify({ defaultWorkspacePath: persistedPath }));

  const created = [];
  const createdEntity = makeEntity('ws-new', persistedPath);
  const registry = {
    state: { defaultWorkspaceId: 'ws-gone' },
    get: () => undefined, // dangling
    resolveByPath: async () => undefined,
    create: async (path, title) => { created.push({ path, title }); return createdEntity; },
  };
  const ctx = mockCtx(registry);

  await repairDefaultWorkspace(ctx, base);
  assert.equal(created.length, 1);
  assert.equal(created[0].path, persistedPath);
});

test('no-ops when the default workspace is already registered', async () => {
  const base = makeDir('dsh-repair-home-');
  const live = makeEntity('ws-default', '/tmp/default-dir');
  const registry = {
    state: { defaultWorkspaceId: 'ws-default' },
    get: (id) => (id === 'ws-default' ? live : undefined),
    resolveByPath: async () => live,
    create: async () => { throw new Error('should not create'); },
  };
  const ctx = mockCtx(registry);

  await repairDefaultWorkspace(ctx, base);
  assert.equal(JSON.parse(readFileSync(stateFile(base), 'utf8')).defaultWorkspacePath, '/tmp/default-dir');
});

test('no-ops when no default path is known', async () => {
  const base = makeDir('dsh-repair-home-');
  const registry = {
    state: { defaultWorkspaceId: 'ws-gone' },
    get: () => undefined,
    resolveByPath: async () => { throw new Error('should not resolve'); },
    create: async () => { throw new Error('should not create'); },
  };
  const ctx = mockCtx(registry);

  await repairDefaultWorkspace(ctx, base);
  assert.equal(existsSync(stateFile(base)), false);
});

test('listSessionIdsOnDisk finds persisted session directories', () => {
  const base = makeDir('dsh-repair-sessions-');
  const wsDir = join(base, 'sessions', '--ws--');
  const other = 'session-00000000-0000-0000-0000-000000000000';
  mkdirSync(join(wsDir, SID), { recursive: true });
  mkdirSync(join(wsDir, other), { recursive: true });
  const ids = listSessionIdsOnDisk(base);
  assert.ok(ids.includes(SID));
  assert.ok(ids.includes(other));
});
