import { randomUUID } from 'node:crypto';
import type { Query } from '@anthropic-ai/claude-agent-sdk';
import type {
  MetaSessionState,
  MetaSessionOptions,
  RollingContextConfig,
  TurnGroup,
  CompactionRecord,
  SdkSessionRecord,
  SessionEvent,
  SDKAssistantMessage,
  SdkOptions,
} from './types.js';
import { ContextManager, estimateTurnGroupTokens } from './context-manager.js';
import { SdkBridge, processMessages } from './sdk-bridge.js';
import { appendEvent, loadMetaSession, listSessions, getSdkSessionJsonlPath, countFileLines, readLinesFrom, writeTransplantedJsonl, turnGroupToJsonlLines } from './storage.js';
import { performCompaction } from './compaction.js';

const DEFAULT_ROLLING_CONTEXT_CONFIG: RollingContextConfig = {
  contextSize: 200_000,
  compactionThreshold: 0.8,
  hotTurnFraction: 0.4,
};

/**
 * Keys that belong to MetaSession's own config, not SDK pass-through.
 */
const OWN_OPTION_KEYS = new Set([
  'contextSize',
  'compactionThreshold',
  'hotTurnFraction',
  'compactionPrompt',
  'compactionModel',
  'metaSessionId',
  'logDir',
]);

/**
 * Separate MetaSessionOptions into our config and SDK options.
 */
function splitOptions(options: MetaSessionOptions): {
  rollingContextConfig: RollingContextConfig;
  sdkOptions: Partial<SdkOptions>;
  metaSessionId?: string;
  logDir?: string | null;
} {
  const rollingContextConfig: RollingContextConfig = {
    contextSize: options.contextSize ?? DEFAULT_ROLLING_CONTEXT_CONFIG.contextSize,
    compactionThreshold: options.compactionThreshold ?? DEFAULT_ROLLING_CONTEXT_CONFIG.compactionThreshold,
    hotTurnFraction: options.hotTurnFraction ?? DEFAULT_ROLLING_CONTEXT_CONFIG.hotTurnFraction,
    compactionPrompt: options.compactionPrompt,
    compactionModel: options.compactionModel,
  };

  const sdkOptions: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(options)) {
    if (!OWN_OPTION_KEYS.has(key) && value !== undefined) {
      sdkOptions[key] = value;
    }
  }

  return {
    rollingContextConfig,
    sdkOptions: sdkOptions as Partial<SdkOptions>,
    metaSessionId: options.metaSessionId,
    logDir: options.logDir,
  };
}

export class MetaSession {
  private state: MetaSessionState;
  private contextManager: ContextManager;
  private bridge: SdkBridge;
  private turnIndex = 0;
  private logDir?: string | null;
  private _activeQuery: Query | null = null;

  constructor(options: MetaSessionOptions = {}) {
    const { rollingContextConfig, sdkOptions, metaSessionId, logDir } = splitOptions(options);

    this.logDir = logDir;
    this.contextManager = new ContextManager(rollingContextConfig);
    this.bridge = new SdkBridge(sdkOptions, rollingContextConfig.compactionModel);

    // Try to resume existing session
    if (metaSessionId) {
      const loaded = loadMetaSession(metaSessionId, logDir);
      if (loaded) {
        this.state = loaded;
        this.contextManager = new ContextManager(loaded.rollingContextConfig);
        this.bridge = new SdkBridge(loaded.sdkOptions, loaded.rollingContextConfig.compactionModel);
        this.turnIndex = loaded.turnGroups.length > 0
          ? loaded.turnGroups[loaded.turnGroups.length - 1].index + 1
          : 0;
        return;
      }
    }

    // New session
    const id = metaSessionId ?? randomUUID();
    this.state = {
      metaSessionId: id,
      sessionName: null,
      rollingContextConfig,
      sdkOptions,
      turnGroups: [],
      compactions: [],
      sdkSessions: [],
      activeSdkSessionId: null,
    };

    appendEvent(id, {
      event: 'meta_session_start',
      metaSessionId: id,
      timestamp: new Date().toISOString(),
      rollingContextConfig,
      sdkOptions,
    }, this.logDir);
  }

  // ── Public read-only accessors ──

  get metaSessionId(): string {
    return this.state.metaSessionId;
  }

  get name(): string | null {
    return this.state.sessionName;
  }

  get sdkSessionId(): string | null {
    return this.state.activeSdkSessionId;
  }

  get turns(): readonly TurnGroup[] {
    return this.state.turnGroups;
  }

  get compactions(): readonly CompactionRecord[] {
    return this.state.compactions;
  }

  get config(): Readonly<RollingContextConfig> {
    return this.state.rollingContextConfig;
  }

  /**
   * The active SDK Query object. Use this for SDK features like
   * setModel(), interrupt(), setMcpServers(), etc.
   * Returns null before the first send() call.
   */
  get activeQuery(): Query | null {
    return this._activeQuery;
  }

  get contextStatus(): {
    totalTokens: number;
    thresholdTokens: number;
    coldTokens: number;
    warmTokens: number;
    hotTokens: number;
    compactionCount: number;
    sdkSessionCount: number;
    usage: number;
  } {
    const cold = this.coldSummaryTokens();
    const turnsByZone = { warm: 0, hot: 0, compacted: 0 };
    for (const tg of this.state.turnGroups) {
      turnsByZone[tg.zone] += tg.estimatedTokens;
    }
    const total = this.contextManager.totalContextTokens(this.state.turnGroups, cold);

    return {
      totalTokens: total,
      thresholdTokens: Math.floor(this.state.rollingContextConfig.contextSize * this.state.rollingContextConfig.compactionThreshold),
      coldTokens: cold,
      warmTokens: turnsByZone.warm,
      hotTokens: turnsByZone.hot,
      compactionCount: this.state.compactions.length,
      sdkSessionCount: this.state.sdkSessions.length,
      usage: total / this.state.rollingContextConfig.contextSize,
    };
  }

  // ── Naming ──

  /**
   * Give this session a human-readable name.
   */
  rename(name: string): void {
    this.state.sessionName = name;
    appendEvent(this.state.metaSessionId, {
      event: 'session_rename',
      name,
      timestamp: new Date().toISOString(),
    }, this.logDir);
  }

  // ── Session listing ──

  /**
   * List saved sessions. Optionally filter by cwd.
   * Returns most recently active first.
   */
  static list(options?: { logDir?: string | null; cwd?: string }) {
    return listSessions(options);
  }

  // ── Private helpers ──

  private coldSummaryTokens(): number {
    return this.contextManager.coldSummaryTokens(this.state.compactions);
  }

  private latestColdSummary(): string {
    if (this.state.compactions.length === 0) return '';
    return this.state.compactions[0].summary;
  }

  private cwd(): string {
    return (this.state.sdkOptions.cwd ?? process.cwd());
  }

  // ── Core API ──

  /**
   * Send a message. Yields session events as they stream back.
   * Compaction happens transparently if the context threshold is exceeded.
   */
  async *send(message: string): AsyncGenerator<SessionEvent> {
    // Check if we should compact before sending
    if (
      this.state.turnGroups.length > 0 &&
      this.contextManager.shouldCompact(
        this.state.turnGroups,
        this.coldSummaryTokens(),
      )
    ) {
      yield { type: 'compaction', phase: 'started' };
      yield* this.doCompaction(message);
      return;
    }

    // Start or resume SDK session
    let sessionId: string;
    let messages: AsyncGenerator<any, void>;

    if (!this.state.activeSdkSessionId) {
      const coldSummary = this.latestColdSummary();
      const hotTurns = this.state.turnGroups.filter(tg => tg.zone === 'hot');

      if (coldSummary || hotTurns.length > 0) {
        // Cold start with prior context: transplant
        const newSessionId = randomUUID();
        const allRawLines = hotTurns.flatMap(t =>
          t.rawJsonl ?? turnGroupToJsonlLines(t, newSessionId, this.cwd())
        );
        writeTransplantedJsonl(this.cwd(), newSessionId, allRawLines, coldSummary);
        const session = await this.bridge.resumeSession(newSessionId, message);
        sessionId = session.sessionId;
        messages = session.messages;
        this._activeQuery = session.query;
      } else {
        const session = await this.bridge.startSession(message);
        sessionId = session.sessionId;
        messages = session.messages;
        this._activeQuery = session.query;
      }

      const record: SdkSessionRecord = {
        sessionId,
        parentSessionId: null,
        reason: 'initial',
        startedAt: new Date().toISOString(),
      };
      this.state.sdkSessions.push(record);
      this.state.activeSdkSessionId = sessionId;
      appendEvent(this.state.metaSessionId, { event: 'sdk_session_start', record }, this.logDir);
    } else {
      const session = await this.bridge.resumeSession(
        this.state.activeSdkSessionId,
        message,
      );
      sessionId = session.sessionId;
      messages = session.messages;
      this._activeQuery = session.query;
    }

    yield* this.collectTurnGroup(sessionId, message, messages);
  }

  /**
   * Force compaction. Optionally send a message afterward.
   */
  async *compact(message?: string): AsyncGenerator<SessionEvent> {
    if (this.state.turnGroups.filter(tg => tg.zone !== 'compacted').length < 2) {
      return;
    }

    yield { type: 'compaction', phase: 'started' };

    if (message) {
      yield* this.doCompaction(message);
    } else {
      // Compact without sending a message
      this.contextManager.classifyZones(this.state.turnGroups, this.state.compactions);

      yield { type: 'compaction', phase: 'summarizing' };
      const { compactionRecord, summarizerSessionRecord } = await performCompaction(
        this.state,
        this.contextManager,
        this.bridge,
        this.logDir,
      );
      this.state.compactions.unshift(compactionRecord);
      this.state.sdkSessions.push(summarizerSessionRecord);

      if (this.state.activeSdkSessionId) {
        appendEvent(this.state.metaSessionId, {
          event: 'sdk_session_end',
          sessionId: this.state.activeSdkSessionId,
          timestamp: new Date().toISOString(),
        }, this.logDir);
      }
      this.state.activeSdkSessionId = null;
      this._activeQuery = null;

      yield {
        type: 'compaction',
        phase: 'completed',
        detail: `Compacted ${compactionRecord.compactedRange.to - compactionRecord.compactedRange.from + 1} turns (${compactionRecord.estimatedTokens} est. tokens)`,
      };
    }
  }

  // ── Private methods ──

  private async *doCompaction(nextMessage: string): AsyncGenerator<SessionEvent> {
    this.contextManager.classifyZones(this.state.turnGroups, this.state.compactions);

    yield { type: 'compaction', phase: 'summarizing' };
    const { compactionRecord, hotTurns, summarizerSessionRecord } = await performCompaction(
      this.state,
      this.contextManager,
      this.bridge,
      this.logDir,
    );

    this.state.compactions.unshift(compactionRecord);
    this.state.sdkSessions.push(summarizerSessionRecord);

    yield {
      type: 'compaction',
      phase: 'transplanting',
      detail: `Compacted ${compactionRecord.compactedRange.to - compactionRecord.compactedRange.from + 1} turns (${compactionRecord.estimatedTokens} est. tokens)`,
    };

    // End old session
    if (this.state.activeSdkSessionId) {
      appendEvent(this.state.metaSessionId, {
        event: 'sdk_session_end',
        sessionId: this.state.activeSdkSessionId,
        timestamp: new Date().toISOString(),
      }, this.logDir);
    }

    const coldSummary = compactionRecord.summary;

    // Transplant: cold summary + hot turns into new JSONL
    const newSessionId = randomUUID();
    const allRawLines = hotTurns.flatMap(t =>
      t.rawJsonl ?? turnGroupToJsonlLines(t, newSessionId, this.cwd())
    );
    writeTransplantedJsonl(this.cwd(), newSessionId, allRawLines, coldSummary);

    const newSession = await this.bridge.resumeSession(newSessionId, nextMessage);

    const newRecord: SdkSessionRecord = {
      sessionId: newSession.sessionId,
      parentSessionId: this.state.activeSdkSessionId,
      reason: 'compaction_new',
      startedAt: new Date().toISOString(),
    };
    this.state.sdkSessions.push(newRecord);
    this.state.activeSdkSessionId = newSession.sessionId;
    this._activeQuery = newSession.query;
    appendEvent(this.state.metaSessionId, { event: 'sdk_session_start', record: newRecord }, this.logDir);

    yield { type: 'compaction', phase: 'completed' };

    yield* this.collectTurnGroup(newSession.sessionId, nextMessage, newSession.messages);
  }

  private async *collectTurnGroup(
    sessionId: string,
    userInput: string,
    messages: AsyncGenerator<any, void>,
  ): AsyncGenerator<SessionEvent> {
    // Snapshot SDK JSONL line count before this turn
    const sdkJsonlPath = getSdkSessionJsonlPath(this.cwd(), sessionId);
    const linesBefore = countFileLines(sdkJsonlPath);

    const turnGroup: TurnGroup = {
      id: randomUUID(),
      sdkSessionId: sessionId,
      index: this.turnIndex++,
      userMessage: {
        type: 'user',
        message: { role: 'user', content: userInput },
        parent_tool_use_id: null,
        session_id: sessionId,
      },
      assistantMessages: [],
      estimatedTokens: 0,
      timestamp: new Date().toISOString(),
      zone: 'hot',
    };

    for await (const { event, raw } of processMessages(messages)) {
      if (raw.type === 'assistant') {
        turnGroup.assistantMessages.push(raw as SDKAssistantMessage);
      }
      yield event;
    }

    // Capture raw JSONL lines written by the SDK for this turn
    turnGroup.rawJsonl = readLinesFrom(sdkJsonlPath, linesBefore);

    turnGroup.estimatedTokens = estimateTurnGroupTokens(turnGroup);

    this.state.turnGroups.push(turnGroup);
    appendEvent(this.state.metaSessionId, { event: 'turn_group', turnGroup }, this.logDir);

    this.contextManager.classifyZones(this.state.turnGroups, this.state.compactions);
  }
}
