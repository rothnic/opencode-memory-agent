import { relative } from 'node:path';
import { tool } from '@opencode-ai/plugin';
import { loadPluginConfig } from './lib/config.js';
import { scanProjectDocs, isProjectDocPath } from './lib/project-docs.js';
import {
  ensureStore,
  getStatus,
  readDocs,
  readInsights,
  readState,
  readMemories,
  replaceDocs,
  replaceInsights,
  updateState,
  updateStatus,
  upsertMemory
} from './lib/store.js';
import {
  answerMemoryQuery,
  consolidateMemoryEntries,
  createMemoryEntry,
  enrichTranscriptWithReferencedFiles,
  flattenSessionMessages
} from './lib/memory-processing.js';

const RELEVANT_EVENTS = new Set(['session.idle', 'file.edited', 'message.updated', 'todo.updated', 'server.connected']);
const INTERNAL_SESSION_PREFIX = '[opencode-memory-agent]';

function formatTimestamp(value) {
  return value ? new Date(value).toISOString() : 'never';
}

function safePreview(value) {
  try {
    const serialized = JSON.stringify(value);
    return serialized.length > 160 ? `${serialized.slice(0, 157)}...` : serialized;
  } catch {
    return '[unserializable entry]';
  }
}

function summarizeGeneratedEntries(entries, key, limit = 3) {
  if (!Array.isArray(entries)) {
    return [];
  }

  return entries
    .slice(0, limit)
    .map((entry, index) => {
      const value = entry?.[key];
      const label = typeof value === 'string' && value.trim() ? value.trim() : safePreview(entry);
      return `${index + 1}. ${label}`;
    });
}

function buildStatusReport({ status, memories, insights, docs }) {
  const recentMemories = summarizeGeneratedEntries(memories.memories, 'summary');
  const recentInsights = summarizeGeneratedEntries(insights.insights, 'summary');
  const recentDocs = summarizeGeneratedEntries(docs.docs, 'path');

  return [
    'opencode-memory-agent status',
    '',
    'Health',
    `- healthy: ${status.healthy ? 'yes' : 'no'}`,
    `- current activity: ${status.currentActivity}`,
    `- last event: ${status.lastEvent ?? 'none yet'}`,
    `- last activity at: ${formatTimestamp(status.lastActivityAt)}`,
    `- last memory capture: ${formatTimestamp(status.lastRun)}`,
    `- last backfill: ${formatTimestamp(status.lastBackfillAt)} (${status.lastBackfillProcessed} session(s))`,
    `- last consolidation: ${formatTimestamp(status.lastConsolidationAt)} (${status.lastConsolidationGenerated} insight item(s))`,
    `- last docs refresh: ${formatTimestamp(status.lastDocsRefreshAt)} (${status.lastDocsRefreshCount} doc file(s))`,
    `- last error: ${status.lastError ?? 'none'}`,
    '',
    'Configured behavior',
    `- session debounce: ${status.configuration.debounceMs}ms`,
    `- process session idle events: ${status.configuration.processSessionIdle ? 'yes' : 'no'}`,
    `- consolidation cadence: every ${status.configuration.consolidateEveryMinutes} minute(s) while OpenCode is running`,
    `- consolidate on startup: ${status.configuration.consolidateOnStartup ? 'yes' : 'no'}`,
    `- backfill on startup: ${status.configuration.backfillOnStartup ? 'yes' : 'no'}`,
    `- docs indexing enabled: ${status.configuration.docs.enabled ? 'yes' : 'no'}`,
    `- docs auto-refresh on startup/edit: ${status.configuration.docs.autoRefreshOnStartup ? 'yes' : 'no'}/${status.configuration.docs.autoRefreshOnEdit ? 'yes' : 'no'}`,
    `- status toasts enabled: ${status.configuration.statusToast ? 'yes' : 'no'}`,
    '',
    'Background processing runtime',
    `- consolidation timer active: ${status.runtime?.consolidationTimerActive ? 'yes' : 'no'}`,
    `- sessions queued for idle processing: ${status.runtime?.scheduledSessions ?? 0}`,
    `- sessions actively processing: ${status.runtime?.activeSessions ?? 0}`,
    `- internal SDK sessions active: ${status.runtime?.internalSessions ?? 0}`,
    '',
    'Generated artifacts',
    `- shared database: ${status.storage.dbFile}`,
    `- memories: ${status.memoryCount} -> ${status.storage.memoryFile}`,
    `- insights: ${status.insightCount} -> ${status.storage.insightsFile}`,
    `- docs: ${status.docsCount} -> ${status.storage.docsFile}`,
    `- state: ${status.storage.stateFile}`,
    `- status: ${status.storage.statusFile}`,
    '',
    'Recent generated examples',
    ...(recentMemories.length > 0 ? recentMemories.map((line) => `- memory ${line}`) : ['- memory none yet']),
    ...(recentInsights.length > 0 ? recentInsights.map((line) => `- insight ${line}`) : ['- insight none yet']),
    ...(recentDocs.length > 0 ? recentDocs.map((line) => `- doc ${line}`) : ['- doc none yet']),
    '',
    'How to verify it is working',
    '- Ask OpenCode to run `memory_status` after the session has gone idle.',
    '- Open the generated files above and confirm counts, timestamps, and recent entries match your recent work.',
    '- Run `memory_backfill` for older sessions, `memory_consolidate` for a fresh cross-session pass, or `memory_refresh_docs` if docs changed.',
    '',
    'How to judge whether retrieval is useful',
    '- Ask `memory_query` a project-specific question you already know the answer to and check whether it cites relevant [Memory:*], [Insight:*], or [Doc:*] evidence.',
    '- Use the answer as context for a new task prompt, for example: "Run `memory_query` for prior decisions about auth, summarize the result, then use it before planning this refactor."',
    '- If the answer is weak, stale, or missing citations, refresh docs, backfill recent sessions, run consolidation again, and retry the same query.',
    '',
    'Machine-readable snapshot',
    JSON.stringify(status, null, 2)
  ].join('\n');
}

function isProtectedEnvPath(filePath) {
  return /(^|\/)\.env(\.[^/]+)?$/i.test(String(filePath ?? '').replace(/\\/g, '/'));
}

function unwrapData(response) {
  if (Array.isArray(response)) {
    return response;
  }
  if (response?.data !== undefined) {
    return response.data;
  }
  return response;
}

export async function createMemoryAgentPlugin({ client, directory, worktree }) {
  const projectRoot = worktree ?? directory;
  const config = await loadPluginConfig(projectRoot);
  const timers = new Map();
  const activeSessions = new Set();
  const internalSessions = new Set();
  let consolidationTimer;
  let startupTasksScheduled = false;
  let docsRefreshInProgress = false;
  let consolidationInProgress = false;
  let backfillInProgress = false;

  await ensureStore(config);

  const log = async (level, message, extra = {}) => {
    await client.app.log({
      body: {
        service: 'opencode-memory-agent',
        level,
        message,
        extra
      }
    });
  };

  const showToast = async (message, variant = 'info') => {
    if (!config.statusToast || !client.tui?.showToast) {
      return;
    }

    try {
      await client.tui.showToast({ body: { message, variant } });
    } catch {
      // Not all environments expose the TUI transport.
    }
  };

  const currentActivity = () => {
    if (!startupTasksScheduled) {
      return 'starting';
    }
    if (backfillInProgress) {
      return 'backfilling';
    }
    if (consolidationInProgress) {
      return 'consolidating';
    }
    if (docsRefreshInProgress) {
      return 'refreshing-docs';
    }
    if (activeSessions.size > 0) {
      return 'processing-session';
    }
    if (timers.size > 0) {
      return 'waiting-for-idle';
    }
    return 'idle';
  };

  const syncRuntimeStatus = async (extra = {}) => {
    await updateStatus(config, (status) => ({
      ...status,
      lastActivityAt: new Date().toISOString(),
      currentActivity: currentActivity(),
      runtime: {
        ...(status.runtime ?? {}),
        activeSessions: activeSessions.size,
        scheduledSessions: timers.size,
        internalSessions: internalSessions.size,
        consolidationTimerActive: Boolean(consolidationTimer)
      },
      ...extra
    }));
  };

  const markFailure = async (error, extra = {}) => {
    await syncRuntimeStatus({
      healthy: false,
      lastError: error instanceof Error ? error.message : String(error),
      ...extra
    });
  };

  const refreshDocs = async (reason = 'manual') => {
    if (!config.docs.enabled) {
      return { refreshed: false, reason: 'docs-disabled' };
    }

    docsRefreshInProgress = true;
    await syncRuntimeStatus({ lastError: null, healthy: true });
    try {
      const docs = await scanProjectDocs(config);
      await replaceDocs(config, docs);
      await updateState(config, (state) => ({
        ...state,
        docs: Object.fromEntries(docs.map((doc) => [doc.path, doc.contentHash])),
        lastDocsRefreshAt: new Date().toISOString()
      }));
      await updateStatus(config, (status) => ({
        ...status,
        lastDocsRefreshAt: new Date().toISOString(),
        lastDocsRefreshCount: docs.length,
        docsCount: docs.length,
        healthy: true,
        lastError: null
      }));
      await log('info', 'Project docs indexed', { reason, docsCount: docs.length, projectRoot: config.projectRoot });
      return { refreshed: true, docsCount: docs.length };
    } catch (error) {
      await markFailure(error);
      throw error;
    } finally {
      docsRefreshInProgress = false;
      await syncRuntimeStatus();
    }
  };

  const consolidateMemories = async (reason = 'scheduled') => {
    consolidationInProgress = true;
    await syncRuntimeStatus({ lastError: null, healthy: true });
    try {
      const memories = await readMemories(config);
      const insights = await consolidateMemoryEntries({
        client,
        config,
        internalSessions,
        memories: memories.memories
      });
      await replaceInsights(config, insights);
      await updateState(config, (state) => ({
        ...state,
        lastConsolidationAt: new Date().toISOString()
      }));
      await updateStatus(config, (status) => ({
        ...status,
        lastConsolidationAt: new Date().toISOString(),
        lastConsolidationGenerated: insights.length,
        insightCount: insights.length,
        healthy: true,
        lastError: null
      }));
      await log('info', 'Memory consolidation completed', {
        reason,
        memories: memories.memories.length,
        insights: insights.length,
        everyMinutes: config.consolidateEveryMinutes
      });
      return { consolidated: insights.length, memories: memories.memories.length };
    } catch (error) {
      await markFailure(error);
      throw error;
    } finally {
      consolidationInProgress = false;
      await syncRuntimeStatus();
    }
  };

  const processSession = async (sessionId, reason, force = false) => {
    if (!sessionId || internalSessions.has(sessionId)) {
      return { processed: false, reason: 'internal-session' };
    }

    if (activeSessions.has(sessionId)) {
      return { processed: false, reason: 'already-processing' };
    }

    activeSessions.add(sessionId);
    await syncRuntimeStatus({ lastError: null, healthy: true });
    try {
      const [sessionResponse, messageResponse, state] = await Promise.all([
        client.session.get({ path: { id: sessionId } }),
        client.session.messages({ path: { id: sessionId } }),
        readState(config)
      ]);
      const session = unwrapData(sessionResponse);
      const { transcript, messageCount } = flattenSessionMessages(messageResponse, config);
      const { referencedFiles, contentHash } = await enrichTranscriptWithReferencedFiles(transcript, config);

      if (!transcript.trim()) {
        await log('debug', 'Skipping empty session transcript', { sessionId, reason });
        return { processed: false, reason: 'empty-transcript' };
      }

      const previous = state.processedSessions?.[sessionId];
      if (!force && previous?.contentHash === contentHash) {
        await log('debug', 'Skipping unchanged session', { sessionId, reason });
        return { processed: false, reason: 'unchanged' };
      }

      const entry = await createMemoryEntry({
        client,
        config,
        internalSessions,
        sessionId,
        title: session?.title,
        transcript,
        contentHash,
        messageCount,
        referencedFiles
      });

      await upsertMemory(config, entry);
      await updateState(config, (current) => ({
        ...current,
        processedSessions: {
          ...(current.processedSessions ?? {}),
          [sessionId]: {
            title: session?.title ?? sessionId,
            processedAt: new Date().toISOString(),
            contentHash,
            messageCount
          }
        },
        lastMemoryRunAt: new Date().toISOString()
      }));
      const status = await getStatus(config);
      await updateStatus(config, {
        ...status,
        lastRun: new Date().toISOString(),
        lastEvent: reason,
        healthy: true,
        lastError: null
      });
      await log('info', 'Session memory captured', {
        sessionId,
        reason,
        memorySummary: entry.summary,
        entities: entry.entities.length,
        facts: entry.facts.length,
        todos: entry.todos.length,
        fileReferences: entry.fileReferences.length,
        importance: entry.importance
      });
      await showToast(`Memory updated for session ${session?.title ?? sessionId}`, 'success');
      return { processed: true, sessionId, summary: entry.summary };
    } catch (error) {
      await markFailure(error);
      throw error;
    } finally {
      activeSessions.delete(sessionId);
      const existingTimer = timers.get(sessionId);
      if (existingTimer) {
        clearTimeout(existingTimer);
        timers.delete(sessionId);
      }
      await syncRuntimeStatus();
    }
  };

  const backfillSessions = async (limit = config.maxBackfillSessions) => {
    backfillInProgress = true;
    await syncRuntimeStatus({ lastError: null, healthy: true });
    try {
      const listed = unwrapData(await client.session.list()) ?? [];
      const state = await readState(config);
      let processed = 0;

      for (const session of listed) {
        if (processed >= limit) {
          break;
        }
        if (!session?.id || internalSessions.has(session.id) || String(session.title ?? '').startsWith(INTERNAL_SESSION_PREFIX)) {
          continue;
        }
        const result = await processSession(session.id, 'backfill', false);
        if (result.processed) {
          processed += 1;
        }
      }

      await updateState(config, (current) => ({
        ...current,
        lastBackfillAt: new Date().toISOString(),
        processedSessions: current.processedSessions ?? state.processedSessions ?? {}
      }));
      const status = await getStatus(config);
      await updateStatus(config, {
        ...status,
        lastBackfillAt: new Date().toISOString(),
        lastBackfillProcessed: processed,
        healthy: true,
        lastError: null
      });
      await log('info', 'Session backfill completed', { processed, limit });
      return { processed, limit };
    } catch (error) {
      await markFailure(error);
      throw error;
    } finally {
      backfillInProgress = false;
      await syncRuntimeStatus();
    }
  };

  const scheduleSession = (sessionId, reason) => {
    const existingTimer = timers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(() => {
      processSession(sessionId, reason).catch(async (error) => {
        await log('error', 'Session memory processing failed', {
          sessionId,
          reason,
          error: error instanceof Error ? error.message : String(error)
        });
      });
    }, config.debounceMs);

    timers.set(sessionId, timer);
    syncRuntimeStatus().catch((error) => {
      log('debug', 'Failed to update runtime status for scheduled session (non-critical)', {
        sessionId,
        error: error instanceof Error ? error.message : String(error)
      }).catch((logError) => {
        console.error('opencode-memory-agent failed to record scheduled session status', logError);
      });
    });
  };

  const ensureStartupTasks = async () => {
    if (startupTasksScheduled) {
      return;
    }
    startupTasksScheduled = true;
    await updateStatus(config, {
      ...(await getStatus(config)),
      initializedAt: new Date().toISOString(),
      healthy: true,
      lastError: null
    });
    await log('info', 'OpenCode memory agent initialized', {
      projectRoot: config.projectRoot,
      storage: config.paths,
      debounceMs: config.debounceMs,
      consolidateEveryMinutes: config.consolidateEveryMinutes
    });

    if (config.docs.enabled && config.docs.autoRefreshOnStartup) {
      await refreshDocs('startup');
    }
    if (config.backfillOnStartup) {
      await backfillSessions(config.maxBackfillSessions);
    }
    if (config.consolidateOnStartup) {
      await consolidateMemories('startup');
    }
    if (config.consolidateEveryMinutes > 0 && !consolidationTimer) {
      consolidationTimer = setInterval(() => {
        consolidateMemories('scheduled').catch(async (error) => {
          await log('error', 'Scheduled memory consolidation failed', {
            error: error instanceof Error ? error.message : String(error)
          });
        });
      }, config.consolidateEveryMinutes * 60 * 1000);
      // Allow the hosting process to exit naturally if this timer is the only remaining work.
      consolidationTimer.unref?.();
    }
    await syncRuntimeStatus();
  };

  return {
    event: async ({ event }) => {
      if (!config.enabled || process.env.OPENCODE_MEMORY_AGENT_CHILD === '1') {
        return;
      }

      if (!RELEVANT_EVENTS.has(event.type)) {
        return;
      }

      await syncRuntimeStatus({
        lastEvent: event.type,
        healthy: true
      });

      if (event.type === 'server.connected') {
        await ensureStartupTasks();
        return;
      }

      const sessionId = event.properties?.sessionID ?? event.properties?.sessionId;
      const canScheduleSessionProcessing =
        Boolean(sessionId) &&
        !internalSessions.has(sessionId) &&
        event.type !== 'file.edited' &&
        config.processSessionIdle;

      if (canScheduleSessionProcessing) {
        scheduleSession(sessionId, event.type);
      }

      if (event.type === 'file.edited' && config.docs.enabled && config.docs.autoRefreshOnEdit) {
        const filePath = event.properties?.filePath ?? event.properties?.path ?? '';
        const relativePath = filePath ? relative(config.projectRoot, String(filePath)).replace(/\\/g, '/') : '';
        if (relativePath && !relativePath.startsWith('..') && isProjectDocPath(relativePath, config.docs.include)) {
          await refreshDocs('file.edited');
        }
      }
    },
    tool: {
      memory_status: tool({
        description: 'Show configuration, runtime health, last-run activity, generated artifacts, and verification guidance for opencode-memory-agent.',
        args: {},
        async execute() {
          const [status, memories, insights, docs] = await Promise.all([
            getStatus(config),
            readMemories(config),
            readInsights(config),
            readDocs(config)
          ]);
          return buildStatusReport({ status, memories, insights, docs });
        }
      }),
      memory_backfill: tool({
        description: 'Process existing OpenCode sessions into the memory store.',
        args: {
          limit: tool.schema.number().optional(),
          refresh_docs: tool.schema.boolean().optional()
        },
        async execute(args) {
          if (args.refresh_docs) {
            await refreshDocs('memory_backfill');
          }
          const result = await backfillSessions(args.limit ?? config.maxBackfillSessions);
          return `Backfill complete. Processed ${result.processed} session(s) with limit ${result.limit}.`;
        }
      }),
      memory_consolidate: tool({
        description: 'Consolidate stored memories into cross-cutting insights, like the Gemini reference project does on its timer.',
        args: {},
        async execute() {
          const result = await consolidateMemories('manual');
          return `Consolidation complete. Processed ${result.memories} memory entries into ${result.consolidated} insight items.`;
        }
      }),
      memory_query: tool({
        description: 'Answer a question from the stored memory entries and indexed project docs.',
        args: {
          question: tool.schema.string()
        },
        async execute(args) {
          const [memories, insights, docs] = await Promise.all([readMemories(config), readInsights(config), readDocs(config)]);
          return answerMemoryQuery({
            client,
            config,
            internalSessions,
            question: args.question,
            memories: memories.memories,
            insights: insights.insights,
            docs: docs.docs
          });
        }
      }),
      memory_refresh_docs: tool({
        description: 'Scan project docs and refresh the indexed docs store used by memory queries.',
        args: {},
        async execute() {
          const result = await refreshDocs('manual');
          return result.refreshed
            ? `Indexed ${result.docsCount} project doc file(s).`
            : 'Project docs indexing is disabled.';
        }
      })
    },
    'tool.execute.before': async (input, context) => {
      if (input.tool === 'read' && isProtectedEnvPath(context.args?.filePath)) {
        throw new Error('opencode-memory-agent refuses to read .env files directly.');
      }
    }
  };
}

export default createMemoryAgentPlugin;
