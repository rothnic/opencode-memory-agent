import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginConfig } from '../plugin/lib/config.js';

test('loadPluginConfig merges project config over defaults', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-memory-agent-config-'));
  await mkdir(join(root, '.opencode', 'memory'), { recursive: true });
  await writeFile(
    join(root, '.opencode', 'memory', 'config.json'),
    JSON.stringify(
      { debounceMs: 5000, docs: { maxFiles: 5 }, storage: { baseDir: '.custom-memory' } },
      null,
      2
    )
  );

  const config = await loadPluginConfig(root);
  assert.equal(config.debounceMs, 5000);
  assert.equal(config.consolidateEveryMinutes, 30);
  assert.equal(config.docs.maxFiles, 5);
  assert.match(config.paths.baseDir, /\.custom-memory$/);
  assert.equal(config.storage.memoryFile, 'memories.json');
  assert.match(config.paths.insightsFile, /insights\.json$/);
});
