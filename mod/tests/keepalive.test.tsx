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
