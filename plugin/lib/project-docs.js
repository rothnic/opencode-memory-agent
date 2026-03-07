import { createHash } from 'node:crypto';
import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative } from 'node:path';

const DEFAULT_IGNORES = new Set(['.git', 'node_modules', 'dist', '.astro']);

function toPatternRegex(pattern) {
  const escaped = pattern
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replace(/\*\*/g, '::DOUBLE_STAR::')
    .replace(/\*/g, '[^/]*')
    .replace(/::DOUBLE_STAR::/g, '.*');
  return new RegExp(`^${escaped}$`, 'i');
}

export function matchesPattern(filePath, pattern) {
  return toPatternRegex(pattern).test(filePath.replace(/\\/g, '/'));
}

export function isProjectDocPath(filePath, patterns) {
  return patterns.some((pattern) => matchesPattern(filePath, pattern));
}

function hashContent(value) {
  return createHash('sha256').update(value).digest('hex');
}

function extractHeadings(content) {
  return content
    .split(/\r?\n/)
    .filter((line) => /^#{1,6}\s+/.test(line))
    .map((line) => line.replace(/^#{1,6}\s+/, '').trim())
    .slice(0, 12);
}

function extractTitle(relativePath, headings) {
  return headings[0] ?? relativePath;
}

export async function scanProjectDocs(config) {
  const files = [];
  const queue = [config.projectRoot];

  while (queue.length > 0) {
    const current = queue.shift();
    const entries = await readdir(current, { withFileTypes: true });

    for (const entry of entries) {
      const absolutePath = join(current, entry.name);
      const relPath = relative(config.projectRoot, absolutePath).replace(/\\/g, '/');
      if (!relPath) {
        continue;
      }

      if (entry.isDirectory()) {
        if (
          DEFAULT_IGNORES.has(entry.name) ||
          relPath.startsWith('.opencode/memory/private') ||
          relPath.startsWith('.opencode/memory/shared')
        ) {
          continue;
        }
        queue.push(absolutePath);
        continue;
      }

      if (!isProjectDocPath(relPath, config.docs.include)) {
        continue;
      }

      files.push({ absolutePath, relativePath: relPath });
    }
  }

  const limitedFiles = files.slice(0, config.docs.maxFiles);
  const docs = [];

  for (const file of limitedFiles) {
    const stats = await stat(file.absolutePath);
    const bytes = Math.min(stats.size, config.docs.maxBytesPerFile);
    const content = await readFile(file.absolutePath, 'utf8');
    const truncated = content.slice(0, config.docs.maxBytesPerFile);
    const headings = extractHeadings(truncated);

    docs.push({
      path: file.relativePath,
      title: extractTitle(file.relativePath, headings),
      headings,
      excerpt: truncated.slice(0, 600),
      bytes,
      updatedAt: stats.mtime.toISOString(),
      contentHash: hashContent(truncated)
    });
  }

  return docs;
}
