import type {
  SDKAssistantMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
  SDKResultMessage,
  SDKSystemMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  Options as SdkOptions,
} from '@anthropic-ai/claude-agent-sdk';

// Re-export SDK types that consumers might need
export type {
  SDKAssistantMessage,
  SDKUserMessage,
  SDKUserMessageReplay,
  SDKResultMessage,
  SDKSystemMessage,
  SDKCompactBoundaryMessage,
  SDKMessage,
  SDKPartialAssistantMessage,
  SdkOptions,
};

// ── Identifiers ──

export type TurnGroupId = string;
export type SdkSessionId = string;
export type MetaSessionId = string;

// ── Turn Groups ──

/**
 * One atomic turn group: a user message + all assistant/tool responses
 * that follow before the next user message.
 */
export interface TurnGroup {
  id: TurnGroupId;
  sdkSessionId: SdkSessionId;
  index: number;
  userMessage: SDKUserMessage | SDKUserMessageReplay;
  assistantMessages: SDKAssistantMessage[];
  estimatedTokens: number;
  timestamp: string;
  zone: 'hot' | 'warm' | 'compacted';
  /** Raw JSONL lines from the SDK session file for this turn group. */
  rawJsonl?: string[];
}

// ── Compaction ──

export interface CompactionRecord {
  id: string;
  summary: string;
  compactedRange: { from: number; to: number };
  estimatedTokens: number;
  summarizerSessionId: SdkSessionId;
  timestamp: string;
  previousCompactionId: string | null;
}

// ── Session Lineage ──

export interface SdkSessionRecord {
  sessionId: SdkSessionId;
  parentSessionId: SdkSessionId | null;
  reason: 'initial' | 'compaction_fork' | 'compaction_new' | 'resume';
  forkPoint?: string;
  startedAt: string;
  endedAt?: string;
}

// ── Configuration ──

/**
 * Meta-session's own configuration — context management and compaction.
 * SDK options are handled separately via pass-through.
 */
export interface RollingContextConfig {
  contextSize: number;
  compactionThreshold: number;
  /** Fraction of context to keep as hot turns (e.g. 0.4 = 40%) */
  hotTurnFraction: number;
  /** Custom prompt for the compaction summarizer */
  compactionPrompt?: string;
  /** Model to use for compaction (defaults to same as session model) */
  compactionModel?: string;
}

/**
 * Constructor options: our config + SDK options as pass-through.
 */
export type MetaSessionOptions = {
  // ── Context management ──
  contextSize?: number;
  compactionThreshold?: number;
  hotTurnFraction?: number;
  compactionPrompt?: string;
  compactionModel?: string;

  // ── Persistence ──
  metaSessionId?: string;
  logDir?: string | null;
} & Partial<SdkOptions>;

// ── Internal State ──

export interface MetaSessionState {
  metaSessionId: MetaSessionId;
  sessionName: string | null;
  rollingContextConfig: RollingContextConfig;
  sdkOptions: Partial<SdkOptions>;
  turnGroups: TurnGroup[];
  compactions: CompactionRecord[];
  sdkSessions: SdkSessionRecord[];
  activeSdkSessionId: SdkSessionId | null;
}

// ── Session listing ──

export interface SessionSummary {
  metaSessionId: string;
  sessionName: string | null;
  createdAt: string;
  model: string;
  cwd: string;
  turnCount: number;
  compactionCount: number;
  firstMessage: string;
  lastMessage: string;
}

// ── Storage Events (JSONL) ──

export type MetaSessionEvent =
  | { event: 'meta_session_start'; metaSessionId: string; timestamp: string; rollingContextConfig: RollingContextConfig; sdkOptions: Partial<SdkOptions> }
  | { event: 'session_rename'; name: string; timestamp: string }
  | { event: 'sdk_session_start'; record: SdkSessionRecord }
  | { event: 'sdk_session_end'; sessionId: SdkSessionId; timestamp: string }
  | { event: 'turn_group'; turnGroup: TurnGroup }
  | { event: 'compaction'; record: CompactionRecord }
  | { event: 'zone_update'; turnGroupId: TurnGroupId; zone: TurnGroup['zone'] };

// ── Session Events (public API) ──

export type SessionEvent =
  // ── Streaming content ──
  | { type: 'stream_text'; text: string }
  | { type: 'stream_thinking'; text: string }

  // ── Tool usage ──
  | { type: 'tool_use'; toolName: string; toolUseId: string; input: unknown }
  | { type: 'tool_use_summary'; summary: string; toolUseIds: string[] }
  | { type: 'tool_progress'; toolName: string; toolUseId: string; elapsedSeconds: number }

  // ── Turn lifecycle ──
  | { type: 'result'; costUsd: number; numTurns: number; durationMs: number; inputTokens: number; outputTokens: number }
  | { type: 'error'; message: string }

  // ── Context management ──
  | { type: 'compaction'; phase: 'started' | 'summarizing' | 'transplanting' | 'completed' | 'sdk_auto'; detail?: string };
