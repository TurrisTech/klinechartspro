import type { LocalWatchState } from '../watch/local'
import type { EngineState } from './engine'
import type { ArmedSignal } from './signals'

// The replay state blob: what `PUT /sim/sessions/{id}/state` stores and a reload restores.
// The engine runs client-side, so the client computes this and saves it on each change; the
// server keeps it opaque (wdashboard_server/sim: `client_state`). Serialize / restore only --
// no I/O here.

export const REPLAY_STATE_VERSION = 1

export interface AdvanceSetting {
  interval: string
  multiple: number
}

export interface ReplayState {
  version: number
  vendor: string
  /** `vendor:TICKER`, the engine's instrument key. */
  symbol: string
  /** The instant the user has stepped to. Every read is clamped to it. */
  cursor: number
  /** Where the replay started; the cursor never goes below it. */
  startedAt: number
  base: string
  advance: AdvanceSetting
  pauseOnFill: boolean
  starred: string[]
  armed: ArmedSignal[]
  /** The replay's own price watches, evaluated in this tab against the base-bar walk
   * (client/replay/watches.ts). Optional, and NOT a version bump: every replay in progress
   * when this shipped has a blob without it, and refusing those would have thrown away the
   * session rather than started it with no watches. */
  watches: LocalWatchState[]
  engine: EngineState
}

export interface ReplayStateInput {
  vendor: string
  symbol: string
  cursor: number
  startedAt: number
  base: string
  advance: AdvanceSetting
  pauseOnFill: boolean
  starred: Iterable<string>
  armed: readonly ArmedSignal[]
  watches: readonly LocalWatchState[]
  engine: EngineState
}

export function serialize(input: ReplayStateInput): ReplayState {
  return {
    version: REPLAY_STATE_VERSION,
    vendor: input.vendor,
    symbol: input.symbol,
    cursor: input.cursor,
    startedAt: input.startedAt,
    base: input.base,
    advance: { ...input.advance },
    pauseOnFill: input.pauseOnFill,
    starred: [...input.starred].sort(),
    armed: input.armed.map((a) => ({ ref: a.ref, resolution: a.resolution })),
    watches: [...input.watches],
    engine: input.engine
  }
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null
}

/** A stored blob back as a `ReplayState`, or null when it is not one this client can read. */
export function restore(value: unknown): ReplayState | null {
  if (!isRecord(value)) return null
  if (value.version !== REPLAY_STATE_VERSION) return null
  const { vendor, symbol, cursor, startedAt, base, advance, pauseOnFill, starred, armed, watches, engine } = value
  if (typeof vendor !== 'string' || typeof symbol !== 'string' || typeof base !== 'string') return null
  if (typeof cursor !== 'number' || !Number.isFinite(cursor)) return null
  if (!isRecord(advance) || typeof advance.interval !== 'string' || typeof advance.multiple !== 'number') return null
  if (!isRecord(engine) || !Array.isArray(engine.orders) || !Array.isArray(engine.trades)) return null
  return {
    version: REPLAY_STATE_VERSION,
    vendor,
    symbol,
    cursor,
    startedAt: typeof startedAt === 'number' ? startedAt : cursor,
    base,
    advance: { interval: advance.interval, multiple: Math.max(1, Math.floor(advance.multiple)) },
    pauseOnFill: pauseOnFill === true,
    starred: Array.isArray(starred) ? starred.filter((s): s is string => typeof s === 'string') : [],
    armed: Array.isArray(armed)
      ? armed.filter((a): a is ArmedSignal => isRecord(a) && typeof a.ref === 'string' && typeof a.resolution === 'string').map((a) => ({ ref: a.ref, resolution: a.resolution }))
      : [],
    // A blob written before replay watches existed simply has none.
    watches: Array.isArray(watches) ? (watches.filter(isWatchState) as LocalWatchState[]) : [],
    engine: engine as unknown as EngineState
  }
}

/** A stored watch row this client can read back. Shallow on purpose: the registry re-parses
 * the condition on restore and drops the row if it no longer evaluates, which is the check
 * that matters. */
function isWatchState(value: unknown): boolean {
  if (!isRecord(value) || !isRecord(value.wire)) return false
  const wire = value.wire
  return typeof wire.id === 'string' && typeof wire.source === 'string' && typeof wire.target === 'string' && isRecord(wire.condition)
}

// The minimal "replay intent" -- which session, at which cursor -- kept in page-level
// storage so it survives the wall rebuild that entering or leaving replay needs (the
// datafeed differs), and a reload. Everything else is in the server-side blob.

export interface ReplayIntent {
  sessionId: string
  cursor: number
}

const INTENT_KEY = 'wd.replay.intent'

export function readIntent(storage: Pick<Storage, 'getItem'> | null): ReplayIntent | null {
  try {
    const raw = storage?.getItem(INTENT_KEY)
    if (!raw) return null
    const v: unknown = JSON.parse(raw)
    if (!isRecord(v) || typeof v.sessionId !== 'string' || typeof v.cursor !== 'number') return null
    return { sessionId: v.sessionId, cursor: v.cursor }
  } catch {
    return null
  }
}

export function writeIntent(storage: Pick<Storage, 'setItem' | 'removeItem'> | null, intent: ReplayIntent | null): void {
  try {
    if (intent) storage?.setItem(INTENT_KEY, JSON.stringify(intent))
    else storage?.removeItem(INTENT_KEY)
  } catch {
    // storage unavailable: the intent is then per page-load only
  }
}
