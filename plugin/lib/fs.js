import { mkdir, readFile, writeFile } from 'node:fs/promises';

export async function ensureDirectory(path) {
  await mkdir(path, { recursive: true });
}

export async function readJson(path, fallback) {
  try {
    const value = await readFile(path, 'utf8');
    return JSON.parse(value);
  } catch (error) {
    if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') {
      return fallback;
    }
    throw error;
  }
}

export async function writeJson(path, value) {
  await writeFile(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}
