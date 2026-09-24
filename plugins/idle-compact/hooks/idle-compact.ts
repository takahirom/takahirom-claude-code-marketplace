import type { EngineInterface, Register, Timer } from 'claude-code'

// Compact once after the main conversation has been idle for 50 minutes, while
// the 1h prompt cache is still warm. One one-shot timer at most; no polling,
// no keep-alive, and nothing is re-armed after the compaction.
export const IDLE_MS = 50 * 60 * 1000
// Past this the cache may already be cold (the Mac slept, the timer ran late),
// so compacting would re-cache the whole context: do nothing instead.
export const LATEST_MS = 58 * 60 * 1000

type Armed = {
  generation: number
  timer: Timer
  sessionId: string
  armedAt: number
}

type State = {
  generation: number
  armed: Armed | null
  currentTurnId: string | null
  isCompacting: boolean
}

// Debug log only (--debug / --debug-file): never shown to the person.
async function log($: EngineInterface, text: string) {
  try {
    await $.ui.log(`idle-compact: ${text}`, { to: 'debug' })
  } catch {}
}

function cancel(state: State) {
  state.generation++
  state.armed?.timer.cancel()
  state.armed = null
}

async function arm($: EngineInterface, state: State) {
  cancel(state)
  const generation = state.generation
  const armedAt = await $.clock.now()
  const sessionId = await $.session.id()
  if (state.generation !== generation) return
  const timer = $.clock.after(IDLE_MS, () => void fire($, state, generation))
  state.armed = { generation, timer, sessionId, armedAt }
  await log($, `armed at ${new Date(armedAt).toISOString()}`)
}

async function fire($: EngineInterface, state: State, generation: number) {
  const armed = state.armed
  if (armed === null || armed.generation !== generation || state.isCompacting) return
  state.armed = null
  try {
    const elapsed = (await $.clock.now()) - armed.armedAt
    const minutes = (elapsed / 60000).toFixed(1)
    if (elapsed < IDLE_MS || elapsed >= LATEST_MS) {
      await log($, `fired after ${minutes} min: outside the window, skipped`)
      return
    }
    if ((await $.session.id()) !== armed.sessionId) {
      await log($, `fired after ${minutes} min: session changed, skipped`)
      return
    }
    if (state.generation !== generation) return
    state.isCompacting = true
    await log($, `fired after ${minutes} min: compacting`)
    await $.session.compact()
    await log($, 'compaction finished')
  } catch (error) {
    // A running turn, DISABLE_COMPACT or a headless host: no retry, by design.
    await log($, `compaction failed: ${error instanceof Error ? error.message : String(error)}`)
  } finally {
    state.isCompacting = false
  }
}

export const register: Register = (on) => {
  const state: State = { generation: 0, armed: null, currentTurnId: null, isCompacting: false }

  on('turn.start', ($, e, next) => {
    cancel(state)
    state.currentTurnId = e.turnId
    return next(e)
  })

  on('turn.complete', async ($, e, next) => {
    const result = await next(e)
    // Main loop only (subagent runs carry agentId and raise no turn.start),
    // answered normally, and not a completion raised by our own compaction.
    if (e.agentId !== undefined || e.reason !== 'answer' || state.isCompacting) return result
    if (e.turnId !== state.currentTurnId) return result
    state.currentTurnId = null
    await arm($, state)
    return result
  })

  // The person's /compact (or an automatic one) is activity too: the pending
  // timer would only compact the fresh summary again.
  on('session.compact', ($, e, next) => {
    if (e.agentId === undefined && (e.trigger === 'manual' || e.trigger === 'auto')) cancel(state)
    return next(e)
  })

  on('session.end', ($, e, next) => {
    cancel(state)
    state.currentTurnId = null
    return next(e)
  })
}
