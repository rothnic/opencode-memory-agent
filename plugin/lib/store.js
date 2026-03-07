import { ensureDirectory, readJson, writeJson } from './fs.js';

const EMPTY_MEMORIES = { version: 1, memories: [] };
const EMPTY_INSIGHTS = { version: 1, insights: [] };
const EMPTY_DOCS = { version: 1, docs: [] };
const EMPTY_STATE = {
  version: 1,
  processedSessions: {},
  docs: {},
  lastBackfillAt: null,
  lastConsolidationAt: null,
  lastDocsRefreshAt: null,
  lastMemoryRunAt: null
};
const EMPTY_STATUS = {
  version: 1,
  initializedAt: null,
  lastEvent: null,
  lastRun: null,
  lastBackfillAt: null,
  lastConsolidationAt: null,
  lastDocsRefreshAt: null,
  processedSessionCount: 0,
  memoryCount: 0,
  insightCount: 0,
  docsCount: 0,
  healthy: true
};

export async function ensureStore(config) {
  await ensureDirectory(config.paths.sharedDir);
  await ensureDirectory(config.paths.privateDir);
  await writeJsonIfMissing(config.paths.memoryFile, EMPTY_MEMORIES);
  await writeJsonIfMissing(config.paths.insightsFile, EMPTY_INSIGHTS);
  await writeJsonIfMissing(config.paths.docsFile, EMPTY_DOCS);
  await writeJsonIfMissing(config.paths.stateFile, EMPTY_STATE);
  await writeJsonIfMissing(config.paths.statusFile, EMPTY_STATUS);
}

async function writeJsonIfMissing(path, value) {
  const current = await readJson(path, null);
  if (current === null) {
    await writeJson(path, value);
  }
}

export async function readMemories(config) {
  return readJson(config.paths.memoryFile, EMPTY_MEMORIES);
}

export async function writeMemories(config, value) {
  await writeJson(config.paths.memoryFile, value);
}

export async function readInsights(config) {
  return readJson(config.paths.insightsFile, EMPTY_INSIGHTS);
}

export async function writeInsights(config, value) {
  await writeJson(config.paths.insightsFile, value);
}

export async function readDocs(config) {
  return readJson(config.paths.docsFile, EMPTY_DOCS);
}

export async function writeDocs(config, value) {
  await writeJson(config.paths.docsFile, value);
}

export async function readState(config) {
  return readJson(config.paths.stateFile, EMPTY_STATE);
}

export async function writeState(config, value) {
  await writeJson(config.paths.stateFile, value);
}

export async function updateState(config, updater) {
  const state = await readState(config);
  const next = await updater(state);
  await writeState(config, next);
  return next;
}

export async function updateStatus(config, updater) {
  const status = await readJson(config.paths.statusFile, EMPTY_STATUS);
  const next = typeof updater === 'function' ? await updater(status) : { ...status, ...updater };
  await writeJson(config.paths.statusFile, next);
  return next;
}

export async function upsertMemory(config, entry) {
  const payload = await readMemories(config);
  const memories = payload.memories.filter((item) => item.id !== entry.id && item.sessionId !== entry.sessionId);
  memories.push(entry);
  memories.sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  await writeMemories(config, { ...payload, memories });
  return memories;
}

export async function replaceDocs(config, docs) {
  const payload = { version: 1, docs: [...docs].sort((a, b) => a.path.localeCompare(b.path)) };
  await writeDocs(config, payload);
  return payload.docs;
}

export async function replaceInsights(config, insights) {
  const payload = { version: 1, insights: [...insights] };
  await writeInsights(config, payload);
  return payload.insights;
}

export async function getStatus(config) {
  const [status, memories, insights, docs, state] = await Promise.all([
    readJson(config.paths.statusFile, EMPTY_STATUS),
    readMemories(config),
    readInsights(config),
    readDocs(config),
    readState(config)
  ]);

  return {
    ...status,
    memoryCount: memories.memories.length,
    insightCount: insights.insights.length,
    docsCount: docs.docs.length,
    processedSessionCount: Object.keys(state.processedSessions ?? {}).length,
    storage: config.paths,
    docsEnabled: config.docs.enabled
  };
}
