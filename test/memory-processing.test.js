import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { loadPluginConfig } from '../plugin/lib/config.js';
import { buildConsolidationFallback, enrichTranscriptWithReferencedFiles } from '../plugin/lib/memory-processing.js';

test('buildConsolidationFallback derives insights and focus areas from stored memories', () => {
  const result = buildConsolidationFallback([
    {
      id: 'session:1',
      summary: 'Need durable memory for agent reliability work.',
      topics: ['memory', 'agents', 'reliability'],
      todos: ['Ship the first memory API']
    },
    {
      id: 'session:2',
      summary: 'Persistent memory should support project docs and backfill.',
      topics: ['memory', 'docs', 'backfill'],
      todos: ['Backfill the latest 20 sessions']
    }
  ]);

  assert.equal(result.insights.length > 0, true);
  assert.equal(result.connections.some((item) => item.includes('session:1')), true);
  assert.equal(result.focusAreas.includes('Ship the first memory API'), true);
});

test('enrichTranscriptWithReferencedFiles loads referenced text files into session context', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-memory-agent-files-'));
  const config = await loadPluginConfig(root);
  await writeFile(join(root, 'README.md'), '# Project\n\nImportant implementation detail');
  await writeFile(join(root, '.env'), 'SECRET_TOKEN=should-not-be-read');

  const result = await enrichTranscriptWithReferencedFiles(
    'USER: Please check README.md before changing this. Ignore .env.',
    config
  );

  assert.equal(result.referencedFiles.length, 1);
  assert.equal(result.referencedFiles[0].path, 'README.md');
  assert.match(result.referencedFiles[0].excerpt, /Important implementation detail/);
  assert.notEqual(result.contentHash.length, 0);
});
