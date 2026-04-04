# claude-rolling-context

Rolling context and custom compaction for the Claude Agent SDK.

The Claude Agent SDK's built-in compaction is all-or-nothing — when context fills up, everything gets summarized at once. claude-rolling-context gives you a rolling window instead: recent turns stay verbatim while older turns are progressively summarized.

## Install

```bash
npm install claude-rolling-context
```

Requires `@anthropic-ai/claude-agent-sdk` as a peer dependency.

## Quick start

```ts
import { MetaSession } from 'claude-rolling-context'

const session = new MetaSession({
  model: 'claude-sonnet-4-5',
  cwd: process.cwd(),
})

for await (const event of session.send('Hello!')) {
  if (event.type === 'stream_text') process.stdout.write(event.text)
}

// Later messages in the same session — compaction happens
// transparently when context usage gets high
for await (const event of session.send('Now do something else')) {
  if (event.type === 'stream_text') process.stdout.write(event.text)
}
```

`send()` manages context automatically. When usage crosses the threshold, older turns are summarized and recent turns are kept intact, then the conversation continues.

## What it does

- **Rolling context** — older turns are progressively summarized while recent turns stay verbatim.
- **Custom compaction** — choose which model summarizes, write your own compaction prompt, control when compaction triggers.
- **SDK compatible** — all Agent SDK options (tools, hooks, MCP servers, permissions, etc.) pass through. claude-rolling-context wraps the SDK, not replaces it.
- **Resumable sessions** — sessions persist to disk and can be resumed across process restarts.

## Notes

- Token estimation is heuristic (~3 chars/token). Good enough for threshold decisions, not billing-accurate.
- Keep `compactionThreshold` at 0.8 or below. The SDK has its own auto-compaction at ~95% that we can't control — staying well below it avoids conflicts.
- Sessions persist to `~/.meta-sessions/` by default. Set `logDir: null` for ephemeral sessions.

### Agent SDK versioning

The Claude Agent SDK (`@anthropic-ai/claude-agent-sdk`) is bundled inside the Claude Code binary. It updates when Claude Code updates — there's no separate release channel. claude-rolling-context declares it as a peer dependency (`>=0.2.49`) so it resolves to whatever version ships with your Claude Code installation.

The areas most sensitive to SDK changes are the `query()` API and `Options` type (passed through from `MetaSessionOptions`) and `SDKMessage` subtypes (parsed to produce `SessionEvent`s). If a future SDK update breaks something, pin to a known-good version in your project until claude-rolling-context catches up.

## API

### `new MetaSession(options)`

Creates a new session (or resumes an existing one).

**Context management options:**

| Option | Type | Default | Description |
|--------|------|---------|-------------|
| `contextSize` | `number` | `200000` | Context window size in tokens |
| `compactionThreshold` | `number` | `0.8` | Compact when usage exceeds this fraction (0.0–1.0) |
| `hotTurnFraction` | `number` | `0.4` | Fraction of context budget reserved for recent turns |
| `compactionPrompt` | `string` | built-in | Prompt given to the summarizer |
| `compactionModel` | `string` | same as `model` | Model used for summarization |
| `metaSessionId` | `string` | auto-generated | Resume an existing session by ID |
| `logDir` | `string \| null` | `~/.meta-sessions` | Where to store session logs. `null` for ephemeral sessions |

**SDK options** (passed through to `query()`):

All [Agent SDK `Options`](https://docs.anthropic.com/en/docs/agent-sdk) fields are accepted and forwarded.

### `session.send(message, images?): AsyncGenerator<SessionEvent>`

Send a message and stream back events. Compaction runs transparently if the context threshold is exceeded. Optionally attach images for multimodal messages.

```ts
import type { ImageAttachment } from 'claude-rolling-context'

const screenshot: ImageAttachment = {
  data: fs.readFileSync('screenshot.png').toString('base64'),
  mimeType: 'image/png',
}

for await (const event of session.send('What do you see?', [screenshot])) {
  if (event.type === 'stream_text') process.stdout.write(event.text)
}
```

```ts
for await (const event of session.send('Explain this codebase')) {
  switch (event.type) {
    case 'stream_text':
      process.stdout.write(event.text)
      break
    case 'stream_thinking':
      // Extended thinking content
      break
    case 'tool_use':
      console.log(`Using tool: ${event.toolName}`)
      break
    case 'result':
      console.log(`Cost: $${event.costUsd.toFixed(4)}`)
      break
    case 'compaction':
      console.log(`Compaction: ${event.phase}`)
      break
    case 'error':
      console.error(event.message)
      break
  }
}
```

### `session.compact(message?): AsyncGenerator<SessionEvent>`

Force compaction immediately. Optionally send a message afterward in the new session.

```ts
// Just compact
for await (const event of session.compact()) { ... }

// Compact, then send a message
for await (const event of session.compact('Continue from where we left off')) { ... }
```

### `session.activeQuery`

The underlying SDK [`Query`](https://docs.anthropic.com/en/docs/agent-sdk) object for the current session. Use this for SDK features like model switching, interrupts, and MCP server management.

```ts
session.activeQuery?.setModel('claude-opus-4-6')
session.activeQuery?.interrupt()
session.activeQuery?.setMcpServers({ ... })
```

Returns `null` before the first `send()` call.

### `session.contextStatus`

Snapshot of current context usage.

```ts
const status = session.contextStatus
// {
//   totalTokens: 145000,
//   thresholdTokens: 160000,
//   coldTokens: 12000,
//   warmTokens: 53000,
//   hotTokens: 80000,
//   compactionCount: 3,
//   sdkSessionCount: 7,
//   usage: 0.72,
// }
```

### `session.turns`

Read-only array of conversation turn groups. Each turn group contains a user message and all assistant responses before the next user message.

### `session.compactions`

Read-only array of compaction records (summaries generated so far).

### `session.metaSessionId`

The session ID. Save this to resume later with `new MetaSession({ metaSessionId: id })`.

### `session.name`

The session's human-readable name, or `null` if not named.

### `session.rename(name)`

Give the session a human-readable name for easier identification when listing sessions.

```ts
session.rename('auth refactor')
```

### `MetaSession.list(options?)`

Static method. List saved sessions, most recently active first. Returns `SessionSummary[]` with the session ID, name, model, cwd, turn/compaction counts, and the first + last user messages as previews.

```ts
// List all sessions
const sessions = MetaSession.list()

// List sessions for a specific directory
const sessions = MetaSession.list({ cwd: '/my/project' })

// Each summary looks like:
// {
//   metaSessionId: 'abc-123',
//   sessionName: 'auth refactor',
//   createdAt: '2026-02-23T...',
//   model: 'claude-sonnet-4-5',
//   cwd: '/my/project',
//   turnCount: 42,
//   compactionCount: 3,
//   firstMessage: 'Help me refactor the auth module',
//   lastMessage: 'Looks good, let\'s add tests',
// }

// Resume by name (find it, then pass the ID)
const target = sessions.find(s => s.sessionName === 'auth refactor')
if (target) {
  const session = new MetaSession({ metaSessionId: target.metaSessionId })
}
```

## Session events

| Event | Fields | Description |
|-------|--------|-------------|
| `stream_text` | `text` | Streaming text delta |
| `stream_thinking` | `text` | Streaming thinking delta |
| `tool_use` | `toolName`, `toolUseId`, `input` | Tool invocation |
| `tool_use_summary` | `summary`, `toolUseIds` | Summary of tool results |
| `tool_progress` | `toolName`, `toolUseId`, `elapsedSeconds` | Running tool progress |
| `result` | `costUsd`, `numTurns`, `durationMs`, `inputTokens`, `outputTokens` | Turn completed |
| `error` | `message` | Error occurred |
| `compaction` | `phase`, `detail?` | Compaction progress (`started`, `summarizing`, `transplanting`, `completed`) |

## Examples

### Custom compaction prompt

```ts
const session = new MetaSession({
  model: 'claude-opus-4-6',
  cwd: process.cwd(),
  compactionPrompt: `
    Summarize as a structured changelog.
    Focus on: decisions made, files modified, tests passing/failing.
    Keep all file paths and error messages.
  `,
})
```

### Cheap summarization

Use a smaller model for compaction to save costs on long sessions:

```ts
const session = new MetaSession({
  model: 'claude-opus-4-6',
  compactionModel: 'claude-haiku-3-5',
  cwd: process.cwd(),
})
```

### Aggressive compaction

Compact earlier and keep fewer recent turns:

```ts
const session = new MetaSession({
  model: 'claude-sonnet-4-5',
  cwd: process.cwd(),
  compactionThreshold: 0.6,
  hotTurnFraction: 0.3,
})
```

### Ephemeral sessions

No persistence — session state lives only in memory:

```ts
const session = new MetaSession({
  model: 'claude-sonnet-4-5',
  cwd: process.cwd(),
  logDir: null,
})
```

### With MCP servers and hooks

SDK features pass through alongside rolling context management:

```ts
import { MetaSession } from 'claude-rolling-context'
import { createSdkMcpServer, tool } from '@anthropic-ai/claude-agent-sdk'
import { z } from 'zod/v4'

const server = createSdkMcpServer({
  name: 'my-tools',
  tools: [
    tool('lookup', 'Look up a record', { id: z.string() },
      async ({ id }) => ({ content: [{ type: 'text', text: `Record ${id}: ...` }] })
    ),
  ],
})

const session = new MetaSession({
  model: 'claude-sonnet-4-5',
  cwd: process.cwd(),
  mcpServers: { 'my-tools': server },
  hooks: {
    PostToolUse: [{ hooks: [async (input) => {
      console.log(`Tool used: ${input.tool_name}`)
      return {}
    }] }],
  },
  compactionThreshold: 0.7,
  compactionModel: 'claude-haiku-3-5',
})
```

### Resuming across process restarts

```ts
// First run — name the session so you can find it later
const session = new MetaSession({
  model: 'claude-sonnet-4-5',
  cwd: '/my/project',
})
session.rename('feature-xyz')

for await (const event of session.send('Start working on the feature')) { ... }

// Later — different process, find it by name
const sessions = MetaSession.list({ cwd: '/my/project' })
const target = sessions.find(s => s.sessionName === 'feature-xyz')

if (target) {
  const resumed = new MetaSession({
    metaSessionId: target.metaSessionId,
    cwd: '/my/project',
  })

  // Picks up where we left off, with full rolling context
  for await (const event of resumed.send('How far did we get?')) { ... }
}
```
