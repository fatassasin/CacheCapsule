export type Ttl = '5m' | '1h'

/** One TTL's own schedule: seconds between keep-alives and how many at most. */
export type Tier = { iv: number; max: number }

/** What the capsule writes to `settings.json`, shared by every chat. */
export type Tiers = { '5m': Tier; '1h': Tier }

/**
 * What the capsule writes to `chats/<session>.json`, one per chat; a chat
 * with no file is off. `pingNonce` is a counter it bumps for "keep alive
 * now"; the mod fires when the number changes.
 */
export type Chat = { ttl: Ttl; isOn: boolean; pingNonce: number }

/** Both files as this session reads them. */
export type Prefs = Chat & { tiers: Tiers }

/** Why the countdown is not running, or `live` while it is. */
export type RunStatus = 'live' | 'busy' | 'done' | 'closed' | 'empty' | 'expired' | 'error'

/**
 * The keep-alive run since the last real request: `ttl` is the TTL that
 * request wrote with, so the schedule follows the cache actually held;
 * `warmAt` is when the cache was last written or read.
 */
export type Run = {
  ttl: Ttl
  sent: number
  nextAt: number | null
  warmAt: number | null
  status: RunStatus
  note: string
}

export type Ping = { at: number; read: number; write: number; out: number } | null

declare module 'claude-code' {
  interface PluginState {
    'cache-keepalive': { prefs: Prefs; run: Run; last: Ping }
  }
}
