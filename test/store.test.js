import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginConfig } from '../plugin/lib/config.js';
import { ensureStore, getStatus, updateStatus } from '../plugin/lib/store.js';

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

  await updateStatus(config, { lastError: 'temporary failure' });
  const updatedStatus = await getStatus(config);
  assert.equal(updatedStatus.currentActivity, 'waiting-for-idle');
  assert.equal(updatedStatus.runtime.scheduledSessions, 2);
  assert.equal(updatedStatus.lastError, 'temporary failure');
});
