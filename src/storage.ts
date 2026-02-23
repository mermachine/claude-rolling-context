import { mkdirSync, existsSync, appendFileSync, readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import type {
  MetaSessionEvent,
  MetaSessionState,
  RollingContextConfig,
  SessionSummary,
  TurnGroup,
  CompactionRecord,
  SdkSessionRecord,
  SdkOptions,
} from './types.js';
import { MEMORY_CHECKPOINT_PROMPT } from './prompts/index.js';

const DEFAULT_LOG_DIR = join(homedir(), '.meta-sessions');
const SDK_PROJECTS_DIR = join(homedir(), '.claude', 'projects');

/**
 * Get the path to the SDK's session JSONL file.
 * The SDK stores sessions at ~/.claude/projects/{sanitized-cwd}/{sessionId}.jsonl
 * where sanitized-cwd replaces '/' with '-'.
 */
export function getSdkSessionJsonlPath(cwd: string, sessionId: string): string {
  const sanitized = cwd.replace(/\//g, '-');
  return join(SDK_PROJECTS_DIR, sanitized, `${sessionId}.jsonl`);
}

/**
 * Count the number of lines in a file. Returns 0 if file doesn't exist.
 */
export function countFileLines(filepath: string): number {
  if (!existsSync(filepath)) return 0;
  const content = readFileSync(filepath, 'utf-8');
  const lines = content.split('\n');
  return lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
}

/**
 * Read lines from a file starting at a given offset.
 */
export function readLinesFrom(filepath: string, startLine: number): string[] {
  if (!existsSync(filepath)) return [];
  const content = readFileSync(filepath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());
  return lines.slice(startLine);
}

/**
 * Build a user + assistant JSONL line pair that injects a cold summary
 * as a synthetic memory checkpoint turn.
 */
function buildSummaryJsonlLines(
  sessionId: string,
  coldSummary: string,
  targetCwd: string,
  userTimestamp: string,
  assistantTimestamp: string,
): { lines: string[]; lastUuid: string } {
  const userUuid = randomUUID();
  const assistantUuid = randomUUID();

  const userLine = {
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: targetCwd,
    sessionId,
    version: '2.1.49',
    gitBranch: 'HEAD',
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text: MEMORY_CHECKPOINT_PROMPT }] },
    uuid: userUuid,
    timestamp: userTimestamp,
    permissionMode: 'default',
  };

  const assistantLine = {
    parentUuid: userUuid,
    isSidechain: false,
    userType: 'external',
    cwd: targetCwd,
    sessionId,
    version: '2.1.49',
    gitBranch: 'HEAD',
    type: 'assistant',
    message: {
      model: 'compaction-summary',
      id: `msg_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      type: 'message',
      role: 'assistant',
      content: [{ type: 'text', text: coldSummary }],
      stop_reason: 'end_turn',
      stop_sequence: null,
      usage: { input_tokens: 0, cache_creation_input_tokens: 0, cache_read_input_tokens: 0, output_tokens: 0 },
    },
    requestId: `req_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
    uuid: assistantUuid,
    timestamp: assistantTimestamp,
  };

  return {
    lines: [JSON.stringify(userLine), JSON.stringify(assistantLine)],
    lastUuid: assistantUuid,
  };
}

/**
 * Synthesize JSONL lines from a TurnGroup's structured data.
 * Used when rawJsonl is not available (e.g. imported sessions).
 */
export function turnGroupToJsonlLines(
  tg: TurnGroup,
  sessionId: string,
  targetCwd: string,
): string[] {
  const lines: string[] = [];

  const userUuid = randomUUID();
  lines.push(JSON.stringify({
    parentUuid: null,
    isSidechain: false,
    userType: 'external',
    cwd: targetCwd,
    sessionId,
    version: '2.1.49',
    gitBranch: 'HEAD',
    type: 'user',
    message: tg.userMessage.message,
    uuid: userUuid,
    timestamp: tg.timestamp,
    permissionMode: 'default',
  }));

  let lastUuid = userUuid;

  for (const am of tg.assistantMessages) {
    const uuid = randomUUID();
    lines.push(JSON.stringify({
      parentUuid: lastUuid,
      isSidechain: false,
      userType: 'external',
      cwd: targetCwd,
      sessionId,
      version: '2.1.49',
      gitBranch: 'HEAD',
      type: 'assistant',
      message: am.message,
      requestId: `req_${randomUUID().replace(/-/g, '').slice(0, 24)}`,
      uuid,
      timestamp: tg.timestamp,
    }));
    lastUuid = uuid;
  }

  return lines;
}

/**
 * Write a transplanted SDK session JSONL file from raw lines.
 * Rewrites sessionId and fixes parentUuid chain.
 */
export function writeTransplantedJsonl(
  cwd: string,
  newSessionId: string,
  rawLines: string[],
  coldSummary?: string,
): string {
  const sanitized = cwd.replace(/\//g, '-');
  const dir = join(SDK_PROJECTS_DIR, sanitized);
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }

  const filepath = join(dir, `${newSessionId}.jsonl`);
  const baseTimeMs = Date.now();
  const iso = (offsetMs: number) => new Date(baseTimeMs + offsetMs).toISOString();
  let eventOffsetMs = 0;

  const output: string[] = [
    JSON.stringify({ type: 'queue-operation', operation: 'enqueue', timestamp: iso(eventOffsetMs++), sessionId: newSessionId }),
    JSON.stringify({ type: 'queue-operation', operation: 'dequeue', timestamp: iso(eventOffsetMs++), sessionId: newSessionId }),
  ];

  const parsedLines: any[] = [];
  let skippedMalformedLines = 0;
  for (const line of rawLines) {
    try {
      const parsed = JSON.parse(line);
      if (parsed.type !== 'queue-operation') {
        parsedLines.push(parsed);
      }
    } catch {
      skippedMalformedLines++;
    }
  }
  if (skippedMalformedLines > 0) {
    console.warn(`[rolling-context] skipped ${skippedMalformedLines} malformed SDK JSONL line(s) during transplant`);
  }

  const includedUuids = new Set<string>(
    parsedLines
      .map(line => (typeof line.uuid === 'string' ? line.uuid : null))
      .filter((uuid): uuid is string => uuid !== null)
  );
  let rootParentUuid: string | null = null;

  if (coldSummary) {
    const summary = buildSummaryJsonlLines(
      newSessionId,
      coldSummary,
      cwd,
      iso(eventOffsetMs++),
      iso(eventOffsetMs++),
    );
    output.push(...summary.lines);
    rootParentUuid = summary.lastUuid;
  }

  for (const parsed of parsedLines) {
    parsed.sessionId = newSessionId;
    parsed.timestamp = iso(eventOffsetMs++);

    const parentUuid = typeof parsed.parentUuid === 'string' ? parsed.parentUuid : null;
    if (parentUuid === null || !includedUuids.has(parentUuid)) {
      parsed.parentUuid = rootParentUuid;
    }

    output.push(JSON.stringify(parsed));
  }

  writeFileSync(filepath, output.join('\n') + '\n', 'utf-8');
  return filepath;
}

// ── Meta-session log persistence ──

function getLogDir(logDir?: string | null): string | null {
  if (logDir === null) return null;
  return logDir ?? DEFAULT_LOG_DIR;
}

function getMetaSessionPath(metaSessionId: string, logDir?: string | null): string | null {
  const dir = getLogDir(logDir);
  if (dir === null) return null;
  return join(dir, `${metaSessionId}.jsonl`);
}

function ensureLogDir(logDir?: string | null): void {
  const dir = getLogDir(logDir);
  if (dir === null) return;
  if (!existsSync(dir)) {
    mkdirSync(dir, { recursive: true });
  }
}

export function appendEvent(metaSessionId: string, event: MetaSessionEvent, logDir?: string | null): void {
  const filepath = getMetaSessionPath(metaSessionId, logDir);
  if (filepath === null) return; // ephemeral mode
  ensureLogDir(logDir);
  appendFileSync(filepath, JSON.stringify(event) + '\n', 'utf-8');
}

export function loadMetaSession(metaSessionId: string, logDir?: string | null): MetaSessionState | null {
  const filepath = getMetaSessionPath(metaSessionId, logDir);
  if (filepath === null || !existsSync(filepath)) return null;

  const content = readFileSync(filepath, 'utf-8');
  const lines = content.split('\n').filter(line => line.trim());

  let rollingContextConfig: RollingContextConfig | null = null;
  let sdkOptions: Partial<SdkOptions> = {};
  let sessionName: string | null = null;
  const turnGroups: TurnGroup[] = [];
  const compactions: CompactionRecord[] = [];
  const sdkSessions: SdkSessionRecord[] = [];
  let activeSdkSessionId: string | null = null;

  let skippedMalformedEvents = 0;
  for (const line of lines) {
    try {
      const event = JSON.parse(line) as MetaSessionEvent;

      switch (event.event) {
        case 'meta_session_start':
          rollingContextConfig = event.rollingContextConfig;
          sdkOptions = event.sdkOptions;
          break;

        case 'session_rename':
          sessionName = event.name;
          break;

        case 'sdk_session_start':
          sdkSessions.push(event.record);
          activeSdkSessionId = event.record.sessionId;
          break;

        case 'sdk_session_end': {
          const session = sdkSessions.find(s => s.sessionId === event.sessionId);
          if (session) session.endedAt = event.timestamp;
          if (activeSdkSessionId === event.sessionId) activeSdkSessionId = null;
          break;
        }

        case 'turn_group':
          turnGroups.push(event.turnGroup);
          break;

        case 'compaction':
          compactions.unshift(event.record);
          break;

        case 'zone_update': {
          const tg = turnGroups.find(t => t.id === event.turnGroupId);
          if (tg) tg.zone = event.zone;
          break;
        }
      }
    } catch {
      skippedMalformedEvents++;
    }
  }
  if (skippedMalformedEvents > 0) {
    console.warn(`[rolling-context] skipped ${skippedMalformedEvents} malformed event line(s) while loading session ${metaSessionId}`);
  }

  if (!rollingContextConfig) return null;

  return {
    metaSessionId,
    sessionName,
    rollingContextConfig,
    sdkOptions,
    turnGroups,
    compactions,
    sdkSessions,
    activeSdkSessionId,
  };
}

// ── Session listing ──

function extractUserText(message: any): string {
  const mc = message?.content;
  if (typeof mc === 'string') return mc;
  if (Array.isArray(mc)) {
    return mc
      .filter((b: any) => b.type === 'text')
      .map((b: any) => b.text as string)
      .join('');
  }
  return '';
}

function readSessionSummary(metaSessionId: string, logDir?: string | null): SessionSummary | null {
  const filepath = getMetaSessionPath(metaSessionId, logDir);
  if (filepath === null || !existsSync(filepath)) return null;
  const content = readFileSync(filepath, 'utf-8');
  const lines = content.split('\n').filter(l => l.trim());

  let createdAt = '';
  let sessionName: string | null = null;
  let model = '';
  let cwd = '';
  let turnCount = 0;
  let compactionCount = 0;
  let firstMessage = '';
  let lastMessage = '';

  for (const line of lines) {
    try {
      const event = JSON.parse(line) as MetaSessionEvent;
      switch (event.event) {
        case 'meta_session_start':
          createdAt = event.timestamp;
          model = (event.sdkOptions as any).model ?? '';
          cwd = (event.sdkOptions as any).cwd ?? '';
          break;
        case 'session_rename':
          sessionName = event.name;
          break;
        case 'turn_group': {
          turnCount++;
          const text = extractUserText(event.turnGroup.userMessage.message);
          if (!firstMessage) firstMessage = text.substring(0, 120);
          lastMessage = text.substring(0, 120);
          break;
        }
        case 'compaction':
          compactionCount++;
          break;
      }
    } catch {
      // skip malformed lines
    }
  }

  if (!createdAt) return null;
  return { metaSessionId, sessionName, createdAt, model, cwd, turnCount, compactionCount, firstMessage, lastMessage };
}

/**
 * List all sessions, most recently active first.
 * Optionally filter by cwd.
 */
export function listSessions(options?: { logDir?: string | null; cwd?: string }): SessionSummary[] {
  const dir = getLogDir(options?.logDir);
  if (dir === null) return [];
  ensureLogDir(options?.logDir);
  if (!existsSync(dir)) return [];

  const files = (readdirSync(dir) as string[]).filter(f => f.endsWith('.jsonl'));

  // Sort by file mtime descending (most recently used first)
  files.sort((a, b) => {
    const mtimeA = statSync(join(dir, a)).mtime.getTime();
    const mtimeB = statSync(join(dir, b)).mtime.getTime();
    return mtimeB - mtimeA;
  });

  const summaries: SessionSummary[] = [];
  for (const file of files) {
    const id = file.replace('.jsonl', '');
    const s = readSessionSummary(id, options?.logDir);
    if (s) {
      if (options?.cwd && s.cwd !== options.cwd) continue;
      summaries.push(s);
    }
  }
  return summaries;
}
