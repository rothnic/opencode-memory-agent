import { createHash } from 'node:crypto';
import { parseModel } from './config.js';

const ROLE_PREFIX = /^(USER|ASSISTANT|SYSTEM):\s*/i;
const INTERNAL_SESSION_PREFIX = '[opencode-memory-agent]';
const MAX_QUERY_MEMORIES = 8;
const MAX_QUERY_DOCS = 8;

function unwrapData(response) {
  if (Array.isArray(response)) {
    return response;
  }
  if (response?.data !== undefined) {
    return response.data;
  }
  return response;
}

function extractTextParts(parts) {
  if (!Array.isArray(parts)) {
    return [];
  }

  const values = [];
  for (const part of parts) {
    if (!part || typeof part !== 'object') {
      continue;
    }
    if (part.type === 'text' && typeof part.text === 'string') {
      values.push(part.text);
    }
  }
  return values;
}

export function flattenSessionMessages(messagePayload, config) {
  const messages = unwrapData(messagePayload) ?? [];
  const recentMessages = messages.slice(-config.maxMessagesPerSession);

  const transcriptLines = recentMessages.flatMap((message) => {
    const info = message.info ?? message;
    const role = info.role ?? info.type ?? 'unknown';
    const parts = message.parts ?? info.parts ?? [];
    const texts = extractTextParts(parts);
    if (texts.length === 0) {
      return [];
    }
    return texts.map((text) => `${role.toUpperCase()}: ${text}`);
  });

  const transcriptChars = Array.from(transcriptLines.join('\n'));
  const normalizedTranscript = transcriptChars.slice(-config.maxTranscriptChars).join('');
  return {
    transcript: normalizedTranscript,
    messageCount: recentMessages.length,
    contentHash: createHash('sha256').update(normalizedTranscript).digest('hex')
  };
}

function buildMemoryPrompt(sessionId, transcript) {
  return [
    'You are the persistent memory processor for an OpenCode project.',
    'Extract only durable, project-relevant memory from the following session transcript.',
    'Do not include secrets, API keys, raw credentials, or .env values.',
    'Return concise facts, decisions, TODOs, and topics that would help a future session.',
    '',
    `Session ID: ${sessionId}`,
    'Transcript:',
    transcript
  ].join('\n');
}

function buildQueryPrompt(question, memories, docs) {
  return [
    'You answer questions using a curated memory store for an OpenCode project.',
    'Prefer the provided memory entries and project docs. If the answer is incomplete, say so.',
    '',
    `Question: ${question}`,
    '',
    'Memories:',
    JSON.stringify(memories, null, 2),
    '',
    'Project docs:',
    JSON.stringify(docs, null, 2)
  ].join('\n');
}

function buildMemorySchema() {
  return {
    type: 'object',
    properties: {
      summary: { type: 'string', description: 'One concise summary of the durable session memory.' },
      facts: { type: 'array', items: { type: 'string' }, description: 'Durable facts to remember.' },
      decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions or confirmed plans.' },
      todos: { type: 'array', items: { type: 'string' }, description: 'Outstanding TODO items.' },
      topics: { type: 'array', items: { type: 'string' }, description: 'Topics relevant to later retrieval.' }
    },
    required: ['summary', 'facts', 'decisions', 'todos', 'topics']
  };
}

function parseStructuredOutput(response) {
  return (
    response?.data?.info?.structured_output ??
    response?.info?.structured_output ??
    response?.data?.structured_output ??
    null
  );
}

function extractAssistantText(response) {
  const payload = unwrapData(response);
  if (payload?.parts) {
    return extractTextParts(payload.parts).join('\n');
  }
  if (payload?.info?.parts) {
    return extractTextParts(payload.info.parts).join('\n');
  }
  return '';
}

async function withInternalSession({ client, internalSessions, title, model, task }) {
  const created = await client.session.create({ body: { title } });
  const session = unwrapData(created);
  const sessionId = session.id;
  internalSessions.add(sessionId);

  try {
    return await task(sessionId, model);
  } finally {
    internalSessions.delete(sessionId);
    try {
      await client.session.delete({ path: { id: sessionId } });
    } catch {
      // Best-effort cleanup only.
    }
  }
}

export async function createMemoryEntry({ client, config, internalSessions, sessionId, title, transcript, contentHash, messageCount }) {
  const model = parseModel(config.model);

  try {
    const structured = await withInternalSession({
      client,
      internalSessions,
      title: `${INTERNAL_SESSION_PREFIX} summarize ${sessionId}`,
      model,
      task: async (internalSessionId, selectedModel) => {
        const body = {
          parts: [{ type: 'text', text: buildMemoryPrompt(sessionId, transcript) }],
          format: { type: 'json_schema', schema: buildMemorySchema(), retryCount: 1 }
        };
        if (selectedModel) {
          body.model = selectedModel;
        }
        const response = await client.session.prompt({ path: { id: internalSessionId }, body });
        return parseStructuredOutput(response);
      }
    });

    if (structured) {
      return {
        id: `session:${sessionId}`,
        source: 'session',
        sessionId,
        title: title ?? sessionId,
        summary: structured.summary,
        facts: structured.facts,
        decisions: structured.decisions,
        todos: structured.todos,
        topics: structured.topics,
        updatedAt: new Date().toISOString(),
        contentHash,
        messageCount
      };
    }
  } catch {
    // Fall back to a deterministic heuristic representation.
  }

  const heuristicLines = transcript
    .split(/\r?\n/)
    .map((line) => line.replace(ROLE_PREFIX, '').trim())
    .filter(Boolean);

  return {
    id: `session:${sessionId}`,
    source: 'session',
    sessionId,
    title: title ?? sessionId,
    summary: heuristicLines.slice(0, 4).join(' ').slice(0, 400),
    facts: heuristicLines.slice(0, 6),
    decisions: heuristicLines.filter((line) => /decid|ship|use|choose|agreed/i.test(line)).slice(0, 6),
    todos: heuristicLines.filter((line) => /todo|next|follow up|need to|should/i.test(line)).slice(0, 6),
    topics: heuristicLines
      .flatMap((line) => line.split(/[^A-Za-z0-9_-]+/))
      .filter((word) => word.length > 4)
      .slice(0, 12),
    updatedAt: new Date().toISOString(),
    contentHash,
    messageCount
  };
}

export async function answerMemoryQuery({ client, config, internalSessions, question, memories, docs }) {
  const selectedMemories = memories.slice(0, MAX_QUERY_MEMORIES);
  const selectedDocs = docs.slice(0, MAX_QUERY_DOCS);
  const model = parseModel(config.model);

  try {
    return await withInternalSession({
      client,
      internalSessions,
      title: `${INTERNAL_SESSION_PREFIX} query`,
      model,
      task: async (sessionId, selectedModel) => {
        const body = {
          parts: [{ type: 'text', text: buildQueryPrompt(question, selectedMemories, selectedDocs) }]
        };
        if (selectedModel) {
          body.model = selectedModel;
        }
        const response = await client.session.prompt({ path: { id: sessionId }, body });
        const text = extractAssistantText(response);
        return text || 'No answer could be generated from the current memory store.';
      }
    });
  } catch {
    return [
      `Question: ${question}`,
      '',
      'Top stored memories:',
      ...selectedMemories.map((entry) => `- ${entry.summary}`),
      '',
      'Top indexed docs:',
      ...selectedDocs.map((entry) => `- ${entry.path}: ${entry.title}`)
    ].join('\n');
  }
}
