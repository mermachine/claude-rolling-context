import { query } from '@anthropic-ai/claude-agent-sdk';
import type {
  Query,
  Options,
  SDKMessage,
  SDKAssistantMessage,
  SDKSystemMessage,
  SDKResultMessage,
  SDKPartialAssistantMessage,
  SDKToolProgressMessage,
  SDKToolUseSummaryMessage,
  HookCallback,
  PreCompactHookInput,
} from '@anthropic-ai/claude-agent-sdk';
import type {
  SdkSessionId,
  SessionEvent,
  SdkOptions,
} from './types.js';

/**
 * Internal display event used to pass both the public event and raw SDK message
 * through the processing pipeline. The raw message is needed for collectTurnGroup.
 */
export interface ProcessedMessage {
  event: SessionEvent;
  raw: SDKMessage;
}

/**
 * PreCompact hook that detects when the SDK's own auto-compaction fires.
 */
const preCompactHook: HookCallback = async (input) => {
  const hookInput = input as PreCompactHookInput;
  if (hookInput.trigger === 'auto') {
    console.warn('[rolling-context] SDK auto-compaction triggered — compactionThreshold may be too high');
  }
  return {};
};

function mergeHooks(
  userHooks: Options['hooks'],
): Options['hooks'] {
  const hooks = { ...userHooks };
  const existing = hooks?.PreCompact ?? [];
  hooks!.PreCompact = [...existing, { hooks: [preCompactHook] }];
  return hooks;
}

export class SdkBridge {
  private sdkOptions: Partial<SdkOptions>;
  private compactionModel?: string;

  constructor(sdkOptions: Partial<SdkOptions>, compactionModel?: string) {
    this.sdkOptions = sdkOptions;
    this.compactionModel = compactionModel;
  }

  private buildOptions(): Partial<Options> {
    const opts: Partial<Options> = {
      ...this.sdkOptions,
      includePartialMessages: true,
      hooks: mergeHooks(this.sdkOptions.hooks as Options['hooks']),
    };
    return opts;
  }

  /**
   * Start a fresh SDK session with the given prompt.
   */
  async startSession(prompt: string): Promise<{
    sessionId: SdkSessionId;
    query: Query;
    messages: AsyncGenerator<SDKMessage, void>;
  }> {
    const opts = this.buildOptions();
    const q = query({ prompt, options: opts as Options });

    const first = await q.next();
    if (first.done) throw new Error('Session ended immediately');

    const initMsg = first.value;
    if (initMsg.type !== 'system' || (initMsg as SDKSystemMessage).subtype !== 'init') {
      throw new Error(`Expected init message, got ${initMsg.type}`);
    }

    return {
      sessionId: (initMsg as SDKSystemMessage).session_id,
      query: q as unknown as Query,
      messages: q,
    };
  }

  /**
   * Resume an existing SDK session with a new user message.
   */
  async resumeSession(sessionId: SdkSessionId, prompt: string): Promise<{
    sessionId: SdkSessionId;
    query: Query;
    messages: AsyncGenerator<SDKMessage, void>;
  }> {
    const opts = this.buildOptions();
    opts.resume = sessionId;

    const q = query({ prompt, options: opts as Options });

    const first = await q.next();
    if (first.done) throw new Error('Session ended immediately');

    const initMsg = first.value;
    if (initMsg.type === 'result') {
      const result = initMsg as SDKResultMessage;
      throw new Error(`SDK session failed immediately: ${(result as any).errors?.join(', ') ?? result.subtype}`);
    }
    const resolvedSessionId = (initMsg as any).session_id ?? sessionId;

    return {
      sessionId: resolvedSessionId,
      query: q as unknown as Query,
      messages: q,
    };
  }

  /**
   * Fork a session to generate a compaction summary.
   */
  async forkForSummary(sessionId: SdkSessionId, summaryPrompt: string): Promise<{
    summarizerSessionId: SdkSessionId;
    summary: string;
  }> {
    const opts = this.buildOptions();
    opts.resume = sessionId;
    opts.forkSession = true;
    opts.maxTurns = 1;
    opts.allowedTools = [];
    opts.includePartialMessages = false;

    // Use compactionModel if specified
    if (this.compactionModel) {
      opts.model = this.compactionModel;
    }

    const q = query({ prompt: summaryPrompt, options: opts as Options });

    let summarizerSessionId = '';
    let summary = '';

    for await (const msg of q) {
      if (msg.type === 'system' && (msg as SDKSystemMessage).subtype === 'init') {
        summarizerSessionId = (msg as SDKSystemMessage).session_id;
      }
      if (msg.type === 'result') {
        const result = msg as SDKResultMessage;
        if (result.subtype === 'success') {
          summary = result.result;
        } else {
          throw new Error(`Summary fork failed: ${result.errors?.join(', ')}`);
        }
      }
    }

    if (!summary) throw new Error('Summary fork produced no output');

    return { summarizerSessionId, summary };
  }
}

/**
 * Iterate SDK messages and yield session events + raw messages.
 */
export async function* processMessages(
  messages: AsyncGenerator<SDKMessage, void>,
): AsyncGenerator<ProcessedMessage> {
  for await (const msg of messages) {
    switch (msg.type) {
      case 'assistant': {
        const am = msg as SDKAssistantMessage;
        const content = am.message.content;
        if (Array.isArray(content)) {
          for (const block of content) {
            if ((block as any).type === 'tool_use') {
              yield {
                event: {
                  type: 'tool_use',
                  toolName: (block as any).name,
                  toolUseId: (block as any).id,
                  input: (block as any).input,
                },
                raw: msg,
              };
            }
          }
          // Still yield so the raw msg is collected even if no tool_use blocks
          if (!content.some((b: any) => b.type === 'tool_use')) {
            yield {
              event: { type: 'stream_text', text: '' },
              raw: msg,
            };
          }
        }
        break;
      }

      case 'stream_event': {
        const partial = msg as SDKPartialAssistantMessage;
        const event = partial.event as any;
        if (event.type === 'content_block_delta') {
          if (event.delta?.type === 'text_delta') {
            yield {
              event: { type: 'stream_text', text: event.delta.text },
              raw: msg,
            };
          } else if (event.delta?.type === 'thinking_delta') {
            yield {
              event: { type: 'stream_thinking', text: event.delta.thinking },
              raw: msg,
            };
          }
        }
        break;
      }

      case 'result': {
        const result = msg as SDKResultMessage;
        if (result.subtype === 'success') {
          yield {
            event: {
              type: 'result',
              costUsd: result.total_cost_usd,
              numTurns: result.num_turns,
              durationMs: result.duration_ms,
              inputTokens: result.usage.input_tokens,
              outputTokens: result.usage.output_tokens,
            },
            raw: msg,
          };
        } else {
          yield {
            event: { type: 'error', message: result.errors.join('\n') },
            raw: msg,
          };
        }
        break;
      }

      case 'system': {
        if ((msg as any).subtype === 'compact_boundary') {
          yield {
            event: { type: 'compaction', phase: 'sdk_auto', detail: 'SDK auto-compaction occurred' },
            raw: msg,
          };
        }
        break;
      }

      case 'tool_progress': {
        const tp = msg as SDKToolProgressMessage;
        yield {
          event: {
            type: 'tool_progress',
            toolName: tp.tool_name,
            toolUseId: tp.tool_use_id,
            elapsedSeconds: tp.elapsed_time_seconds,
          },
          raw: msg,
        };
        break;
      }

      case 'tool_use_summary': {
        const tus = msg as SDKToolUseSummaryMessage;
        yield {
          event: {
            type: 'tool_use_summary',
            summary: tus.summary,
            toolUseIds: tus.preceding_tool_use_ids,
          },
          raw: msg,
        };
        break;
      }

      default:
        break;
    }
  }
}
