const RELEVANT_EVENTS = new Set(['session.idle', 'file.edited', 'message.updated', 'todo.updated']);
const DEFAULT_DEBOUNCE_MS = 15000;

export const MemoryAgentPlugin = async ({ client, directory }) => {
  const timers = new Map();
  const activeSessions = new Set();

  const log = async (level, message, extra = {}) => {
    await client.app.log({
      body: {
        service: 'opencode-memory-agent',
        level,
        message,
        extra,
      },
    });
  };

  const schedule = (sessionId, reason) => {
    const existingTimer = timers.get(sessionId);
    if (existingTimer) {
      clearTimeout(existingTimer);
    }

    const timer = setTimeout(async () => {
      if (activeSessions.has(sessionId)) {
        await log('debug', 'Skipping duplicate memory pass', { sessionId, reason });
        return;
      }

      activeSessions.add(sessionId);

      try {
        await log('info', 'Memory processing requested', {
          directory,
          sessionId,
          reason,
          note: 'Hand off to memory-orchestrator via the SDK or a guarded Bun subprocess.',
        });
      } finally {
        activeSessions.delete(sessionId);
        timers.delete(sessionId);
      }
    }, DEFAULT_DEBOUNCE_MS);

    timers.set(sessionId, timer);
  };

  return {
    event: async ({ event }) => {
      if (process.env.OPENCODE_MEMORY_AGENT_CHILD === '1') {
        return;
      }

      if (!RELEVANT_EVENTS.has(event.type)) {
        return;
      }

      const sessionId = event.properties?.sessionID ?? event.properties?.sessionId;
      if (!sessionId) {
        return;
      }

      schedule(sessionId, event.type);
    },
    'tool.execute.before': async (input, output) => {
      if (input.tool === 'read' && output.args.filePath?.includes('.env')) {
        throw new Error('The memory agent should not read .env files directly.');
      }
    },
  };
};

export default MemoryAgentPlugin;
