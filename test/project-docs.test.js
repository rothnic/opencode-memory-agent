import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DEFAULT_CONFIG } from '../plugin/lib/config.js';
import { scanProjectDocs, matchesPattern, isProjectDocPath } from '../plugin/lib/project-docs.js';

test('matchesPattern supports common docs globs', () => {
  assert.equal(matchesPattern('docs/guide/install.mdx', 'docs/**/*.mdx'), true);
  assert.equal(matchesPattern('README.md', 'README.md'), true);
  assert.equal(matchesPattern('src/index.ts', 'docs/**/*.md'), false);
});

test('scanProjectDocs indexes configured project docs', async () => {
  const root = await mkdtemp(join(tmpdir(), 'opencode-memory-agent-docs-'));
  await mkdir(join(root, 'docs', 'guides'), { recursive: true });
  await writeFile(join(root, 'README.md'), '# Example\n\nIntro');
  await writeFile(join(root, 'docs', 'guides', 'install.mdx'), '# Install\n\nHow to install');
  await writeFile(join(root, 'notes.txt'), 'not a configured doc');

  const docs = await scanProjectDocs({
    ...DEFAULT_CONFIG,
    projectRoot: root,
    docs: DEFAULT_CONFIG.docs
  });

  assert.equal(isProjectDocPath('README.md', DEFAULT_CONFIG.docs.include), true);
  assert.equal(docs.some((entry) => entry.path === 'README.md'), true);
  assert.equal(docs.some((entry) => entry.path === 'docs/guides/install.mdx'), true);
  assert.equal(docs.some((entry) => entry.path === 'notes.txt'), false);
});
