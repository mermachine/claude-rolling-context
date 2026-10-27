import type { Register } from 'claude-code'
import { plan, shouldRoll, instructionsFor, markerFor, withVoice } from './plan'

const k = (n: number) => `${Math.round(n / 1000)}k`

export const register: Register = (on) => {
  let pending = false

  // Small and often: once the context passes the trigger, compact between
  // turns rather than waiting for the window to fill.
  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    if (e.agentId !== undefined || e.isAborted || pending) return result
    const { context } = await $.session.usage()
    if (!shouldRoll(context.tokens, await $.session.messages())) return result
    pending = true
    $.clock.after(1_500, () => {
      $.session
        .compact()
        // Headless hosts (the desktop app, -p, the SDK) can't compact from a
        // plugin yet; the /compact command, queued until idle, goes through
        // the same session.compact hook below.
        .catch((err: unknown) =>
          String((err as Error)?.message ?? err).includes('headless') ? $.command.run({ command: 'compact' }) : undefined,
        )
        .catch(() => {}) // a new turn started first; the next turn.complete tries again
        .finally(() => (pending = false))
    })
    return result
  }).catch(($, e, next) => next(e))

  // A precomputed summary would cover the whole conversation, not our chunk.
  on('session.compact', { trigger: 'precompute' }, () => ({
    skip: 'rolling-context summarizes only the newest chunk, at compaction time',
  })).catch(($, e, next) => next(e))

  on('session.compact', async ($, e, next) => {
    // Subagents and forks keep the engine's plain compaction, in our voice.
    if (e.agentId !== undefined || e.trigger === 'precompute') return next({ ...e, instructions: withVoice(e.instructions) })

    const p = plan(e.messages)
    if (!p) {
      // Our own trigger never forces a full compaction; the engine's may.
      if (e.trigger === 'plugin') return { skip: 'rolling-context: nothing new to roll up yet' }
      return next({ ...e, instructions: withVoice(e.instructions) })
    }

    const instructions = withVoice(e.instructions, instructionsFor(p))
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
