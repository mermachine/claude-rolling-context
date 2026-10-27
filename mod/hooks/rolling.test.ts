import { test, expect } from 'claude-code/testing'
import type { SessionMessage } from 'claude-code'
import { plan, configFor, MARKER, CONFIG, LARGE_CONFIG } from './plan'

let h = 0
const user = (text: string): SessionMessage => ({ role: 'user', text, toolUses: [], handle: `h${h++}` })
const asst = (text: string): SessionMessage => ({ role: 'assistant', text, toolUses: [], handle: `h${h++}` })
const filler = (tokens: number) => 'x'.repeat(tokens * 4)

// A tool-using turn: prompt, a tool call, its result, the reply.
function toolTurn(i: number, tokens: number): SessionMessage[] {
  return [
    user(`prompt ${i}`),
    { role: 'assistant', text: '', toolUses: [{ tool_use_id: `t${i}`, tool: 'Bash', input: { command: 'ls' } }], handle: `h${h++}` },
    { role: 'user', text: '', toolUses: [], toolResults: [{ tool_use_id: `t${i}`, text: filler(tokens) } as any], handle: `h${h++}` },
    asst(`reply ${i}`),
  ]
}
const turns = (from: number, to: number, tokens = 5_000) => {
  const out: SessionMessage[] = []
  for (let i = from; i <= to; i++) out.push(...toolTurn(i, tokens))
  return out
}
const conversation = (n: number) => [user('hi QwQ'), asst('hi!!'), ...turns(1, n)]

// The session's model window, as $.session.usage() reports it.
const windowOf = (window: number) => () => ({ value: { startedAt: 0, context: { window } } }) as any

// Stands in for the engine's summarizer: one summary message per chunk.
const summarizer = (seen: { chunk?: readonly SessionMessage[]; told?: string }[] = []) =>
  (_$: unknown, e: { messages: readonly SessionMessage[]; instructions?: string }) => {
    seen.push({ chunk: e.messages, told: e.instructions })
    return { messages: [user(`This session is being continued from a previous conversation. SUMMARY of ${e.messages.length}`)] }
  }

test('first compaction: opening + recent verbatim, the middle summarized', () => {
  const msgs = conversation(40)
  const p = plan(msgs)!
  expect(p.head[0]!.text).toBe('hi QwQ')
  expect(p.tokens.head <= CONFIG.headTokens).toBe(true)
  expect(p.tokens.tail <= CONFIG.tailTokens).toBe(true)
  expect(p.summaries.length).toBe(0)
  expect(p.head.length + p.chunk.length + p.tail.length).toBe(msgs.length)
  expect(p.tail.at(-1)!.text).toBe('reply 40')
})

test('cuts never separate a tool call from its result', () => {
  const p = plan(conversation(40))!
  for (const part of [p.chunk, p.tail]) expect((part[0]!.toolResults?.length ?? 0) === 0).toBe(true)
})

test('one enormous live turn: the tail cuts inside it, before an assistant message', () => {
  const msgs = conversation(20)
  msgs.push(user('do the big thing'))
  for (let j = 0; j < 20; j++) msgs.push(...toolTurn(1000 + j, 5_000).slice(1, 3))
  const p = plan(msgs)!
  expect(p.tail[0]!.role).toBe('assistant')
  expect(p.tokens.tail <= CONFIG.tailTokens).toBe(true)
})

test('too little to roll up: no plan', () => {
  expect(plan(conversation(3))).toBe(null)
})

test('the summarizer sees only the chunk, told what surrounds it', async ($, on) => {
  const seen: { chunk?: readonly SessionMessage[]; told?: string }[] = []
  on('session.usage', windowOf(200_000))
  on('session.compact', summarizer(seen) as any)
  const msgs = conversation(40)
  const p = plan(msgs)!
  const out = await $.session.compact({ trigger: 'manual', messages: msgs, instructions: 'keep the plan' })
  if (out.skip !== undefined) throw new Error(out.skip)
  expect(seen[0]!.chunk!.length).toBe(p.chunk.length)
  expect(seen[0]!.told!.startsWith('keep the plan')).toBe(true)
  expect(seen[0]!.told!.includes('first person')).toBe(true)
  expect(seen[0]!.told!.includes('ONE CHUNK')).toBe(true)
  expect(seen[0]!.told!.includes('hi QwQ')).toBe(true) // orientation: how it opened
  // head, marker, summary, tail
  expect(out.messages.length).toBe(p.head.length + 2 + p.tail.length)
  expect(out.messages[0]!.text).toBe('hi QwQ')
  expect(out.messages[p.head.length]!.text.startsWith(MARKER)).toBe(true)
  expect(out.messages.at(-1)!.text).toBe('reply 40')
})

test('summaries accumulate as blocks; the head never moves; old blocks are not re-summarized', async ($, on) => {
  const seen: { chunk?: readonly SessionMessage[]; told?: string }[] = []
  on('session.usage', windowOf(200_000))
  on('session.compact', summarizer(seen) as any)
  let msgs: readonly SessionMessage[] = conversation(40)
  const headHandles = plan(msgs)!.head.map(m => m.handle)
  for (let round = 0; round < 3; round++) {
    const out = await $.session.compact({ trigger: 'plugin', messages: msgs })
    if (out.skip !== undefined) throw new Error(out.skip)
    msgs = [...out.messages, ...turns(100 + round * 40, 139 + round * 40)]
  }
  expect(msgs.slice(0, headHandles.length).map(m => m.handle)).toEqual(headHandles)
  const markers = msgs.filter(m => m.text.startsWith(MARKER)).map(m => m.text.split(' · ')[1])
  expect(markers).toEqual(['block 1', 'block 2', 'block 3'])
  // the third summarizer call saw only new material, plus earlier summaries as orientation
  expect(seen[2]!.chunk!.some(m => m.text.startsWith(MARKER))).toBe(false)
  expect(seen[2]!.told!.includes('SUMMARY of')).toBe(true)
})

test('summary blocks past their budget are merged into the next chunk', () => {
  const big = (i: number) => [user(`${MARKER} · block ${i} · x] s`), user(`This session is being continued from a previous conversation. ${filler(15_000)}`)]
  const msgs = [user('hi QwQ'), asst('hi!!'), ...big(1), ...big(2), ...big(3), ...turns(1, 40)]
  const p = plan(msgs)!
  expect(p.folded).toBe(true)
  expect(p.summaries.length).toBe(0)
  expect(p.chunk[0]!.text.startsWith(MARKER)).toBe(true)
  expect(p.head.length).toBe(2)
})

test('nothing to roll falls back to plain compaction; precompute skipped; subagents untouched', async ($, on) => {
  let calls = 0
  on('session.usage', windowOf(200_000))
  on('session.compact', (_$, e) => (calls++, { messages: e.messages }))
  const small = await $.session.compact({ trigger: 'auto', messages: conversation(3) })
  if (small.skip !== undefined) throw new Error(small.skip)
  expect(small.messages.length).toBe(conversation(3).length)
  const pre = await $.session.compact({ trigger: 'precompute', messages: conversation(40) })
  expect(typeof pre.skip).toBe('string')
  const sub = await $.session.compact({ trigger: 'auto', agentId: 'agent-1', messages: conversation(40) })
  if (sub.skip !== undefined) throw new Error(sub.skip)
  expect(sub.messages.length).toBe(conversation(40).length)
  expect(calls).toBe(2)
})

test('on a 1M window, far more stays verbatim', async ($, on) => {
  on('session.usage', windowOf(1_000_000))
  on('session.compact', summarizer() as any)
  const msgs = conversation(120) // ~600k
  const big = plan(msgs, LARGE_CONFIG)!
  const out = await $.session.compact({ trigger: 'auto', messages: msgs })
  if (out.skip !== undefined) throw new Error(out.skip)
  expect(out.messages.length).toBe(big.head.length + 2 + big.tail.length)
  expect(big.tokens.tail > CONFIG.tailTokens * 4).toBe(true)
  expect(big.tokens.tail <= LARGE_CONFIG.tailTokens).toBe(true)
})

test('picks the larger budgets on a 1M window', () => {
  expect(configFor(1_000_000)).toBe(LARGE_CONFIG)
  expect(configFor(200_000)).toBe(CONFIG)
  expect(configFor(undefined)).toBe(CONFIG)
})
