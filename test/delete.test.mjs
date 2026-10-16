import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { performDelete, SESSION_ID } from '../lib/index.js';

const SID = 'session-783526e1-5810-4b2a-b77b-15557a505f8c';

function makeFixture() {
  const base = mkdtempSync(join(tmpdir(), 'dsh-delete-'));
  const sessionDir = join(base, 'sessions', '--Users-x-Workspace-y--', SID);
  const cacheFile = join(base, 'storages', 'session_projcache', 'sessions', `${SID}.json`);
  mkdirSync(sessionDir, { recursive: true });
  mkdirSync(join(cacheFile, '..'), { recursive: true });
  writeFileSync(join(sessionDir, 'session.v4.jsonl.zstd'), 'zstd-payload');
  writeFileSync(join(sessionDir, 'session.lock'), '');
  writeFileSync(cacheFile, '{}');
  return { base, sessionDir, cacheFile };
}

/** Mock host ctx: activity waterfall + workspace registry. */
function mockCtx({ activity = [], activityThrows = false } = {}) {
  const calls = { detach: 0, unarchive: 0, unpin: 0, emitted: [] };
  const ctx = {
    waterfall(name) {
      if (name !== 'workspace/session-activity') return Promise.resolve([]);
      if (activityThrows) return Promise.reject(new Error('reporter down'));
      return Promise.resolve(activity);
    },
    get(name) {
      if (name === 'workspaceRegistry') {
        return {
          list: () => [
            {
              sessionIds: [SID],
              detachSession: async () => { calls.detach += 1; },
            },
          ],
          unarchiveSession: async () => { calls.unarchive += 1; },
          unpinSession: async () => { calls.unpin += 1; },
        };
      }
      return undefined;
    },
    emit(name, payload) { calls.emitted.push([name, payload]); },
  };
  return { ctx, calls };
}

test('rejects a session with running work without touching files', async () => {
  const { base, sessionDir } = makeFixture();
  const { ctx, calls } = mockCtx({ activity: [{ kind: 'turn' }, { kind: 'job', label: 'x' }] });
  const result = await performDelete(ctx, SID, base);
  assert.equal(result.ok, false);
  assert.match(result.error, /正在运行中/);
  assert.match(result.error, /turn、job/);
  assert.ok(existsSync(sessionDir), 'session dir must survive a refused delete');
  assert.equal(calls.detach, 0);
  assert.equal(calls.emitted.length, 0);
});

test('deletes an idle (attached-but-quiet) session: files, cache, registry, event', async () => {
  const { base, sessionDir, cacheFile } = makeFixture();
  const { ctx, calls } = mockCtx({ activity: [] });
  const result = await performDelete(ctx, SID, base);
  assert.equal(result.ok, true);
  assert.equal(existsSync(sessionDir), false, 'session dir must be removed');
  assert.equal(existsSync(cacheFile), false, 'projection cache must be removed');
  assert.equal(calls.detach, 1, 'workspace accounting must be detached');
  assert.equal(calls.unarchive, 1);
  assert.equal(calls.unpin, 1);
  assert.deepEqual(calls.emitted, [['api-session/removed', SID]]);
});

test('a failing activity reporter does not block a delete', async () => {
  const { base } = makeFixture();
  const { ctx } = mockCtx({ activityThrows: true });
  const result = await performDelete(ctx, SID, base);
  assert.equal(result.ok, true);
});

test('reports a missing session cleanly', async () => {
  const { base } = makeFixture();
  const { ctx } = mockCtx({ activity: [] });
  const result = await performDelete(ctx, 'session-00000000-0000-0000-0000-000000000000', base);
  assert.equal(result.ok, false);
  assert.match(result.error, /找不到会话/);
});

test('SESSION_ID matches DSH-minted ids and rejects garbage', () => {
  assert.equal(SESSION_ID.test(SID), true);
  assert.equal(SESSION_ID.test('not-a-session'), false);
  assert.equal(SESSION_ID.test('session-../etc/passwd'), false);
});
