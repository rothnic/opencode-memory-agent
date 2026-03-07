import { DatabaseSync } from 'node:sqlite';
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
  lastActivityAt: null,
  lastEvent: null,
  lastRun: null,
  lastBackfillAt: null,
  lastBackfillProcessed: 0,
  lastConsolidationAt: null,
  lastConsolidationGenerated: 0,
  lastDocsRefreshAt: null,
  lastDocsRefreshCount: 0,
  processedSessionCount: 0,
  memoryCount: 0,
  insightCount: 0,
  docsCount: 0,
  healthy: true,
  currentActivity: 'idle',
  lastError: null,
  runtime: {
    activeSessions: 0,
    scheduledSessions: 0,
    internalSessions: 0,
    consolidationTimerActive: false
  }
};

function openDatabase(config) {
  try {
    const db = new DatabaseSync(config.paths.dbFile);
    db.exec(`
      PRAGMA journal_mode = WAL;

      CREATE TABLE IF NOT EXISTS memories (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL DEFAULT 'session',
        sessionId TEXT,
        title TEXT NOT NULL,
        summary TEXT NOT NULL,
        entities TEXT NOT NULL DEFAULT '[]',
        facts TEXT NOT NULL DEFAULT '[]',
        decisions TEXT NOT NULL DEFAULT '[]',
        todos TEXT NOT NULL DEFAULT '[]',
        topics TEXT NOT NULL DEFAULT '[]',
        fileReferences TEXT NOT NULL DEFAULT '[]',
        importance REAL NOT NULL DEFAULT 0.5,
        updatedAt TEXT NOT NULL,
        contentHash TEXT NOT NULL DEFAULT '',
        messageCount INTEGER NOT NULL DEFAULT 0
      );

      CREATE TABLE IF NOT EXISTS insights (
        id TEXT PRIMARY KEY,
        kind TEXT NOT NULL,
        summary TEXT NOT NULL,
        updatedAt TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS docs (
        path TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        headings TEXT NOT NULL DEFAULT '[]',
        excerpt TEXT NOT NULL DEFAULT '',
        bytes INTEGER NOT NULL DEFAULT 0,
        updatedAt TEXT NOT NULL,
        contentHash TEXT NOT NULL DEFAULT ''
      );
    `);
    return db;
  } catch (error) {
    throw new Error(`opencode-memory-agent could not open shared memory database at ${config.paths.dbFile}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

function parseJsonField(value, fallback = []) {
  if (typeof value !== 'string' || value.length === 0) {
    return fallback;
  }

  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : fallback;
  } catch {
    return fallback;
  }
}

function serializeJsonField(value) {
  return JSON.stringify(Array.isArray(value) ? value : []);
}

function mapMemoryRow(row) {
  return {
    id: row.id,
    source: row.source,
    sessionId: row.sessionId,
    title: row.title,
    summary: row.summary,
    entities: parseJsonField(row.entities),
    facts: parseJsonField(row.facts),
    decisions: parseJsonField(row.decisions),
    todos: parseJsonField(row.todos),
    topics: parseJsonField(row.topics),
    fileReferences: parseJsonField(row.fileReferences),
    importance: row.importance,
    updatedAt: row.updatedAt,
    contentHash: row.contentHash,
    messageCount: row.messageCount
  };
}

function mapInsightRow(row) {
  return {
    id: row.id,
    kind: row.kind,
    summary: row.summary,
    updatedAt: row.updatedAt
  };
}

function mapDocRow(row) {
  return {
    path: row.path,
    title: row.title,
    headings: parseJsonField(row.headings),
    excerpt: row.excerpt,
    bytes: row.bytes,
    updatedAt: row.updatedAt,
    contentHash: row.contentHash
  };
}

function readMemoriesFromDb(db) {
  return db.prepare('SELECT * FROM memories ORDER BY updatedAt DESC').all().map(mapMemoryRow);
}

function readInsightsFromDb(db) {
  return db.prepare('SELECT * FROM insights ORDER BY updatedAt DESC').all().map(mapInsightRow);
}

function readDocsFromDb(db) {
  return db.prepare('SELECT * FROM docs ORDER BY path ASC').all().map(mapDocRow);
}

async function syncSharedArtifacts(config, db = null) {
  const ownDb = db ?? openDatabase(config);
  try {
    const memories = readMemoriesFromDb(ownDb);
    const insights = readInsightsFromDb(ownDb);
    const docs = readDocsFromDb(ownDb);
    await Promise.all([
      writeJson(config.paths.memoryFile, { version: 1, memories }),
      writeJson(config.paths.insightsFile, { version: 1, insights }),
      writeJson(config.paths.docsFile, { version: 1, docs })
    ]);
  } finally {
    if (!db) {
      ownDb.close();
    }
  }
}

export async function ensureStore(config) {
  await ensureDirectory(config.paths.sharedDir);
  await ensureDirectory(config.paths.privateDir);

  const db = openDatabase(config);
  db.close();

  await Promise.all([
    writeJsonIfMissing(config.paths.stateFile, EMPTY_STATE),
    writeJsonIfMissing(config.paths.statusFile, EMPTY_STATUS)
  ]);
  await syncSharedArtifacts(config);
}

async function writeJsonIfMissing(path, value) {
  const current = await readJson(path, null);
  if (current === null) {
    await writeJson(path, value);
  }
}

export async function readMemories(config) {
  const db = openDatabase(config);
  try {
    return { version: 1, memories: readMemoriesFromDb(db) };
  } finally {
    db.close();
  }
}

export async function writeMemories(config, value) {
  const db = openDatabase(config);
  let inTransaction = false;
  try {
    db.exec('BEGIN');
    inTransaction = true;
    db.exec('DELETE FROM memories');
    const insert = db.prepare(`
      INSERT INTO memories (
        id, source, sessionId, title, summary, entities, facts, decisions, todos, topics, fileReferences,
        importance, updatedAt, contentHash, messageCount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `);
    for (const entry of value?.memories ?? []) {
      insert.run(
        entry.id,
        entry.source ?? 'session',
        entry.sessionId ?? null,
        entry.title ?? entry.sessionId ?? entry.id,
        entry.summary ?? '',
        serializeJsonField(entry.entities),
        serializeJsonField(entry.facts),
        serializeJsonField(entry.decisions),
        serializeJsonField(entry.todos),
        serializeJsonField(entry.topics),
        serializeJsonField(entry.fileReferences),
        entry.importance ?? 0.5,
        entry.updatedAt ?? new Date().toISOString(),
        entry.contentHash ?? '',
        entry.messageCount ?? 0
      );
    }
    db.exec('COMMIT');
    inTransaction = false;
    await syncSharedArtifacts(config, db);
  } catch (error) {
    if (inTransaction) {
      db.exec('ROLLBACK');
    }
    throw error;
  } finally {
    db.close();
  }
}

export async function readInsights(config) {
  const db = openDatabase(config);
  try {
    return { version: 1, insights: readInsightsFromDb(db) };
  } finally {
    db.close();
  }
}

export async function writeInsights(config, value) {
  const db = openDatabase(config);
  let inTransaction = false;
  try {
    db.exec('BEGIN');
    inTransaction = true;
    db.exec('DELETE FROM insights');
    const insert = db.prepare('INSERT INTO insights (id, kind, summary, updatedAt) VALUES (?, ?, ?, ?)');
    for (const entry of value?.insights ?? []) {
      insert.run(entry.id, entry.kind ?? 'insight', entry.summary ?? '', entry.updatedAt ?? new Date().toISOString());
    }
    db.exec('COMMIT');
    inTransaction = false;
    await syncSharedArtifacts(config, db);
  } catch (error) {
    if (inTransaction) {
      db.exec('ROLLBACK');
    }
    throw error;
  } finally {
    db.close();
  }
}

export async function readDocs(config) {
  const db = openDatabase(config);
  try {
    return { version: 1, docs: readDocsFromDb(db) };
  } finally {
    db.close();
  }
}

export async function writeDocs(config, value) {
  const db = openDatabase(config);
  let inTransaction = false;
  try {
    db.exec('BEGIN');
    inTransaction = true;
    db.exec('DELETE FROM docs');
    const insert = db.prepare('INSERT INTO docs (path, title, headings, excerpt, bytes, updatedAt, contentHash) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const entry of value?.docs ?? []) {
      insert.run(
        entry.path,
        entry.title ?? entry.path,
        serializeJsonField(entry.headings),
        entry.excerpt ?? '',
        entry.bytes ?? 0,
        entry.updatedAt ?? new Date().toISOString(),
        entry.contentHash ?? ''
      );
    }
    db.exec('COMMIT');
    inTransaction = false;
    await syncSharedArtifacts(config, db);
  } catch (error) {
    if (inTransaction) {
      db.exec('ROLLBACK');
    }
    throw error;
  } finally {
    db.close();
  }
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
  const db = openDatabase(config);
  try {
    db.prepare(`
      INSERT INTO memories (
        id, source, sessionId, title, summary, entities, facts, decisions, todos, topics, fileReferences,
        importance, updatedAt, contentHash, messageCount
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(id) DO UPDATE SET
        source = excluded.source,
        sessionId = excluded.sessionId,
        title = excluded.title,
        summary = excluded.summary,
        entities = excluded.entities,
        facts = excluded.facts,
        decisions = excluded.decisions,
        todos = excluded.todos,
        topics = excluded.topics,
        fileReferences = excluded.fileReferences,
        importance = excluded.importance,
        updatedAt = excluded.updatedAt,
        contentHash = excluded.contentHash,
        messageCount = excluded.messageCount
    `).run(
      entry.id,
      entry.source ?? 'session',
      entry.sessionId ?? null,
      entry.title ?? entry.sessionId ?? entry.id,
      entry.summary ?? '',
      serializeJsonField(entry.entities),
      serializeJsonField(entry.facts),
      serializeJsonField(entry.decisions),
      serializeJsonField(entry.todos),
      serializeJsonField(entry.topics),
      serializeJsonField(entry.fileReferences),
      entry.importance ?? 0.5,
      entry.updatedAt ?? new Date().toISOString(),
      entry.contentHash ?? '',
      entry.messageCount ?? 0
    );
    const memories = readMemoriesFromDb(db);
    await syncSharedArtifacts(config, db);
    return memories;
  } finally {
    db.close();
  }
}

export async function replaceDocs(config, docs) {
  await writeDocs(config, { version: 1, docs: [...docs] });
  return docs;
}

export async function replaceInsights(config, insights) {
  await writeInsights(config, { version: 1, insights: [...insights] });
  return insights;
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
    docsEnabled: config.docs.enabled,
    configuration: {
      enabled: config.enabled,
      debounceMs: config.debounceMs,
      processSessionIdle: config.processSessionIdle,
      maxBackfillSessions: config.maxBackfillSessions,
      backfillOnStartup: config.backfillOnStartup,
      consolidateEveryMinutes: config.consolidateEveryMinutes,
      consolidateOnStartup: config.consolidateOnStartup,
      statusToast: config.statusToast,
      docs: {
        enabled: config.docs.enabled,
        autoRefreshOnStartup: config.docs.autoRefreshOnStartup,
        autoRefreshOnEdit: config.docs.autoRefreshOnEdit,
        includeCount: config.docs.include.length
      }
    }
  };
}
