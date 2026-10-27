import type { Register } from 'claude-code'
import { plan, configFor, instructionsFor, markerFor, withVoice } from './plan'

const k = (n: number) => `${Math.round(n / 1000)}k`

export const register: Register = (on) => {
  // A precomputed summary would cover the whole conversation, not our chunk.
  on('session.compact', { trigger: 'precompute' }, () => ({
    skip: 'rolling-context summarizes only the newest chunk, at compaction time',
  })).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    // Subagents and forks keep the engine's plain compaction, in our voice.
    if (e.agentId !== undefined || e.trigger === 'precompute') return next({ ...e, instructions: withVoice(e.instructions) })

    const cfg = configFor((await $.session.usage()).context.window)
    const p = plan(e.messages, cfg)
    if (!p) return next({ ...e, instructions: withVoice(e.instructions) })

    const instructions = withVoice(e.instructions, instructionsFor(p, cfg))
    const result = await next({ ...e, messages: p.chunk, instructions })
    if (result.skip !== undefined) return result

    $.ui.log(
      `rolling-context: block ${p.folded ? '1 (merged)' : p.index} summarizes ${p.chunk.length} msgs (~${k(p.tokens.chunk)}); ` +
        `verbatim: ${p.head.length} opening (~${k(p.tokens.head)}) + ${p.tail.length} recent (~${k(p.tokens.tail)})`,
    )
    return {
      ...result,
      messages: [...p.head, ...p.summaries, markerFor(p, new Date()), ...result.messages, ...p.tail],
      tokensAfter: undefined,
    }
  }).catch(($, e, next) => {
    // Failed before handing the chunk down: plain compaction of everything.
    if (!next.called) return next(e)
    // Failed after: replaying next(e) would give back the chunk's summary
    // alone and drop everything around it. Leave the conversation as it is.
    return { skip: `rolling-context failed (${next.error.message ?? next.error.kind}); conversation left uncompacted` }
  })
}
