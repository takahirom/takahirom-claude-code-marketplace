import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const MIN = 60 * 1000
const T0 = 1_700_000_000_000

const SUMMARY = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

type World = {
  compacts: number
  sessionId: string
  usage?: Record<string, number>
  onCompact?: () => unknown
  onSessionId?: () => unknown
}

// The engine beneath the plugin: every event it raises or calls answered here.
function world(on: On): World {
  const w: World = { compacts: 0, sessionId: 'session-a' }
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', async () => {
    await w.onSessionId?.()
    return { value: w.sessionId }
  })
  on('session.compact', async () => {
    w.compacts++
    await w.onCompact?.()
    return w.usage === undefined ? { messages: SUMMARY } : { messages: SUMMARY, usage: w.usage }
  })
  return w
}

let turns = 0
async function mainTurn($: Engine) {
  const turnId = `turn-${++turns}`
  await $.turn.start({ text: 'hi', turnId })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
  return turnId
}

describe('idle compact', () => {
  test('does not compact at 49:59', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on)
    await mainTurn($)
    await clock.advance(50 * MIN - 1000)
    expect(w.compacts).toBe(0)
  })

  test('compacts once at 50:00 and does not re-arm', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on)
    await mainTurn($)
    await clock.advance(50 * MIN)
    expect(w.compacts).toBe(1)
    await clock.advance(5 * 60 * MIN)
    expect(w.compacts).toBe(1)
  })

  test('a new turn cancels the old timer and the next idle period counts from its completion', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on)
    await mainTurn($)
    await clock.advance(30 * MIN)
    const turnId = `turn-${++turns}`
    await $.turn.start({ text: 'again', turnId })
    await clock.advance(30 * MIN)
    // The first timer would have fired at 50 minutes: it was cancelled.
    expect(w.compacts).toBe(0)
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId, reason: 'answer' })
    await clock.advance(50 * MIN - 1000)
    expect(w.compacts).toBe(0)
    await clock.advance(1000)
    expect(w.compacts).toBe(1)
  })

  test('a subagent turn.complete does not arm', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on)
    await $.turn.complete({
      answer: 'ok', durationMs: 1, isAborted: false, turnId: 'agent-turn', reason: 'answer', agentId: 'agent-1',
    })
    await clock.advance(2 * 60 * MIN)
    expect(w.compacts).toBe(0)
  })

  test('an aborted or failed main turn does not arm', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on)
    await $.turn.start({ text: 'hi', turnId: 'aborted' })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 'aborted', reason: 'aborted' })
    await $.turn.start({ text: 'hi', turnId: 'error' })
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'error', reason: 'error' })
    await clock.advance(2 * 60 * MIN)
    expect(w.compacts).toBe(0)
  })

  test('session.end cancels the pending timer', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on)
    await mainTurn($)
    await clock.advance(10 * MIN)
    await $.session.end({ reason: 'clear', sessionId: 'session-a', resume: { id: 'session-a' } })
    await clock.advance(2 * 60 * MIN)
    expect(w.compacts).toBe(0)
  })

  test('a different session id at fire time does not compact', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on)
    await mainTurn($)
    w.sessionId = 'session-b'
    await clock.advance(50 * MIN)
    expect(w.compacts).toBe(0)
  })

  test('the compaction itself never re-arms the timer', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on)
    w.onCompact = async () => {
      // Whatever the compaction raises on its way, a completion included.
      await $.turn.start({ text: '', turnId: 'compact-turn' })
      await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'compact-turn', reason: 'answer' })
    }
    await mainTurn($)
    await clock.advance(50 * MIN)
    expect(w.compacts).toBe(1)
    await clock.advance(5 * 60 * MIN)
    expect(w.compacts).toBe(1)
  })

  test('a failed compaction is not retried', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on)
    w.onCompact = () => {
      throw new Error('compaction is switched off')
    }
    await mainTurn($)
    await clock.advance(50 * MIN)
    expect(w.compacts).toBe(1)
    await clock.advance(5 * 60 * MIN)
    expect(w.compacts).toBe(1)
  })

  test('repeated completions keep a single timer', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on)
    await mainTurn($)
    await mainTurn($)
    await clock.advance(1 * MIN)
    await mainTurn($)
    // A duplicate completion of the same turn does not arm a second timer.
    await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: `turn-${turns}`, reason: 'answer' })
    await clock.advance(5 * 60 * MIN)
    expect(w.compacts).toBe(1)
  })

  test('a turn starting while the fire callback is under way does not compact', async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on)
    // Hold the session id lookup of the fire callback until the person's turn
    // has started (the arm's lookup comes first).
    let release = () => {}
    const gate = new Promise<void>((resolve) => { release = resolve })
    let lookups = 0
    w.onSessionId = async () => {
      if (++lookups === 2) await gate
    }
    await mainTurn($)
    await clock.advance(50 * MIN)
    expect(lookups).toBe(2)
    await $.turn.start({ text: 'back', turnId: 'late-turn' })
    release()
    await clock.settle()
    expect(w.compacts).toBe(0)
  })

  test("the person's /compact cancels the pending timer", async ($, on) => {
    const clock = mock.clock(on, { now: T0 })
    const w = world(on)
    await mainTurn($)
    await clock.advance(10 * MIN)
    await $.session.compact({ trigger: 'manual', messages: SUMMARY })
    expect(w.compacts).toBe(1)
    await clock.advance(2 * 60 * MIN)
    expect(w.compacts).toBe(1)
  })
})

// A timer that fires late against the wall clock (the Mac slept through it):
// clock.after resolves only when the test says so, clock.now reads `now`.
function lateClock(on: On) {
  const c = { now: T0, nowCalls: 0, fire: () => {}, onNow: () => {} }
  on('clock.now', () => {
    c.nowCalls++
    c.onNow()
    return { value: c.now }
  })
  on('clock.after', () => new Promise((resolve) => { c.fire = () => resolve({ value: undefined }) }))
  return c
}

async function fireAt($: Engine, c: ReturnType<typeof lateClock>, elapsed: number) {
  c.now = T0 + elapsed
  const seen = new Promise<void>((resolve) => { c.onNow = resolve })
  c.fire()
  await seen
  // A few engine round trips through an event the plugin ignores (a subagent's
  // completion), for the callback to finish what follows.
  for (let i = 0; i < 5; i++) {
    await $.turn.complete({ answer: '', durationMs: 1, isAborted: false, turnId: 'sub', reason: 'answer', agentId: 'sub' })
  }
}

describe('idle compact against the wall clock', () => {
  test('a callback running at 61 minutes does not compact', async ($, on) => {
    const c = lateClock(on)
    const w = world(on)
    await mainTurn($)
    await fireAt($, c, 61 * MIN)
    expect(w.compacts).toBe(0)
  })

  test('a callback running at 58 minutes does not compact', async ($, on) => {
    const c = lateClock(on)
    const w = world(on)
    await mainTurn($)
    await fireAt($, c, 58 * MIN)
    expect(w.compacts).toBe(0)
  })

  test('the same harness at 50 minutes does compact', async ($, on) => {
    const c = lateClock(on)
    const w = world(on)
    await mainTurn($)
    await fireAt($, c, 50 * MIN)
    expect(w.compacts).toBe(1)
  })
})

// Every clock.after wait the plugin holds, live until it resolves or its
// dispatch is aborted (a cancelled timer).
function countingClock(on: On) {
  const c = { live: 0 }
  on('clock.now', () => ({ value: T0 }))
  on('clock.after', ($, e, next) => new Promise((resolve) => {
    c.live++
    next.signal.addEventListener('abort', () => {
      c.live--
      resolve({ value: undefined })
    })
  }))
  return c
}

test('never more than one pending timer, none after session.end', async ($, on) => {
  const c = countingClock(on)
  world(on)
  await mainTurn($)
  expect(c.live).toBe(1)
  await mainTurn($)
  await mainTurn($)
  expect(c.live).toBe(1)
  await $.turn.start({ text: 'hi', turnId: 'pending' })
  expect(c.live).toBe(0)
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'pending', reason: 'answer' })
  expect(c.live).toBe(1)
  await $.session.end({ reason: 'clear', sessionId: 'session-a', resume: { id: 'session-a' } })
  expect(c.live).toBe(0)
})

test('each arm shows one transcript notice with the local compaction time, nothing else reaches it', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  world(on)
  const transcript: string[] = []
  on('ui.log', ($, e) => {
    if (e.to === 'transcript') transcript.push(e.text)
    return { value: undefined }
  })
  const at = new Date(T0 + 50 * MIN)
  const hhmm = `${String(at.getHours()).padStart(2, '0')}:${String(at.getMinutes()).padStart(2, '0')}`
  await mainTurn($)
  expect(transcript).toEqual([`compacts at ${hhmm} if nothing happens before then`])
  await clock.advance(50 * MIN)
  expect(transcript.length).toBe(1)
})

// The harness's $.ui.log does not wait for its hooks, so a turn cannot be made
// to start mid-arm; pin the order instead: the notice goes out in the same step
// as the generation check, before the arm awaits anything else.
test('the transcript notice is issued before the debug log', async ($, on) => {
  mock.clock(on, { now: T0 })
  world(on)
  const logs: string[] = []
  on('ui.log', ($, e) => {
    logs.push(e.to === 'transcript' ? 'notice' : e.text.split(' ').slice(0, 3).join(' '))
    return { value: undefined }
  })
  await mainTurn($)
  expect(logs).toEqual(['notice', 'idle-compact: armed at'])
})

function transcriptOf(on: On) {
  const transcript: string[] = []
  on('ui.log', ($, e) => {
    if (e.to === 'transcript') transcript.push(e.text)
    return { value: undefined }
  })
  return transcript
}

test('after the idle compaction, one transcript line gives the cache hit of the summary call', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  w.usage = { input_tokens: 2813, output_tokens: 2058, cache_read_input_tokens: 74482, cache_creation_input_tokens: 326 }
  const transcript = transcriptOf(on)
  await mainTurn($)
  await clock.advance(50 * MIN)
  expect(w.compacts).toBe(1)
  expect(transcript.slice(1)).toEqual(['compacted with a 95% cache hit (74,482 read, 326 written, 2,813 uncached)'])
})

test('no cache hit line when the compaction reports no usage', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  const transcript = transcriptOf(on)
  await mainTurn($)
  await clock.advance(50 * MIN)
  expect(w.compacts).toBe(1)
  expect(transcript.length).toBe(1)
})

test('an exact cache hit percentage is not understated by float rounding', async ($, on) => {
  const clock = mock.clock(on, { now: T0 })
  const w = world(on)
  w.usage = { input_tokens: 0, output_tokens: 1, cache_read_input_tokens: 29, cache_creation_input_tokens: 21 }
  const transcript = transcriptOf(on)
  await mainTurn($)
  await clock.advance(50 * MIN)
  expect(transcript.slice(1)).toEqual(['compacted with a 58% cache hit (29 read, 21 written, 0 uncached)'])
})
