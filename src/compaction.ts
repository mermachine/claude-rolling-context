import { randomUUID } from 'node:crypto';
import type {
  MetaSessionState,
  CompactionRecord,
  SdkSessionRecord,
  TurnGroup,
} from './types.js';
import { ContextManager, estimateTokens, turnGroupToText } from './context-manager.js';
import { SdkBridge } from './sdk-bridge.js';
import { appendEvent } from './storage.js';
import { DEFAULT_COMPACTION_PROMPT } from './prompts/index.js';

/**
 * Perform a compaction cycle:
 * 1. Fork the current session to generate a first-person summary
 * 2. Create a CompactionRecord
 * 3. Mark compacted turn groups
 * 4. Return the new summary (caller starts a new SDK session)
 */
export async function performCompaction(
  state: MetaSessionState,
  contextManager: ContextManager,
  bridge: SdkBridge,
  logDir?: string | null,
): Promise<{
  compactionRecord: CompactionRecord;
  hotTurns: TurnGroup[];
  summarizerSessionRecord: SdkSessionRecord;
}> {
  const boundary = contextManager.findCompactionBoundary(state.turnGroups);

  const warmTurns = state.turnGroups.filter(
    tg => tg.zone !== 'compacted' && tg.index < boundary
  );
  const hotTurns = state.turnGroups.filter(
    tg => tg.zone !== 'compacted' && tg.index >= boundary
  );

  if (warmTurns.length === 0) {
    throw new Error('No warm turns to compact');
  }

  const previousSummary = state.compactions.length > 0
    ? state.compactions[0].summary
    : '';

  const warmText = warmTurns.map(tg => turnGroupToText(tg)).join('\n\n---\n\n');

  // Use custom compaction prompt if provided, otherwise default
  const basePrompt = state.rollingContextConfig.compactionPrompt ?? DEFAULT_COMPACTION_PROMPT;

  let fullPrompt = basePrompt;
  if (previousSummary) {
    fullPrompt += `\n\n--- PREVIOUS SUMMARY ---\n${previousSummary}\n\n--- NEW CONVERSATION TO INCORPORATE ---\n${warmText}`;
  } else {
    fullPrompt += `\n\n--- CONVERSATION TO SUMMARIZE ---\n${warmText}`;
  }

  if (!state.activeSdkSessionId) {
    throw new Error('No active SDK session to fork');
  }

  const { summarizerSessionId, summary } = await bridge.forkForSummary(
    state.activeSdkSessionId,
    fullPrompt,
  );

  const summarizerSessionRecord: SdkSessionRecord = {
    sessionId: summarizerSessionId,
    parentSessionId: state.activeSdkSessionId,
    reason: 'compaction_fork',
    startedAt: new Date().toISOString(),
    endedAt: new Date().toISOString(),
  };

  const compactionRecord: CompactionRecord = {
    id: randomUUID(),
    summary,
    compactedRange: {
      from: warmTurns[0].index,
      to: warmTurns[warmTurns.length - 1].index,
    },
    estimatedTokens: estimateTokens(summary),
    summarizerSessionId,
    timestamp: new Date().toISOString(),
    previousCompactionId: state.compactions.length > 0
      ? state.compactions[0].id
      : null,
  };

  // Persist
  appendEvent(state.metaSessionId, {
    event: 'sdk_session_start',
    record: summarizerSessionRecord,
  }, logDir);
  appendEvent(state.metaSessionId, {
    event: 'sdk_session_end',
    sessionId: summarizerSessionId,
    timestamp: new Date().toISOString(),
  }, logDir);
  appendEvent(state.metaSessionId, {
    event: 'compaction',
    record: compactionRecord,
  }, logDir);

  // Mark warm turns as compacted
  for (const tg of warmTurns) {
    tg.zone = 'compacted';
    appendEvent(state.metaSessionId, {
      event: 'zone_update',
      turnGroupId: tg.id,
      zone: 'compacted',
    }, logDir);
  }

  return {
    compactionRecord,
    hotTurns,
    summarizerSessionRecord,
  };
}
