import type { TurnGroup, CompactionRecord, RollingContextConfig } from './types.js';

const CHARS_PER_TOKEN = 3.0;
const SYSTEM_PROMPT_OVERHEAD_TOKENS = 4000;

/**
 * Estimate token count from a string.
 * Heuristic: ~3 chars per token for mixed English/code.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Extract text from SDK message content blocks.
 */
export function contentBlocksToText(content: unknown): string {
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return JSON.stringify(content);

  return content.map((block: any) => {
    if (block.type === 'text') return block.text;
    if (block.type === 'thinking') return `[thinking] ${block.thinking}`;
    if (block.type === 'tool_use') return `[tool_use: ${block.name}] ${JSON.stringify(block.input)}`;
    if (block.type === 'tool_result') {
      if (typeof block.content === 'string') return `[tool_result] ${block.content}`;
      if (Array.isArray(block.content)) {
        return block.content.map((c: any) => c.type === 'text' ? c.text : JSON.stringify(c)).join('\n');
      }
      return `[tool_result] ${JSON.stringify(block.content)}`;
    }
    return JSON.stringify(block);
  }).join('\n');
}

/**
 * Estimate token count for a turn group.
 */
export function estimateTurnGroupTokens(tg: TurnGroup): number {
  let total = estimateTokens(contentBlocksToText(tg.userMessage.message.content));
  for (const am of tg.assistantMessages) {
    total += estimateTokens(contentBlocksToText(am.message.content));
  }
  return total;
}

/**
 * Serialize a turn group to readable text for compaction prompts.
 */
export function turnGroupToText(tg: TurnGroup): string {
  const userText = contentBlocksToText(tg.userMessage.message.content);
  const assistantTexts = tg.assistantMessages
    .map(am => contentBlocksToText(am.message.content))
    .join('\n');
  return `User: ${userText}\nAssistant: ${assistantTexts}`;
}

export class ContextManager {
  constructor(private config: RollingContextConfig) {}

  totalContextTokens(
    turnGroups: TurnGroup[],
    coldSummaryTokens: number,
  ): number {
    const activeTurns = turnGroups.filter(tg => tg.zone !== 'compacted');
    const turnTokens = activeTurns.reduce((sum, tg) => sum + tg.estimatedTokens, 0);
    return coldSummaryTokens + turnTokens + SYSTEM_PROMPT_OVERHEAD_TOKENS;
  }

  shouldCompact(
    turnGroups: TurnGroup[],
    coldSummaryTokens: number,
  ): boolean {
    const total = this.totalContextTokens(turnGroups, coldSummaryTokens);
    const threshold = this.config.contextSize * this.config.compactionThreshold;
    return total > threshold;
  }

  /**
   * Find the compaction boundary index.
   * Returns the turn index where "hot" starts.
   * Everything before this (that isn't already compacted) becomes warm.
   */
  findCompactionBoundary(turnGroups: TurnGroup[]): number {
    const activeTurns = turnGroups.filter(tg => tg.zone !== 'compacted');
    if (activeTurns.length <= 1) return turnGroups.length;

    const hotBudget = this.config.contextSize * this.config.hotTurnFraction;
    let hotTokens = 0;
    let hotCount = 0;

    for (let i = activeTurns.length - 1; i >= 0; i--) {
      const next = hotTokens + activeTurns[i].estimatedTokens;
      if (next > hotBudget && hotCount > 0) break;
      hotTokens = next;
      hotCount++;
    }

    // Guarantee at least one warm turn
    if (hotCount >= activeTurns.length) {
      hotCount = Math.max(1, activeTurns.length - 1);
    }

    const firstHotActiveTurn = activeTurns[activeTurns.length - hotCount];
    return firstHotActiveTurn.index;
  }

  classifyZones(turnGroups: TurnGroup[], compactions: CompactionRecord[]): void {
    let maxCompactedIndex = -1;
    for (const c of compactions) {
      if (c.compactedRange.to > maxCompactedIndex) {
        maxCompactedIndex = c.compactedRange.to;
      }
    }

    for (const tg of turnGroups) {
      if (tg.index <= maxCompactedIndex) {
        tg.zone = 'compacted';
      }
    }

    const activeTurns = turnGroups.filter(tg => tg.zone !== 'compacted');
    if (activeTurns.length === 0) return;

    const hotBudget = this.config.contextSize * this.config.hotTurnFraction;
    let hotTokens = 0;
    const hotIndices = new Set<number>();

    for (let i = activeTurns.length - 1; i >= 0; i--) {
      const next = hotTokens + activeTurns[i].estimatedTokens;
      if (next > hotBudget && hotIndices.size > 0) break;
      hotTokens = next;
      hotIndices.add(activeTurns[i].index);
    }

    if (hotIndices.size >= activeTurns.length && activeTurns.length > 1) {
      hotIndices.delete(activeTurns[0].index);
    }

    for (const tg of activeTurns) {
      tg.zone = hotIndices.has(tg.index) ? 'hot' : 'warm';
    }
  }

  coldSummaryTokens(compactions: CompactionRecord[]): number {
    if (compactions.length === 0) return 0;
    return compactions[0].estimatedTokens;
  }
}
