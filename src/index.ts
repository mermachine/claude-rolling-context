export { MetaSession } from './meta-session.js';

export type {
  // Main API types
  MetaSessionOptions,
  SessionEvent,
  RollingContextConfig,

  // Conversation data
  TurnGroup,
  CompactionRecord,
  SessionSummary,

  // Re-exported SDK types for convenience
  SDKAssistantMessage,
  SDKUserMessage,
  SDKMessage,
  SDKResultMessage,
  SdkOptions,
} from './types.js';

// Image support
export type { ImageAttachment } from './sdk-bridge.js';

// Utilities that consumers might find useful
export { estimateTokens, contentBlocksToText } from './context-manager.js';
export { DEFAULT_COMPACTION_PROMPT } from './prompts/index.js';
