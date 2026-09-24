import { describe, expect, mock, test } from 'claude-code/testing'
import type { On } from 'claude-code'
import type { Engine } from 'claude-code/testing'

const MIN = 60 * 1000
const T0 = 1_700_000_000_000

const SUMMARY = [{ role: 'user' as const, text: 'summary', toolUses: [] }]

type World = { compacts: number; sessionId: string; onCompact?: () => unknown }

// The engine beneath the plugin: every event it raises or calls answered here.
function world(on: On): World {
  const w: World = { compacts: 0, sessionId: 'session-a' }
  on('turn.start', ($, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: '' }))
  on('session.end', ($, e) => ({ sessionId: e.sessionId }))
  on('session.id', () => ({ value: w.sessionId }))
  on('session.compact', async () => {
    w.compacts++
    await w.onCompact?.()
    return { messages: SUMMARY }
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
