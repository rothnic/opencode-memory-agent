import { resolve, join, isAbsolute } from 'node:path';
import { homedir } from 'node:os';
import { readJson } from './fs.js';

export const DEFAULT_CONFIG = {
  enabled: true,
  debounceMs: 15000,
  processSessionIdle: true,
  maxMessagesPerSession: 40,
  maxTranscriptChars: 16000,
  maxBackfillSessions: 20,
  backfillOnStartup: false,
  consolidateEveryMinutes: 30,
  consolidateOnStartup: true,
  statusToast: true,
  storage: {
    baseDir: '.opencode/memory',
    sharedDir: 'shared',
    privateDir: 'private',
    dbFile: 'memory.db',
    memoryFile: 'memories.json',
    insightsFile: 'insights.json',
    docsFile: 'project-docs.json',
    stateFile: 'state.json',
    statusFile: 'status.json'
  },
  docs: {
    enabled: true,
    autoRefreshOnStartup: true,
    autoRefreshOnEdit: true,
    maxFiles: 40,
    maxBytesPerFile: 20000,
    include: [
      'README.md',
      'AGENTS.md',
      'CONTRIBUTING.md',
      'CHANGELOG.md',
      'docs/**/*.md',
      'docs/**/*.mdx',
      '.opencode/agents/**/*.md'
    ]
  },
  model: undefined
};

function isPlainObject(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

function mergeConfig(base, override) {
  if (!isPlainObject(override)) {
    return base;
  }

  const next = { ...base };
  for (const [key, value] of Object.entries(override)) {
    if (Array.isArray(value)) {
      next[key] = [...value];
    } else if (isPlainObject(value) && isPlainObject(base[key])) {
      next[key] = mergeConfig(base[key], value);
    } else {
      next[key] = value;
    }
  }
  return next;
}

function normalizeStoragePaths(projectRoot, config) {
  const baseDir = resolve(projectRoot, config.storage.baseDir);
  const sharedDir = resolve(baseDir, config.storage.sharedDir);
  const privateDir = resolve(baseDir, config.storage.privateDir);
  return {
    ...config,
    projectRoot,
    paths: {
      baseDir,
      sharedDir,
      privateDir,
      dbFile: resolve(sharedDir, config.storage.dbFile),
      memoryFile: resolve(sharedDir, config.storage.memoryFile),
      insightsFile: resolve(sharedDir, config.storage.insightsFile),
      docsFile: resolve(sharedDir, config.storage.docsFile),
      stateFile: resolve(privateDir, config.storage.stateFile),
      statusFile: resolve(privateDir, config.storage.statusFile)
    }
  };
}

export function parseModel(model) {
  if (!model || typeof model !== 'string') {
    return undefined;
  }

  const [providerID, ...modelParts] = model.split('/');
  if (!providerID || modelParts.length === 0) {
    return undefined;
  }

  return {
    providerID,
    modelID: modelParts.join('/')
  };
}

function getGlobalConfigPath() {
  if (process.platform === 'win32' && process.env.APPDATA) {
    return join(process.env.APPDATA, 'opencode', 'opencode-memory-agent.json');
  }

  return join(homedir(), '.config', 'opencode', 'opencode-memory-agent.json');
}

export async function loadPluginConfig(projectRoot) {
  const globalPath = getGlobalConfigPath();
  const projectPath = join(projectRoot, '.opencode', 'memory', 'config.json');
  const customPath = process.env.OPENCODE_MEMORY_AGENT_CONFIG;

  const sources = [
    await readJson(globalPath, {}),
    customPath ? await readJson(isAbsolute(customPath) ? customPath : resolve(projectRoot, customPath), {}) : {},
    await readJson(projectPath, {})
  ];

  const merged = sources.reduce((result, source) => mergeConfig(result, source), DEFAULT_CONFIG);
  return normalizeStoragePaths(projectRoot, merged);
}
