import { createHash } from 'node:crypto';
import { open, stat } from 'node:fs/promises';
import { extname, resolve, relative } from 'node:path';
import { parseModel } from './config.js';

const ROLE_PREFIX = /^(USER|ASSISTANT|SYSTEM):\s*/i;
const INTERNAL_SESSION_PREFIX = '[opencode-memory-agent]';
const MAX_QUERY_MEMORIES = 8;
const MAX_CONSOLIDATION_MEMORIES = 24;
const MAX_QUERY_DOCS = 8;
const ENTITY_FILTER_WORDS = new Set(['The', 'This', 'That', 'These', 'Those', 'We', 'It', 'They', 'You']);
const MEDIUM_IMPORTANCE_LINE_THRESHOLD = 3;
const HIGH_IMPORTANCE_LINE_THRESHOLD = 6;
const LOW_IMPORTANCE_SCORE = 0.4;
const MEDIUM_IMPORTANCE_SCORE = 0.6;
const HIGH_IMPORTANCE_SCORE = 0.8;
const MAX_QUERY_CANDIDATES = 8;
const MAX_REFERENCED_FILES = 3;
const MAX_REFERENCED_FILE_BYTES = 4000;
const MIN_TOKEN_LENGTH = 2;
const SIGNIFICANT_TOKEN_LENGTH = 6;
const SIGNIFICANT_TOKEN_WEIGHT = 2;
const REGULAR_TOKEN_WEIGHT = 1;
// Date.now() is milliseconds since epoch (~1e12), so dividing by 1e15 keeps recency as a tiny
// decimal tie-breaker that never outweighs a real token match score.
const TIMESTAMP_NORMALIZATION_FACTOR = 1e15;
const BINARY_EXTENSIONS = new Set([
  '.png',
  '.jpg',
  '.jpeg',
  '.gif',
  '.webp',
  '.bmp',
  '.svg',
  '.mp3',
  '.wav',
  '.ogg',
  '.flac',
  '.m4a',
  '.aac',
  '.mp4',
  '.webm',
  '.mov',
  '.avi',
  '.mkv',
  '.pdf',
  '.zip',
  '.gz',
  '.tar',
  '.tgz',
  '.jar',
  '.exe',
  '.dll',
  '.so',
  '.dylib'
]);
const FILE_REFERENCE_PATTERN = /(?:^|[\s("'`])((?:\.{1,2}\/)?(?:[\w@-]+\/)*[\w@.-]+\.[A-Za-z0-9_-]+)(?=$|[\s)"'`:,])/gm;

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

function buildMemoryPrompt(sessionId, transcript, referencedFiles = []) {
  const sections = [
    'You are the IngestAgent for an OpenCode project memory system.',
    'Extract only durable, project-relevant memory from the following session transcript.',
    'Do not include secrets, API keys, raw credentials, or .env values.',
    'Use any referenced project file excerpts as supporting context when they clarify the work discussed in the session.',
    'Return a concise summary, entities, topics, importance, durable facts, decisions, TODOs, and file references that would help a future session.',
    '',
    `Session ID: ${sessionId}`,
    'Transcript:',
    transcript
  ];

  if (referencedFiles.length > 0) {
    sections.push('', 'Referenced project files:');
    for (const file of referencedFiles) {
      sections.push(`File: ${file.path}`);
      sections.push(file.excerpt);
      sections.push('');
    }
  }

  return sections.join('\n');
}

function buildConsolidationPrompt(memories) {
  return [
    'You are the ConsolidateAgent for an OpenCode project memory system.',
    'Review these stored memory entries and produce cross-cutting insights, notable connections, and recommended focus areas.',
    'Prefer durable themes over ephemeral details. Do not include secrets or credentials.',
    '',
    'Stored memories:',
    JSON.stringify(memories, null, 2)
  ].join('\n');
}

function formatInsightItems(structured) {
  return [
    ...structured.insights.map((summary, index) => ({
      id: `insight:${index + 1}`,
      kind: 'insight',
      summary,
      updatedAt: new Date().toISOString()
    })),
    ...structured.connections.map((summary, index) => ({
      id: `connection:${index + 1}`,
      kind: 'connection',
      summary,
      updatedAt: new Date().toISOString()
    })),
    ...structured.focusAreas.map((summary, index) => ({
      id: `focus:${index + 1}`,
      kind: 'focus',
      summary,
      updatedAt: new Date().toISOString()
    }))
  ];
}

function buildQueryPrompt(question, memories, insights, docs) {
  return [
    'You are the QueryAgent for an OpenCode project memory system.',
    'Answer the question using the provided memory entries, consolidation insights, and project docs.',
    'When you cite evidence, cite it inline as [Memory:session-id], [Insight:index], or [Doc:path]. If the answer is incomplete, say so.',
    '',
    `Question: ${question}`,
    '',
    'Memories:',
    JSON.stringify(memories, null, 2),
    '',
    'Insights:',
    JSON.stringify(insights, null, 2),
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
      entities: { type: 'array', items: { type: 'string' }, description: 'People, systems, products, or orgs mentioned.' },
      facts: { type: 'array', items: { type: 'string' }, description: 'Durable facts to remember.' },
      decisions: { type: 'array', items: { type: 'string' }, description: 'Decisions or confirmed plans.' },
      todos: { type: 'array', items: { type: 'string' }, description: 'Outstanding TODO items.' },
      topics: { type: 'array', items: { type: 'string' }, description: 'Topics relevant to later retrieval.' },
      importance: { type: 'number', description: 'A normalized importance score between 0 and 1.' },
      fileReferences: {
        type: 'array',
        items: { type: 'string' },
        description: 'Project file paths that materially informed this memory, if any.'
      }
    },
    required: ['summary', 'entities', 'facts', 'decisions', 'todos', 'topics', 'importance', 'fileReferences']
  };
}

function buildInsightSchema() {
  return {
    type: 'object',
    properties: {
      insights: { type: 'array', items: { type: 'string' }, description: 'High-level insights spanning multiple memories.' },
      connections: {
        type: 'array',
        items: { type: 'string' },
        description: 'Important relationships or recurring patterns between memories.'
      },
      focusAreas: {
        type: 'array',
        items: { type: 'string' },
        description: 'Recommended next focus areas based on the consolidated memory.'
      }
    },
    required: ['insights', 'connections', 'focusAreas']
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

function extractCandidateFileReferences(transcript) {
  const references = new Set();
  for (const match of transcript.matchAll(FILE_REFERENCE_PATTERN)) {
    const value = match[1]?.trim();
    if (!value || value.includes('://')) {
      continue;
    }
    references.add(value.replace(/^[("'`]+|[)"'`]+$/g, ''));
  }
  return [...references];
}

function isProtectedOrGeneratedPath(relativePath) {
  const normalized = String(relativePath ?? '').replace(/\\/g, '/');
  return (
    /(^|\/)\.env(\.[^/]+)?$/i.test(normalized) ||
    normalized.startsWith('.opencode/memory/private/') ||
    normalized.startsWith('.opencode/memory/shared/')
  );
}

function isTextLikeReference(filePath) {
  return !BINARY_EXTENSIONS.has(extname(filePath).toLowerCase());
}

async function readReferencedFiles(transcript, config) {
  const references = extractCandidateFileReferences(transcript);
  const resolved = [];
  const hash = createHash('sha256');

  for (const reference of references) {
    if (resolved.length >= MAX_REFERENCED_FILES) {
      break;
    }

    const absolutePath = resolve(config.projectRoot, reference);
    const relativePath = relative(config.projectRoot, absolutePath).replace(/\\/g, '/');
    if (!relativePath || relativePath.startsWith('..') || isProtectedOrGeneratedPath(relativePath) || !isTextLikeReference(relativePath)) {
      continue;
    }

    try {
      const fileStats = await stat(absolutePath);
      if (!fileStats.isFile()) {
        continue;
      }
      const handle = await open(absolutePath, 'r');
      const buffer = Buffer.alloc(MAX_REFERENCED_FILE_BYTES);
      let bytesRead = 0;
      try {
        ({ bytesRead } = await handle.read(buffer, 0, MAX_REFERENCED_FILE_BYTES, 0));
      } finally {
        await handle.close();
      }
      const excerpt = buffer.subarray(0, bytesRead).toString('utf8');
      if (!excerpt.trim()) {
        continue;
      }
      const record = {
        path: relativePath,
        excerpt,
        updatedAt: fileStats.mtime.toISOString()
      };
      resolved.push(record);
      hash.update(relativePath);
      hash.update(excerpt);
      hash.update(record.updatedAt);
    } catch {
      // Ignore referenced paths that are missing, binary, or unreadable.
    }
  }

  return {
    files: resolved,
    contentHashSuffix: resolved.length > 0 ? hash.digest('hex') : ''
  };
}

function tokenize(value) {
  // Keep common file-path separators so questions about specific files can match entries that
  // mention paths like `src/index.js`; drop very short fragments to reduce noisy matches.
  return String(value ?? '')
    .toLowerCase()
    .split(/[^a-z0-9_./-]+/)
    .filter((token) => token.length > MIN_TOKEN_LENGTH);
}

function scoreCandidate(questionTokens, textTokens, recencyValue = '') {
  if (questionTokens.length === 0 || textTokens.length === 0) {
    return 0;
  }

  const tokenSet = new Set(textTokens);
  let score = 0;
  for (const token of questionTokens) {
    if (tokenSet.has(token)) {
      score += token.length > SIGNIFICANT_TOKEN_LENGTH ? SIGNIFICANT_TOKEN_WEIGHT : REGULAR_TOKEN_WEIGHT;
    }
  }

  if (score === 0) {
    return 0;
  }

  return score + (recencyValue ? Date.parse(recencyValue) / TIMESTAMP_NORMALIZATION_FACTOR : 0);
}

function selectRelevantEntries(entries, question, textExtractor, limit) {
  // Prefer explicit token overlap first, then use a tiny recency tie-breaker so similarly
  // relevant entries lean toward fresher records without overpowering the text match.
  const questionTokens = tokenize(question);
  const ranked = entries
    .map((entry) => ({
      entry,
      score: scoreCandidate(questionTokens, tokenize(textExtractor(entry)), entry.updatedAt)
    }))
    .sort((a, b) => b.score - a.score);

  const withHits = ranked.filter((item) => item.score > 0).slice(0, limit).map((item) => item.entry);
  if (withHits.length > 0) {
    return withHits;
  }
  return entries.slice(0, limit);
}

export async function createMemoryEntry({
  client,
  config,
  internalSessions,
  sessionId,
  title,
  transcript,
  contentHash,
  messageCount,
  referencedFiles = []
}) {
  const model = parseModel(config.model);

  try {
    const structured = await withInternalSession({
      client,
      internalSessions,
      title: `${INTERNAL_SESSION_PREFIX} summarize ${sessionId}`,
      model,
      task: async (internalSessionId, selectedModel) => {
        const body = {
          parts: [{ type: 'text', text: buildMemoryPrompt(sessionId, transcript, referencedFiles) }],
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
        entities: structured.entities,
        facts: structured.facts,
        decisions: structured.decisions,
        todos: structured.todos,
        topics: structured.topics,
        fileReferences: structured.fileReferences,
        importance: structured.importance,
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
    entities: heuristicLines
      .flatMap((line) => line.match(/\b[A-Z][A-Za-z]{2,}(?:[A-Za-z0-9_-]+)?\b/g) ?? [])
      .filter((entity) => !ENTITY_FILTER_WORDS.has(entity))
      .slice(0, 8),
    facts: heuristicLines.slice(0, 6),
    decisions: heuristicLines.filter((line) => /decid|ship|use|choose|agreed/i.test(line)).slice(0, 6),
    todos: heuristicLines.filter((line) => /todo|next|follow up|need to|should/i.test(line)).slice(0, 6),
    topics: heuristicLines
      .flatMap((line) => line.split(/[^A-Za-z0-9_-]+/))
      .filter((word) => word.length > 4)
      .slice(0, 12),
    fileReferences: referencedFiles.map((file) => file.path),
    importance:
      heuristicLines.length > HIGH_IMPORTANCE_LINE_THRESHOLD
        ? HIGH_IMPORTANCE_SCORE
        : heuristicLines.length > MEDIUM_IMPORTANCE_LINE_THRESHOLD
          ? MEDIUM_IMPORTANCE_SCORE
          : LOW_IMPORTANCE_SCORE,
    updatedAt: new Date().toISOString(),
    contentHash,
    messageCount
  };
}

export function buildConsolidationFallback(memories) {
  const selectedMemories = memories.slice(0, MAX_CONSOLIDATION_MEMORIES);
  const topicCounts = new Map();
  const focusAreas = [];

  for (const memory of selectedMemories) {
    for (const topic of memory.topics ?? []) {
      topicCounts.set(topic, (topicCounts.get(topic) ?? 0) + 1);
    }
    for (const todo of memory.todos ?? []) {
      if (focusAreas.length < 6) {
        focusAreas.push(todo);
      }
    }
  }

  const commonTopics = [...topicCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([topic, count]) => `${topic} (${count})`);

  return {
    insights: commonTopics.length > 0 ? [`Recurring topics: ${commonTopics.join(', ')}`] : [],
    connections: selectedMemories.slice(0, 4).map((memory) => `${memory.id} -> ${memory.summary}`),
    focusAreas: focusAreas.slice(0, 5)
  };
}

export async function consolidateMemoryEntries({ client, config, internalSessions, memories }) {
  const selectedMemories = memories.slice(0, MAX_CONSOLIDATION_MEMORIES);
  const model = parseModel(config.model);

  if (selectedMemories.length === 0) {
    return [];
  }

  try {
    const structured = await withInternalSession({
      client,
      internalSessions,
      title: `${INTERNAL_SESSION_PREFIX} consolidate`,
      model,
      task: async (sessionId, selectedModel) => {
        const body = {
          parts: [{ type: 'text', text: buildConsolidationPrompt(selectedMemories) }],
          format: { type: 'json_schema', schema: buildInsightSchema(), retryCount: 1 }
        };
        if (selectedModel) {
          body.model = selectedModel;
        }
        const response = await client.session.prompt({ path: { id: sessionId }, body });
        return parseStructuredOutput(response);
      }
    });

    if (structured) {
      return formatInsightItems(structured);
    }
  } catch {
    // Fall back to deterministic consolidation.
  }

  const fallback = buildConsolidationFallback(selectedMemories);
  return formatInsightItems(fallback);
}

export async function answerMemoryQuery({ client, config, internalSessions, question, memories, insights, docs }) {
  const selectedMemories = selectRelevantEntries(
    memories,
    question,
    (entry) =>
      [
        entry.summary,
        ...(entry.entities ?? []),
        ...(entry.topics ?? []),
        ...(entry.facts ?? []),
        ...(entry.decisions ?? []),
        ...(entry.todos ?? []),
        ...(entry.fileReferences ?? [])
      ].join('\n'),
    Math.min(MAX_QUERY_MEMORIES, MAX_QUERY_CANDIDATES)
  );
  const selectedInsights = selectRelevantEntries(
    insights,
    question,
    (entry) => `${entry.kind ?? ''}\n${entry.summary}`,
    Math.min(MAX_QUERY_MEMORIES, MAX_QUERY_CANDIDATES)
  );
  const selectedDocs = selectRelevantEntries(
    docs,
    question,
    (entry) => [entry.path, entry.title, ...(entry.headings ?? []), entry.excerpt].join('\n'),
    Math.min(MAX_QUERY_DOCS, MAX_QUERY_CANDIDATES)
  );
  const model = parseModel(config.model);

  try {
    return await withInternalSession({
      client,
      internalSessions,
      title: `${INTERNAL_SESSION_PREFIX} query`,
      model,
      task: async (sessionId, selectedModel) => {
        const body = {
          parts: [{ type: 'text', text: buildQueryPrompt(question, selectedMemories, selectedInsights, selectedDocs) }]
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
      'Top consolidation insights:',
      ...selectedInsights.map((entry, index) => `- [Insight:${index + 1}] ${entry.summary}`),
      '',
      'Top indexed docs:',
      ...selectedDocs.map((entry) => `- ${entry.path}: ${entry.title}`)
    ].join('\n');
  }
}

export async function enrichTranscriptWithReferencedFiles(transcript, config) {
  const referencedFiles = await readReferencedFiles(transcript, config);
  return {
    referencedFiles: referencedFiles.files,
    contentHash: referencedFiles.contentHashSuffix
      ? createHash('sha256').update(`${transcript}\n${referencedFiles.contentHashSuffix}`).digest('hex')
      : createHash('sha256').update(transcript).digest('hex')
  };
}
