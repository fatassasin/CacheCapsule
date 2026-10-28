import { atom, read, update } from 'claude-code'
import type { EngineInterface, Register } from 'claude-code'

import type { Chat, Ping, Prefs, Run, Tier, Tiers, Ttl } from '../types'

const TTL_SECONDS: Record<Ttl, number> = { '5m': 300, '1h': 3600 }
const MIN_IV = 30
const MAX_COUNT = 48
// While the window is gone, look again this often instead of pinging.
const CLOSED_RECHECK_MS = 20_000
// The capsule treats a session as gone when its file has not been touched for
// longer than it waits; this keeps the file fresh while nothing else changes.
const BEAT_MS = 5_000

const DEFAULT_TIERS: Tiers = { '5m': { iv: 270, max: 6 }, '1h': { iv: 3300, max: 3 } }
// A chat the capsule has never switched on keeps nothing alive.
const DEFAULT_CHAT: Chat = { ttl: '5m', isOn: false, pingNonce: 0 }
const DEFAULTS: Prefs = { ...DEFAULT_CHAT, tiers: DEFAULT_TIERS }
const IDLE_RUN: Run = { ttl: '5m', sent: 0, nextAt: null, warmAt: null, status: 'empty', note: '' }

// The fork rides the main thread's cached prefix with cache writes and the
// transcript both skipped; this is the only text past the cache point.
const FORK_PROMPT = 'Cache keep-alive. Reply with one character: .'

const prefs = atom({ plugin: 'cache-keepalive', key: 'prefs' } as const, DEFAULTS)
const run = atom({ plugin: 'cache-keepalive', key: 'run' } as const, IDLE_RUN)
const last = atom({ plugin: 'cache-keepalive', key: 'last' } as const, null as Ping)

/** `settings.json` holds the tiers every chat shares, `chats/<session>.json` this chat's own switch. */
function mergePrefs(settings: unknown, chat: unknown): Prefs {
  const s = (settings ?? {}) as Partial<Prefs>
  const c = (chat ?? {}) as Partial<Chat>
  const tier = (ttl: Ttl): Tier => {
    const t = { ...DEFAULT_TIERS[ttl], ...(s.tiers?.[ttl] ?? {}) }
    return {
      iv: Math.min(TTL_SECONDS[ttl] - 5, Math.max(MIN_IV, Math.round(t.iv))),
      max: Math.min(MAX_COUNT, Math.max(1, Math.round(t.max))),
    }
  }
  return {
    ttl: c.ttl === '1h' ? '1h' : '5m',
    isOn: c.isOn === true,
    pingNonce: Number(c.pingNonce) || 0,
    tiers: { '5m': tier('5m'), '1h': tier('1h') },
  }
}

// Main-thread and helper requests both follow the env, so the fork reads the
// cache at the same TTL the conversation wrote it with. Switched off, the mod
// unsets both and Claude Code picks its own TTL again.
async function applyTtl($: EngineInterface, p: Prefs) {
  const ttl = p.isOn ? p.ttl : undefined
  await $.env.set('CLAUDE_CODE_PROMPT_CACHE_TTL', ttl)
  await $.env.set('CLAUDE_CODE_SUBAGENT_PROMPT_CACHE_TTL', ttl)
}

/**
 * Whether the desktop window is still up. A session the app draws checks for
 * a visible Claude window (closing to the tray hides it); a terminal session
 * is alive while anything draws it.
 */
async function isWindowOpen($: EngineInterface): Promise<boolean> {
  const surfaces = await $.session.surfaces()
  if (!surfaces.includes('desktop')) return surfaces.length > 0
  try {
    const r = await $.process.run([
      'powershell.exe',
      '-NoProfile',
      '-NonInteractive',
      '-Command',
      "@(Get-Process -Name Claude -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 -and $_.Path -notlike '*claude-code*' }).Count",
    ])
    if (r.exitCode !== 0) return true
    return Number(r.stdout.trim()) > 0
  } catch {
    return true
  }
}

// Module variables: a reload starts them over, which is what they mean.
let isBusy = false
let isPinging = false
let dir: string | undefined
let activeAt = 0
let lastWritten = ''
let lastBeat = 0
let seenNonce: number | undefined
let loadedPrefs = ''
let hasSettings = false

/**
 * Where the capsule and this mod meet: `settings.json` and `chats/<session>.json`
 * are the capsule's to write, `state/<session>.json` this mod's. Plain files,
 * so the capsule needs no way into Claude Code itself.
 */
async function folder($: EngineInterface) {
  if (dir === undefined) {
    const home = (await $.env.get('USERPROFILE')) ?? (await $.env.get('HOME')) ?? '.'
    dir = `${home.replace(/\\/g, '/')}/.claude/cache-keepalive`
  }
  return dir
}

async function readJson($: EngineInterface, path: string): Promise<unknown> {
  try {
    const text = await $.fs.read(path)
    if (typeof text !== 'string') return undefined
    return JSON.parse(text.charCodeAt(0) === 0xfeff ? text.slice(1) : text)
  } catch {
    return undefined
  }
}

async function writeState($: EngineInterface, t: number, isEnded = false) {
  const base = await folder($)
  const r = await read($, run)
  const l = await read($, last)
  const sid = await $.session.id()
  const body = { sid, ttl: r.ttl, sent: r.sent, nextAt: r.nextAt, warmAt: r.warmAt, status: r.status, note: r.note, last: l, activeAt, ended: isEnded }
  const text = JSON.stringify(body)
  // Only the heartbeat changes between identical states.
  if (!isEnded && text === lastWritten && t - lastBeat < BEAT_MS) return
  lastWritten = text
  lastBeat = t
  await $.fs.write(`${base}/state/${sid}.json`, JSON.stringify({ ...body, beat: t }))
}

async function ping($: EngineInterface) {
  if (isPinging || isBusy) return
  isPinging = true
  try {
    const res = await $.model.fork({ prompt: FORK_PROMPT })
    const t = await $.clock.now()
    const p = await read($, prefs)
    if (!res.isAnswered && res.reason === 'nothing-to-fork') {
      await update($, run, (r): Run => ({ ...r, nextAt: null, status: 'empty', note: '' }))
      return
    }
    if (!res.isAnswered && (res.reason === 'api-error' || res.reason === 'aborted')) {
      const note = res.reason === 'api-error' ? `API ${res.status ?? '错误'}` : '被中断'
      await update($, run, (r): Run => ({ ...r, nextAt: null, status: 'error', note }))
      return
    }
    const u = res.usage
    const got: Ping = {
      at: t,
      read: u.cache_read_input_tokens,
      write: u.cache_creation_input_tokens,
      out: u.output_tokens,
    }
    await update($, last, () => got)
    const isHit = got.read > 0
    await update($, run, (r): Run => ({
      ...r,
      sent: r.sent + 1,
      nextAt: isHit ? t + p.tiers[r.ttl].iv * 1000 : null,
      warmAt: isHit ? t : r.warmAt,
      status: isHit ? 'live' : 'error',
      note: isHit ? '' : '没有命中缓存',
    }))
  } finally {
    isPinging = false
    await writeState($, await $.clock.now())
  }
}

async function loadPrefs($: EngineInterface) {
  const base = await folder($)
  const settings = await readJson($, `${base}/settings.json`)
  if (settings === undefined && !hasSettings) {
    // First run: leave the capsule a file to start from.
    hasSettings = true
    await $.fs.write(`${base}/settings.json`, JSON.stringify({ tiers: DEFAULT_TIERS }))
  }
  return mergePrefs(settings, await readJson($, `${base}/chats/${await $.session.id()}.json`))
}

/** The capsule's settings, taken in as they change. */
async function syncPrefs($: EngineInterface, t: number) {
  const before = await read($, prefs)
  const after = await loadPrefs($)
  const text = JSON.stringify(after)
  if (text === loadedPrefs) return before
  loadedPrefs = text
  await update($, prefs, () => after)
  if (after.ttl !== before.ttl || after.isOn !== before.isOn) await applyTtl($, after)
  // Keep the countdown's start, move its end to the new interval.
  const was = before.tiers
  await update($, run, (x): Run =>
    x.nextAt !== null && x.status === 'live' ? { ...x, nextAt: x.nextAt + (after.tiers[x.ttl].iv - was[x.ttl].iv) * 1000 } : x,
  )

  // "Keep alive now" is a counter the capsule bumps; the first read is only a baseline.
  if (seenNonce !== undefined && after.pingNonce !== seenNonce) {
    seenNonce = after.pingNonce
    await manualPing($, t)
  }
  seenNonce = after.pingNonce
  return after
}

async function manualPing($: EngineInterface, t: number) {
  if (isBusy || isPinging) return
  const r = await read($, run)
  // Nothing warm to keep alive.
  if (r.warmAt === null || t - r.warmAt >= TTL_SECONDS[r.ttl] * 1000) return
  if (!(await isWindowOpen($))) return
  await ping($)
}

async function tick($: EngineInterface) {
  const t = await $.clock.now()
  const p = await syncPrefs($, t)
  if (!isBusy && !isPinging) {
    const r = await read($, run)
    const isDue = p.isOn && r.nextAt !== null && t >= r.nextAt && (r.status === 'live' || r.status === 'closed')
    if (isDue && r.sent < p.tiers[r.ttl].max) {
      // Past its TTL the cache is gone: a fork then would write it all again.
      if (r.warmAt === null || t - r.warmAt >= TTL_SECONDS[r.ttl] * 1000) {
        await update($, run, (x): Run => ({ ...x, nextAt: null, status: 'expired' }))
      } else if (!(await isWindowOpen($))) {
        await update($, run, (x): Run => ({ ...x, nextAt: t + CLOSED_RECHECK_MS, status: 'closed' }))
      } else {
        await ping($)
      }
    }
  }
  await writeState($, t)
}

export const register: Register = on => {
  on('session.start', async ($, e, next) => {
    activeAt = await $.clock.now()
    seenNonce = undefined
    const saved = await loadPrefs($)
    loadedPrefs = JSON.stringify(saved)
    seenNonce = saved.pingNonce
    await update($, prefs, () => saved)
    await applyTtl($, saved)
    $.clock.every(1000, () => void tick($))

    return next(e)
  })

  // Subagents run their own loops and caches: only the main loop counts.
  on('turn.start', async ($, e, next) => {
    if (e.agentId === undefined && !isPinging) {
      isBusy = true
      activeAt = await $.clock.now()
      await update($, run, (r): Run => ({ ...r, status: 'busy' }))
      await writeState($, activeAt)
    }

    return next(e)
  })

  // A real request just wrote the cache: the run starts over from here.
  on('turn.complete', async ($, e, next) => {
    if (e.agentId === undefined && !isPinging) {
      isBusy = false
      const t = await $.clock.now()
      activeAt = t
      const p = await read($, prefs)
      // No usage: no request got through, so nothing is known to be cached.
      if (!e.usage) {
        await update($, run, (r): Run => ({ ...r, nextAt: null, status: 'error', note: '本轮没有写入缓存' }))
      } else {
        await update($, run, (): Run => ({
          ttl: p.ttl,
          sent: 0,
          nextAt: t + p.tiers[p.ttl].iv * 1000,
          warmAt: t,
          status: 'live',
          note: '',
        }))
      }
      await writeState($, t)
    }

    return next(e)
  })

  // The capsule drops this session from its list as soon as it ends.
  on('session.end', async ($, e, next) => {
    await writeState($, await $.clock.now(), true)
    return next(e)
  })
}
