import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginConfig } from '../plugin/lib/config.js';
import { ensureStore, getStatus, readDocs, readInsights, readMemories, replaceDocs, replaceInsights, updateStatus, upsertMemory } from '../plugin/lib/store.js';

test('getStatus exposes configuration and runtime verification fields', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-memory-agent-status-'));
  await mkdir(join(root, '.opencode', 'memory'), { recursive: true });
  await writeFile(
    join(root, '.opencode', 'memory', 'config.json'),
    JSON.stringify({ debounceMs: 5000, consolidateEveryMinutes: 15, statusToast: false }, null, 2)
  );

  const config = await loadPluginConfig(root);
  await ensureStore(config);
  await updateStatus(config, {
    currentActivity: 'waiting-for-idle',
    lastError: null,
    runtime: {
      activeSessions: 1,
      scheduledSessions: 2,
      internalSessions: 0,
      consolidationTimerActive: true
    }
  });

  const status = await getStatus(config);
  assert.equal(status.configuration.debounceMs, 5000);
  assert.equal(status.configuration.consolidateEveryMinutes, 15);
  assert.equal(status.configuration.statusToast, false);
  assert.equal(status.currentActivity, 'waiting-for-idle');
  assert.equal(status.runtime.scheduledSessions, 2);
  assert.equal(status.storage.insightsFile.endsWith('insights.json'), true);
  assert.equal(status.storage.dbFile.endsWith('memory.db'), true);

  await updateStatus(config, { lastError: 'temporary failure' });
  const updatedStatus = await getStatus(config);
  assert.equal(updatedStatus.currentActivity, 'waiting-for-idle');
  assert.equal(updatedStatus.runtime.scheduledSessions, 2);
  assert.equal(updatedStatus.lastError, 'temporary failure');
});

test('shared memory artifacts are backed by sqlite and mirrored to json exports', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-memory-agent-sqlite-'));
  await mkdir(join(root, '.opencode', 'memory'), { recursive: true });

  const config = await loadPluginConfig(root);
  await ensureStore(config);
  await upsertMemory(config, {
    id: 'session:test',
    source: 'session',
    sessionId: 'test',
    title: 'Test session',
    summary: 'Captured a durable decision about storage.',
    entities: ['SQLite'],
    facts: ['Memory is persisted in a shared database.'],
    decisions: ['Keep json exports as review surfaces.'],
    todos: [],
    topics: ['memory', 'storage'],
    fileReferences: ['README.md'],
    importance: 0.8,
    updatedAt: '2026-03-07T19:00:00.000Z',
    contentHash: 'abc123',
    messageCount: 3
  });
  await replaceInsights(config, [{ id: 'insight:1', kind: 'insight', summary: 'SQLite is the primary shared store.', updatedAt: '2026-03-07T19:00:00.000Z' }]);
  await replaceDocs(config, [
    {
      path: 'README.md',
      title: 'README',
      headings: ['README'],
      excerpt: 'Project overview',
      bytes: 16,
      updatedAt: '2026-03-07T19:00:00.000Z',
      contentHash: 'def456'
    }
  ]);

  const memories = await readMemories(config);
  const insights = await readInsights(config);
  const docs = await readDocs(config);
  assert.equal(memories.memories[0].fileReferences.includes('README.md'), true);
  assert.equal(insights.insights[0].summary, 'SQLite is the primary shared store.');
  assert.equal(docs.docs[0].path, 'README.md');
});
