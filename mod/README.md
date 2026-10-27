# rolling-context (Claude Code mod)

The in-session successor to the `MetaSession` wrapper in this repo. Instead of wrapping the Agent SDK and transplanting session files, it hooks Claude Code's own compaction (`session.compact`), so it works in the terminal and the desktop app with no wrapper.

Claude Code's default compaction is all-or-nothing: when the window fills, the whole conversation becomes one summary and a new instance gets handed notes. This mod keeps it one continuous context instead:

```
                                                   200k window   1M window
head        the opening turns, verbatim           ~12k          ~30k     never moves
summaries   [rolling-context · block 1] …         ≤40k          ≤80k     one block per compaction,
            [rolling-context · block 2] …                                appended; merged once
            …                                                            only past the budget
tail        the most recent turns, verbatim       ~40k          ~200k
```

- **The engine decides when.** It rolls at Claude Code's own auto-compact threshold, mid-turn while work is happening, never on an idle session. Each roll summarizes only the stretch since the last block. On a 1M window, `"autoCompactWindow": 600000` in settings.json rolls at ~600k instead of near the limit; 200k models are capped to their own window, so it leaves them as they are.
- **The summarizer sees only its chunk:** the messages since the last block, up to the tail. It's given the opening and earlier blocks as read-only orientation, so it writes from that moment and knows where its chunk sits.
- **First-person voice.** Summaries are written as notes from Claude to itself: the relationship and tone, live state, promises, decisions, dead ends, its own threads.
- **Safe cuts.** Boundaries land only where a tool call can't be separated from its result. If a single live turn is bigger than the tail budget, the cut goes inside it, before an assistant message.
- **Real token counts.** Budgets are planned with chars/4 per message, then scaled by the engine's real context count at compaction time (×2.5 on TypeScript in testing), so the verbatim zones stay the size they claim.
- **Honest about it.** The engine's summary tells the model to resume "as if the break never happened"; the mod drops that line (keeping the transcript path) and the block marker says it's fine to mention the compaction.
- **Cache-friendly.** The head and earlier blocks are a stable prefix, so the prompt cache survives a compaction.
- **Fails safe.** If anything throws before the handoff, the engine compacts as usual. If it throws after, the conversation is left as it was rather than losing the head or tail. Subagents keep plain compaction.

## Install

```
/plugin marketplace add mermachine/claude-rolling-context
/plugin install rolling-context@claude-rolling-context
```

Budgets live in `CONFIG` (200k) and `LARGE_CONFIG` (1M) at the top of `hooks/plan.ts`.

## Develop

```
claude plugin validate mod
claude plugin test mod
```
