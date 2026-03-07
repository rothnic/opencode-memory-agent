import test from 'node:test';
import assert from 'node:assert/strict';
import { buildConsolidationFallback } from '../plugin/lib/memory-processing.js';

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
