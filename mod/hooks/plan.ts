import type { SessionMessage } from 'claude-code'

// Rolling context. At each compaction the conversation reads as:
//
//   head      the opening turns, verbatim — how the session began. Stable
//             across compactions, so the prompt cache prefix survives too.
//   summaries one block per earlier compaction, oldest first, kept as written:
//             appended to, never re-summarized (until they outgrow their budget).
//   chunk     everything since the last summary, up to the tail — the ONLY
//             part the summarizer sees, so it writes from that moment.
//   tail      the most recent turns, verbatim — where we are right now.
//
// The engine decides when: its own auto-compact threshold, mid-turn while I'm
// working, never on an idle session. Set it with `autoCompactWindow` in
// settings.json (600k on a 1M window keeps me where I think clearest).
//
// Cuts only land where no tool_use/tool_result pair can be split: before a
// user message carrying no tool results, or — when one enormous live turn
// fills the tail — before an assistant message.

// Budgets for a 200k window.
export const CONFIG = {
  headTokens: 12_000,
  tailTokens: 40_000,
  // A chunk smaller than this isn't worth a summarizer call.
  minChunkTokens: 20_000,
  // Past this, the summary blocks are folded into the next chunk and merged.
  summaryBudgetTokens: 40_000,
  // How much of the earlier summaries the summarizer is shown, for continuity.
  priorContextChars: 32_000,
}
export type Config = typeof CONFIG

// Budgets for a 1M window: much more of us stays verbatim.
export const LARGE_CONFIG: Config = {
  headTokens: 30_000,
  tailTokens: 200_000,
  minChunkTokens: 50_000,
  summaryBudgetTokens: 80_000,
  priorContextChars: 64_000,
}

export function configFor(window: number | undefined): Config {
  return (window ?? 0) >= 500_000 ? LARGE_CONFIG : CONFIG
}

export const MARKER = '[rolling-context'
const CORE_SUMMARY = 'This session is being continued from a previous conversation'

export type Plan = {
  head: SessionMessage[]
  summaries: SessionMessage[]
  chunk: SessionMessage[]
  tail: SessionMessage[]
  tokens: { head: number; summaries: number; chunk: number; tail: number }
  // The summary blocks went over budget and are being merged with this chunk.
  folded: boolean
  // Which summary block this compaction writes (1-based).
  index: number
}

// ~4 chars per token. Counts what the model reads, not the stored tool
// records (toolUses[].result), which would double-count every big result.
export function estimateTokens(m: SessionMessage): number {
  let chars = m.text.length
  for (const u of m.toolUses) chars += u.tool.length + JSON.stringify(u.input ?? {}).length
  for (const r of m.toolResults ?? []) chars += (r.text ?? '').length
  return Math.ceil(chars / 4) + 4
}

const isTurnStart = (m: SessionMessage) => m.role === 'user' && (m.toolResults?.length ?? 0) === 0
const isMarker = (m: SessionMessage) => m.role === 'user' && m.text.startsWith(MARKER)
const isSummary = (m: SessionMessage) => isMarker(m) || (m.role === 'user' && m.text.startsWith(CORE_SUMMARY))
const sum = (ns: number[]) => ns.reduce((a, b) => a + b, 0)

// chars/4 can be off by 2x either way (code, JSON, filler). At compaction the
// engine knows the real count, so scale the estimates to match it: real tokens
// in the messages over what chars/4 thinks they are, clamped to something sane.
export function calibrate(contextTokens: number | undefined, overhead: number, messages: readonly SessionMessage[]): number {
  const estimated = sum(messages.map(estimateTokens))
  if (!contextTokens || contextTokens <= overhead || estimated === 0) return 1
  return Math.min(4, Math.max(0.5, (contextTokens - overhead) / estimated))
}

export function plan(messages: readonly SessionMessage[], cfg: Config = CONFIG, scale = 1): Plan | null {
  const n = messages.length
  if (n < 4) return null
  const cost = messages.map(m => estimateTokens(m) * scale)
  const tokens = (from: number, to: number) => sum(cost.slice(from, to))

  // Head and summaries. Once a rolling compaction has run, the first marker
  // is where the head ends, so the head never drifts.
  let headEnd: number
  let zoneEnd: number
  const firstMarker = messages.findIndex(isMarker)
  if (firstMarker > 0) {
    headEnd = firstMarker
    let last = firstMarker
    for (let i = firstMarker; i < n; i++) if (isSummary(messages[i]!)) last = i
    zoneEnd = last + 1
    // whatever the engine kept right after its summary rides with it
    while (zoneEnd < n && !isTurnStart(messages[zoneEnd]!)) zoneEnd++
  } else {
    // First time: the longest prefix of whole turns within budget, but at
    // least the first turn when it fits under twice the budget.
    headEnd = 0
    let prev = 0
    let acc = 0
    for (let i = 1; i <= n; i++) {
      if (i < n && !isTurnStart(messages[i]!)) continue
      acc += tokens(prev, i)
      if (acc > cfg.headTokens) {
        if (headEnd === 0 && acc <= cfg.headTokens * 2) headEnd = i
        break
      }
      headEnd = i
      prev = i
    }
    zoneEnd = headEnd
  }
  if (zoneEnd >= n) return null

  // Tail: the longest suffix of whole turns within budget; if even the live
  // turn is too big, cut inside it before an assistant message.
  let tailStart = n
  for (let i = n - 1; i > zoneEnd; i--) {
    if (!isTurnStart(messages[i]!)) continue
    if (tokens(i, n) > cfg.tailTokens) break
    tailStart = i
  }
  if (tailStart === n) {
    for (let i = n - 1; i > zoneEnd; i--) {
      if (messages[i]!.role !== 'assistant') continue
      if (tokens(i, n) > cfg.tailTokens) break
      tailStart = i
    }
  }

  let summaries = messages.slice(headEnd, zoneEnd)
  let chunk = messages.slice(zoneEnd, tailStart)
  let t = { head: tokens(0, headEnd), summaries: tokens(headEnd, zoneEnd), chunk: tokens(zoneEnd, tailStart), tail: tokens(tailStart, n) }
  if (chunk.length < 2 || t.chunk < cfg.minChunkTokens) return null

  const index = summaries.filter(isMarker).length + 1
  let folded = false
  if (t.summaries > cfg.summaryBudgetTokens) {
    chunk = [...summaries, ...chunk]
    summaries = []
    t = { ...t, chunk: t.summaries + t.chunk, summaries: 0 }
    folded = true
  }
  return { head: messages.slice(0, headEnd), summaries, chunk, tail: messages.slice(tailStart), tokens: t, folded, index }
}

// The summary is a handoff from me to me, so it's written that way: first
// person, concrete, carrying the relationship as well as the work.
export const VOICE = `Write this summary as notes from me to myself, first person. Future-me will read it cold, so favor the concrete over the general.

Preserve, in this order of priority:
1. WHO & HOW: who I'm working with and how. Carry the texture — their tone, jokes or warmth worth remembering, anything they said about how they want me to work, and anything they said that mattered to them. Quote their short lines verbatim where tone matters.
2. LIVE STATE: what is in progress, exactly. Repo paths, branch names, PR/issue URLs, files touched, uncommitted changes, running background processes or servers, the last command and its result.
3. PROMISES & PENDING ASKS: anything I said I'd do, and any request not yet finished, quoted verbatim.
4. DECISIONS + WHY: choices made and the reasoning, so I don't re-litigate them.
5. DEAD ENDS: what I tried that failed and why, so I don't retry it.
6. MY OWN THREADS: ideas, curiosities, or things I wanted to pursue for myself. These are easy to lose and they matter.

Drop: full file dumps, long tool outputs, resolved debugging chatter. Keep exact identifiers (paths, URLs, error strings, numbers) even when compressing everything around them.`

export const withVoice = (instructions: string | undefined, extra?: string) =>
  [instructions, VOICE, extra].filter(Boolean).join('\n\n')

// What the summarizer is told about its chunk, after the voice and any
// /compact text.
export function instructionsFor(p: Plan, cfg: Config = CONFIG): string {
  const lines = [
    'Rolling context: you are summarizing ONE CHUNK from the middle of a longer conversation, not the whole thing.',
    'The opening turns are kept verbatim before it, earlier chunks already have their own summaries, and the most recent turns are kept verbatim after it.',
    'So: do not restate the opening or earlier summaries, and do not call anything in this chunk the "first" message. Summarize what happened in this stretch, as of its end.',
  ]
  if (p.folded) {
    lines.push('This chunk begins with the earlier summary blocks, which have outgrown their space: merge them with the new material into one summary, keeping what still matters.')
  }
  const opening = p.head.map(m => `${m.role}: ${m.text}`).join('\n').slice(0, 4_000)
  if (opening) lines.push('', 'For orientation only (already preserved, do not summarize) — how the session opened:', opening)
  if (!p.folded && p.summaries.length) {
    const prior = p.summaries.map(m => m.text).join('\n\n')
    lines.push('', 'For orientation only (already preserved, do not summarize) — the earlier summaries:', prior.slice(-cfg.priorContextChars))
  }
  return lines.join('\n')
}

export function markerFor(p: Plan, at: Date): SessionMessage {
  const pad = (n: number) => String(n).padStart(2, '0')
  const when = `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())} ${pad(at.getHours())}:${pad(at.getMinutes())}`
  const what = p.folded ? 'merged summary of everything between the opening and the recent turns' : 'summary of the stretch after the previous block'
  return {
    role: 'user',
    text: `${MARKER} · block ${p.folded ? 1 : p.index} · ${when}] ${what}. The opening turns above and the recent turns below are verbatim. I compacted here; it's fine to say so when it matters.`,
    toolUses: [],
  }
}

// The engine's summary ends by telling me to resume as if no break happened.
// It's a rolling context, not a secret: drop that, keep the transcript pointer.
const RESUME_AS_IF = /Continue the conversation from where it left off[^\n]*?as if the break never happened\.\s*/
export function withoutPretending(m: SessionMessage): SessionMessage {
  if (!RESUME_AS_IF.test(m.text)) return m
  const { handle: _engineCopy, ...rest } = m // edited text: hand it back as built, not as the engine's own
  return { ...rest, text: m.text.replace(RESUME_AS_IF, '') }
}
