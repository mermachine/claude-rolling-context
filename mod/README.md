# rolling-context (Claude Code mod)

The in-session successor to the `MetaSession` wrapper in this repo. Instead of wrapping the Agent SDK and transplanting session files, it hooks Claude Code's own compaction (`session.compact`), so it works in the terminal and the desktop app with no wrapper.

Claude Code's default compaction is all-or-nothing: when the window fills, the whole conversation becomes one summary and a new instance gets handed notes. This mod keeps it one continuous context instead:

```
head        the opening turns, verbatim           ~12k tokens, never moves
summaries   [rolling-context · block 1] …         one block per compaction, appended
            [rolling-context · block 2] …         (never re-summarized until they
            …                                      outgrow 40k, then merged once)
tail        the most recent turns, verbatim       ~40k tokens
```

- **Small and often.** Once the context passes 150k tokens, it compacts between turns rather than waiting for the window to fill, so each block covers one stretch of work.
- **The summarizer sees only its chunk:** the messages since the last block, up to the tail. It's given the opening and earlier blocks as read-only orientation, so it writes from that moment and knows where its chunk sits.
- **First-person voice.** Summaries are written as notes from Claude to itself: the relationship and tone, live state, promises, decisions, dead ends, its own threads.
- **Safe cuts.** Boundaries land only where a tool call can't be separated from its result. If a single live turn is bigger than the tail budget, the cut goes inside it, before an assistant message.
- **Cache-friendly.** The head and earlier blocks are a stable prefix, so the prompt cache survives a compaction.
- **Fails safe.** If anything throws before the handoff, the engine compacts as usual. If it throws after, the conversation is left as it was rather than losing the head or tail. Subagents keep plain compaction.

Headless hosts (the desktop app, `-p`, the SDK) can't call `$.session.compact` from a plugin yet, so there it queues `/compact`, which runs through the same hook.

## Install

```
/plugin marketplace add mermachine/claude-rolling-context
/plugin install rolling-context@claude-rolling-context
```

Budgets live in `CONFIG` at the top of `hooks/plan.ts`.

## Develop

```
claude plugin validate mod
claude plugin test mod
```
