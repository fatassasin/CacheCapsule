import type { On } from 'claude-code'
import { expect, mock, test } from 'claude-code/testing'

const USAGE = { input_tokens: 4, output_tokens: 1, cache_read_input_tokens: 146_900, cache_creation_input_tokens: 0 }
const DIR = 'C:/Users/test/.claude/cache-keepalive'
const SETTINGS = `${DIR}/settings.json`
const CHAT = `${DIR}/chats/sess-1.json`
const TIERS = { '5m': { iv: 270, max: 6 }, '1h': { iv: 3300, max: 3 } }
const chat = (ttl: '5m' | '1h', isOn: boolean, pingNonce = 0) => JSON.stringify({ ttl, isOn, pingNonce })

/** An in-memory stand-in for the folder the capsule and the mod share. */
function files(on: On) {
  const disk = new Map<string, string>()
  // The engine hands paths over with Windows separators.
  const key = (path: string) => path.replaceAll('\\', '/')
  on('env.get', (_, e) => ({ value: e.name === 'USERPROFILE' ? 'C:\\Users\\test' : undefined }))
  on('session.id', () => ({ value: 'sess-1' }))
  on('fs.read', (_, e) => {
    // A missing file reads as empty, which the mod takes as not there.
    return { value: disk.get(key(e.path)) ?? '' }
  })
  on('fs.write', (_, e) => {
    disk.set(key(e.path), e.text)
    return { value: undefined }
  })
  on('fs.list', (_, e) => ({
    value: [...disk.keys()]
      .filter(k => k.startsWith(`${key(e.path)}/`))
      .map(k => ({ name: k.slice(key(e.path).length + 1), kind: 'file' as const, size: 0, mtimeMs: 0, isLink: false })),
  }))
  return disk
}

const state = (disk: Map<string, string>) => JSON.parse(disk.get(`${DIR}/state/sess-1.json`) ?? 'null')

function common(on: On, forks: { n: number }, sets: string[] = []) {
  on('env.set', (_, e) => {
    sets.push(`${e.name}=${e.value}`)
    return { value: {} }
  })
  on('session.surfaces', () => ({ value: ['terminal'] as const }))
  on('model.fork', () => {
    forks.n++
    return { value: { isAnswered: true as const, text: '.', usage: USAGE } }
  })
  on('session.start', (_, e) => ({ cwd: e.cwd }))
  on('session.end', (_, e) => ({ sessionId: e.sessionId }))
  on('turn.start', (_, e) => ({ turnId: e.turnId }))
  on('turn.complete', () => ({ text: 'ok' }))
}

const complete = ($: any, turnId = 't1') =>
  $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId, reason: 'answer', usage: { ...USAGE, model: 'x' } })

test('pings once per interval after a turn, up to the max, then stops; the state file follows', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const disk = files(on)
  disk.set(CHAT, chat('5m', true))
  const forks = { n: 0 }
  common(on, forks)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await complete($)
  await clock.advance(1_000)
  expect(state(disk)).toMatchObject({ sid: 'sess-1', ttl: '5m', sent: 0, status: 'live', ended: false })

  await clock.advance(268_000)
  expect(forks.n).toBe(0)
  await clock.advance(2_000)
  expect(forks.n).toBe(1)

  // Default 5m tier: 6 pings at 4:30, then nothing more.
  await clock.advance(270_000 * 10)
  expect(forks.n).toBe(6)
  expect(state(disk)).toMatchObject({ sent: 6, status: 'live', last: { read: 146_900, write: 0, out: 1 } })
})

test("a chat never switched on keeps nothing alive, and another chat's switch does not count", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const disk = files(on)
  const sets: string[] = []
  const forks = { n: 0 }
  common(on, forks, sets)
  disk.set(`${DIR}/chats/sess-2.json`, chat('1h', true))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(sets).toContain('CLAUDE_CODE_PROMPT_CACHE_TTL=undefined')
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await complete($)
  await clock.advance(1_000)
  expect(state(disk)).toMatchObject({ status: 'live', sent: 0 })
  await clock.advance(600_000)
  expect(forks.n).toBe(0)
  // The mod never writes the switch itself: only the capsule does.
  expect(disk.has(CHAT)).toBe(false)
})

test('a subagent turn does not start a run', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const disk = files(on)
  disk.set(CHAT, chat('5m', true))
  const forks = { n: 0 }
  common(on, forks)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.complete({ answer: 'ok', durationMs: 1, isAborted: false, turnId: 'a', agentId: 'sub', reason: 'answer', usage: { ...USAGE, model: 'x' } })
  await clock.advance(600_000)
  expect(forks.n).toBe(0)
})

test("this chat's file sets the TTL env, and its switch stops pinging", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const disk = files(on)
  const sets: string[] = []
  const forks = { n: 0 }
  common(on, forks, sets)
  disk.set(CHAT, chat('5m', true))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(sets).toContain('CLAUDE_CODE_PROMPT_CACHE_TTL=5m')
  await clock.advance(1_000)
  // With no file yet the mod leaves the capsule one to start from.
  expect(JSON.parse(disk.get(SETTINGS) ?? 'null')).toMatchObject({ tiers: TIERS })

  disk.set(CHAT, chat('1h', true))
  await clock.advance(1_000)
  expect(sets).toContain('CLAUDE_CODE_PROMPT_CACHE_TTL=1h')
  expect(sets).toContain('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL=1h')

  await $.turn.start({ text: 'hi', turnId: 't1' })
  expect(state(disk)).toMatchObject({ status: 'busy' })
  await complete($)
  expect(state(disk)).toMatchObject({ ttl: '1h', status: 'live' })

  disk.set(CHAT, chat('1h', false))
  await clock.advance(1_000)
  expect(sets).toContain('CLAUDE_CODE_PROMPT_CACHE_TTL=undefined')
  await clock.advance(3_600_000)
  expect(forks.n).toBe(0)
})

test('the tiers in settings.json are shared by every chat', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const disk = files(on)
  disk.set(SETTINGS, JSON.stringify({ tiers: { '5m': { iv: 120, max: 2 }, '1h': { iv: 3300, max: 3 } } }))
  disk.set(CHAT, chat('5m', true))
  const forks = { n: 0 }
  common(on, forks)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await complete($)
  await clock.advance(121_000)
  expect(forks.n).toBe(1)
  await clock.advance(1_200_000)
  expect(forks.n).toBe(2)
})

test('"keep alive now" fires once per bump of the counter, only while the cache is warm', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const disk = files(on)
  const forks = { n: 0 }
  common(on, forks)

  disk.set(CHAT, chat('5m', true, 7))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(2_000)
  expect(forks.n).toBe(0)

  // Nothing cached yet: a bump has nothing to keep alive.
  disk.set(CHAT, chat('5m', true, 8))
  await clock.advance(1_000)
  expect(forks.n).toBe(0)

  await $.turn.start({ text: 'hi', turnId: 't1' })
  await complete($)
  disk.set(CHAT, chat('5m', true, 9))
  await clock.advance(1_000)
  expect(forks.n).toBe(1)
  expect(state(disk)).toMatchObject({ sent: 1 })
  await clock.advance(5_000)
  expect(forks.n).toBe(1)
})

test('a session that ends marks its state file', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const disk = files(on)
  const forks = { n: 0 }
  common(on, forks)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await clock.advance(1_000)
  expect(state(disk)).toMatchObject({ ended: false })
  await $.session.end({ reason: 'other', sessionId: 'sess-1', resume: { id: 'sess-1' } })
  expect(state(disk)).toMatchObject({ ended: true })
})

/** The model's reply to one request, as the engine would hand it back. */
function steps(on: On) {
  on('turn.step', async function* (_, e) {
    return { turnId: e.turnId, index: e.index, answer: '', toolUses: [], stopReason: 'tool_use' as const, usage: { ...USAGE, model: 'x' } }
  })
}
const step = async ($: any, index = 0) => {
  for await (const _ of $.turn.step({ turnId: 't1', index, model: 'x', messageCount: 1 })) {
    // The chunks are not what the mod reads.
  }
}
const QUESTION = {
  tool: 'AskUserQuestion' as const,
  questions: [{ question: 'Which?', header: 'Pick', multiSelect: false, options: [{ label: 'a', description: '' }, { label: 'b', description: '' }] }],
}

test('the first ping counts from when the request went out, not from when its reply finished', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const disk = files(on)
  disk.set(CHAT, chat('5m', true))
  const forks = { n: 0 }
  common(on, forks)
  steps(on)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await step($)
  // A long reply: two minutes pass before the turn completes.
  await clock.advance(120_000)
  await complete($)
  await clock.advance(148_000)
  expect(forks.n).toBe(0)
  await clock.advance(3_000)
  expect(forks.n).toBe(1)
})

test('a question waiting on the person keeps the cache alive until they answer', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const disk = files(on)
  disk.set(CHAT, chat('5m', true))
  const forks = { n: 0 }
  common(on, forks)
  steps(on)
  let answer = () => {}
  on('tool.call', () => new Promise(resolve => { answer = () => resolve({ result: { answers: {} } } as any) }))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await step($)
  await clock.advance(60_000)
  const asked = $.tool.call(QUESTION)
  await clock.advance(1_000)
  expect(state(disk)).toMatchObject({ status: 'live', sent: 0 })
  // Counted from the request that asked, 61s ago.
  await clock.advance(207_000)
  expect(forks.n).toBe(0)
  await clock.advance(3_000)
  expect(forks.n).toBe(1)
  await clock.advance(270_000)
  expect(forks.n).toBe(2)

  answer()
  await asked
  expect(state(disk)).toMatchObject({ status: 'busy' })
  await clock.advance(600_000)
  expect(forks.n).toBe(2)
})

test("a subagent's question leaves the main turn busy", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const disk = files(on)
  disk.set(CHAT, chat('5m', true))
  const forks = { n: 0 }
  common(on, forks)
  steps(on)
  on('tool.call', () => new Promise(() => {}))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await step($)
  void $.tool.call({ ...QUESTION, agentId: 'sub' })
  await clock.advance(600_000)
  expect(forks.n).toBe(0)
  expect(state(disk)).toMatchObject({ status: 'busy' })
})

const stoppable = (stopNonce: number, resumeNonce = 0) =>
  JSON.stringify({ ttl: '5m', isOn: true, pingNonce: 0, stopNonce, resumeNonce })

test('stop ends this idle stretch; the next turn starts keeping alive again', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const disk = files(on)
  const forks = { n: 0 }
  common(on, forks)

  disk.set(CHAT, stoppable(3))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await complete($)
  await clock.advance(1_000)
  // The count it started with is only a baseline.
  expect(state(disk)).toMatchObject({ status: 'live', canStop: true })

  disk.set(CHAT, stoppable(4))
  await clock.advance(1_000)
  expect(state(disk)).toMatchObject({ status: 'stopped', nextAt: null })
  await clock.advance(600_000)
  expect(forks.n).toBe(0)

  await $.turn.start({ text: 'again', turnId: 't2' })
  expect(state(disk)).toMatchObject({ status: 'busy' })
  await complete($, 't2')
  expect(state(disk)).toMatchObject({ status: 'live', sent: 0 })
  await clock.advance(271_000)
  expect(forks.n).toBe(1)
})

test('resume picks the countdown up again, or finds the cache gone', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const disk = files(on)
  const forks = { n: 0 }
  common(on, forks)

  disk.set(CHAT, stoppable(0))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await complete($)
  disk.set(CHAT, stoppable(1))
  await clock.advance(60_000)
  expect(state(disk)).toMatchObject({ status: 'stopped' })

  // Still warm: the countdown runs to the same 4:30 it had.
  disk.set(CHAT, stoppable(1, 1))
  await clock.advance(1_000)
  expect(state(disk)).toMatchObject({ status: 'live', nextAt: 1_000_000 + 270_000 })
  await clock.advance(210_000)
  expect(forks.n).toBe(1)

  // Stopped again and left past the TTL: resuming has nothing to keep.
  disk.set(CHAT, stoppable(2, 1))
  await clock.advance(400_000)
  disk.set(CHAT, stoppable(2, 2))
  await clock.advance(2_000)
  expect(state(disk)).toMatchObject({ status: 'expired' })
  expect(forks.n).toBe(1)
})

test('stop pressed mid-turn does nothing', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const disk = files(on)
  const forks = { n: 0 }
  common(on, forks)

  disk.set(CHAT, stoppable(0))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  disk.set(CHAT, stoppable(1))
  await clock.advance(1_000)
  expect(state(disk)).toMatchObject({ status: 'busy' })
  await complete($)
  await clock.advance(271_000)
  expect(forks.n).toBe(1)
})

test('an expired cache keeps alive again after the next message, while the switch is on', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const disk = files(on)
  const forks = { n: 0 }
  common(on, forks)

  disk.set(CHAT, stoppable(0))
  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await complete($)
  // Stopped and left until the cache is gone; the due tick then marks it expired.
  disk.set(CHAT, stoppable(1))
  await clock.advance(400_000)
  disk.set(CHAT, stoppable(1, 1))
  await clock.advance(2_000)
  expect(state(disk)).toMatchObject({ status: 'expired' })

  await $.turn.start({ text: 'again', turnId: 't2' })
  await complete($, 't2')
  expect(state(disk)).toMatchObject({ status: 'live', sent: 0 })
  await clock.advance(271_000)
  expect(forks.n).toBe(1)
})

test('an interrupted turn keeps counting down from the cache the last turn wrote', async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const disk = files(on)
  disk.set(CHAT, chat('5m', true))
  const forks = { n: 0 }
  common(on, forks)

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  await $.turn.start({ text: 'hi', turnId: 't1' })
  await complete($)
  await clock.advance(100_000)
  // Sent and stopped at once: no request got through.
  await $.turn.start({ text: 'more', turnId: 't2' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't2', reason: 'aborted' })
  await clock.advance(1_000)
  expect(state(disk)).toMatchObject({ status: 'live', note: '' })
  // Still due 4:30 after the first turn's request, not after the interrupted one.
  await clock.advance(168_000)
  expect(forks.n).toBe(0)
  await clock.advance(2_000)
  expect(forks.n).toBe(1)

  // Interrupted once the pings have run out and the cache with them: nothing left to keep alive.
  await clock.advance(270_000 * 10)
  await $.turn.start({ text: 'later', turnId: 't3' })
  await $.turn.complete({ answer: '', durationMs: 1, isAborted: true, turnId: 't3', reason: 'aborted' })
  await clock.advance(1_000)
  expect(state(disk)).toMatchObject({ status: 'error', note: '本轮没有写入缓存' })
})

test("the auto-compact window follows this chat's choice for the TTL in use", async ($, on) => {
  const clock = mock.clock(on, { now: 1_000_000 })
  mock.store(on)
  const disk = files(on)
  const sets: string[] = []
  const forks = { n: 0 }
  common(on, forks, sets)
  const withCompact = (ttl: '5m' | '1h', isOn: boolean) =>
    JSON.stringify({ ttl, isOn, compact: { '5m': 400_000, '1h': 50_000 } })
  // Claude Code's own window: the model's million, or the variable when set.
  on('session.usage', () => {
    const v = sets.findLast(s => s.startsWith('CLAUDE_CODE_AUTO_COMPACT_WINDOW='))?.split('=')[1]
    const isSet = v !== undefined && v !== 'undefined'
    const breakdown = { rawMaxTokens: isSet ? Number(v) : 1_000_000, autocompactSource: isSet ? 'env' : 'auto' }
    return { value: { startedAt: 0, context: { window: 1_000_000, breakdown }, rateLimits: {}, cost: { usd: 0 } } as any }
  })
  disk.set(CHAT, withCompact('5m', true))

  await $.session.start({ cwd: '/', surface: 'terminal', isInteractive: true })
  expect(sets).toContain('CLAUDE_CODE_AUTO_COMPACT_WINDOW=400000')
  await clock.advance(1_000)
  // What Claude Code made of it goes to the capsule.
  expect(state(disk)).toMatchObject({ compactCheck: { want: 400_000, deny: null, window: 400_000, source: 'env' } })

  // The 1h tier keeps its own, held to the slider's floor.
  disk.set(CHAT, withCompact('1h', true))
  await clock.advance(1_000)
  expect(sets.at(-1)).toBe('CLAUDE_CODE_AUTO_COMPACT_WINDOW=200000')

  disk.set(CHAT, withCompact('1h', false))
  await clock.advance(1_000)
  expect(sets.at(-1)).toBe('CLAUDE_CODE_AUTO_COMPACT_WINDOW=undefined')
  expect(state(disk)).toMatchObject({ compactCheck: { want: null, window: 1_000_000, source: 'auto' } })

  // Never chosen: Claude Code keeps its own window.
  disk.set(CHAT, chat('5m', true))
  await clock.advance(1_000)
  expect(sets.at(-1)).toBe('CLAUDE_CODE_AUTO_COMPACT_WINDOW=undefined')
})
