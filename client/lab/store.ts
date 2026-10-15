// THE SAVED STRATEGIES: this account's, kept where its workspaces and alerts are -- `/preferences`
// where the server has it, this browser's localStorage where it does not.
//
// One key PER STRATEGY plus an index, for the reason client/workspaces/store.ts gives: the
// document resolves a conflict by replaying only the keys a write carried, so two tabs saving
// two different strategies merge instead of one dropping the other.
//
//   strategies        -> { version, order: string[] }        (the index)
//   strategy.<id>     -> the strategy (model.ts `Strategy`)
//
// SAVING IS EXPLICIT, as a workspace's is: the lab edits a draft and nothing reaches storage
// until Save. What a wall pane or an alert reads is the SAVED strategy, so an experiment in the
// lab changes nothing else until it is kept. A save is announced on a BroadcastChannel, so a
// dashboard open in another tab of this browser redraws a pane showing that strategy at once.
//
// The whole /preferences document is one 64 KiB blob shared with every workspace and the
// alerts (appstate.py MAX_PREFERENCES_BYTES), so the set is capped and a strategy's size checked.

import { hasFeature } from '../capabilities'
import { loadPreferences, preferencesLoaded, refreshPreferences, removePreference, savePreference } from '../preferences'
import { readStrategy, type Strategy } from './model'

const INDEX_KEY = 'strategies'
const DOC_PREFIX = 'strategy.'
const LOCAL_PREFIX = 'wd.lab.'
const INDEX_VERSION = 1

export const MAX_STRATEGIES = 24
/** A strategy larger than this is refused: a handful of them would fill the shared document. */
export const MAX_STRATEGY_BYTES = 12_000

/** Where the set lives. */
export interface StrategyPersistence {
  /** Every stored key under the prefix, and the index. `fresh` reads past any page cache. */
  load(fresh: boolean): Promise<Record<string, unknown>>
  save(key: string, value: unknown): void
  remove(key: string): void
}

export function preferencesPersistence(): StrategyPersistence {
  return {
    load: async (fresh) => {
      const data = fresh ? await refreshPreferences() : await loadPreferences()
      // A failed read answers `{}`, which would read as "no strategies" -- and the next save
      // would write an index over the stored one.
      if (!preferencesLoaded()) throw new Error('the preferences store could not be read')
      return data
    },
    save: (key, value) => savePreference(key, value),
    remove: (key) => removePreference(key)
  }
}

export function localPersistence(storage: () => Storage | null = () => window.localStorage): StrategyPersistence {
  return {
    load: async () => {
      const out: Record<string, unknown> = {}
      try {
        const s = storage()
        if (!s) return out
        for (let i = 0; i < s.length; i++) {
          const key = s.key(i)
          if (!key?.startsWith(LOCAL_PREFIX)) continue
          const raw = s.getItem(key)
          if (raw) out[key.slice(LOCAL_PREFIX.length)] = JSON.parse(raw)
        }
      } catch {
        // An unreadable entry reads as absent.
      }
      return out
    },
    save: (key, value) => {
      try {
        storage()?.setItem(`${LOCAL_PREFIX}${key}`, JSON.stringify(value))
      } catch (err) {
        console.warn('[lab] could not save to localStorage', err)
      }
    },
    remove: (key) => {
      try {
        storage()?.removeItem(`${LOCAL_PREFIX}${key}`)
      } catch {
        // Nothing to do.
      }
    }
  }
}

export function defaultPersistence(): StrategyPersistence {
  return hasFeature('preferences') ? preferencesPersistence() : localPersistence()
}

/** The channel a save is announced on, to other tabs of this browser. */
export const CHANNEL = 'wd-strategy-lab'

export interface SavedMessage {
  kind: 'saved' | 'removed'
  id: string
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

export class StrategyStore {
  private rows = new Map<string, Strategy>()
  private order: string[] = []
  private readonly listeners = new Set<() => void>()
  /** Set when the stored set could not be read. Nothing is written then. */
  loadError = ''
  private channel: BroadcastChannel | null = null

  constructor(private readonly persistence: StrategyPersistence = defaultPersistence()) {
    try {
      this.channel = typeof BroadcastChannel === 'undefined' ? null : new BroadcastChannel(CHANNEL)
    } catch {
      this.channel = null
    }
  }

  /** Read the stored set. `fresh` reads past the page's copy of /preferences (another tab may
   * have saved since). A stored strategy that no longer reads is dropped with a warning. */
  async load(fresh = false): Promise<void> {
    let data: Record<string, unknown>
    try {
      data = await this.persistence.load(fresh)
      this.loadError = ''
    } catch (err) {
      console.warn('[lab] could not read the saved strategies', err)
      this.loadError = 'Your saved strategies could not be read, so nothing is saved until they are. Reload the page to try again.'
      data = {}
    }
    const index = isRecord(data[INDEX_KEY]) ? (data[INDEX_KEY] as Record<string, unknown>) : null
    const order = index && Array.isArray(index.order) ? index.order.filter((id): id is string => typeof id === 'string') : []
    this.rows.clear()
    for (const id of order) {
      const strategy = readStrategy(data[`${DOC_PREFIX}${id}`])
      if (strategy) this.rows.set(id, strategy)
      else console.warn(`[lab] dropping saved strategy ${id}: it no longer reads`)
    }
    this.order = order.filter((id) => this.rows.has(id))
    this.emit()
  }

  list(): Strategy[] {
    return this.order.map((id) => this.rows.get(id) as Strategy)
  }

  get(id: string): Strategy | null {
    return this.rows.get(id) ?? null
  }

  /** Keep `strategy`. Throws with a reason the editor can show when it cannot. */
  save(strategy: Strategy, now = Date.now()): Strategy {
    if (this.loadError) throw new Error(this.loadError)
    if (!this.rows.has(strategy.id) && this.rows.size >= MAX_STRATEGIES) {
      throw new Error(`${MAX_STRATEGIES} strategies are saved already: delete one first`)
    }
    const saved: Strategy = { ...structuredClone(strategy), updatedAt: now }
    const bytes = JSON.stringify(saved).length
    if (bytes > MAX_STRATEGY_BYTES) throw new Error(`this strategy is ${(bytes / 1000).toFixed(1)} kB, over the ${MAX_STRATEGY_BYTES / 1000} kB a saved one may be`)
    this.rows.set(saved.id, saved)
    if (!this.order.includes(saved.id)) this.order.push(saved.id)
    this.persistence.save(`${DOC_PREFIX}${saved.id}`, saved)
    this.persistence.save(INDEX_KEY, { version: INDEX_VERSION, order: this.order })
    this.announce({ kind: 'saved', id: saved.id })
    this.emit()
    return saved
  }

  remove(id: string): void {
    if (this.loadError) throw new Error(this.loadError)
    if (!this.rows.delete(id)) return
    this.order = this.order.filter((o) => o !== id)
    this.persistence.remove(`${DOC_PREFIX}${id}`)
    this.persistence.save(INDEX_KEY, { version: INDEX_VERSION, order: this.order })
    this.announce({ kind: 'removed', id })
    this.emit()
  }

  /** Called with every save or removal made in another tab of this browser. */
  onRemoteChange(listener: (message: SavedMessage) => void): () => void {
    const channel = this.channel
    if (!channel) return () => {}
    const handler = (event: MessageEvent): void => {
      const data = event.data as SavedMessage
      if (data && (data.kind === 'saved' || data.kind === 'removed') && typeof data.id === 'string') listener(data)
    }
    channel.addEventListener('message', handler)
    return () => channel.removeEventListener('message', handler)
  }

  onChange(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  dispose(): void {
    this.channel?.close()
    this.channel = null
    this.listeners.clear()
  }

  private announce(message: SavedMessage): void {
    try {
      this.channel?.postMessage(message)
    } catch {
      // A closed channel: other tabs learn of it on their next read.
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}

let shared: StrategyStore | null = null
let sharedLoad: Promise<StrategyStore> | null = null

/** The page's store, loaded once (the wall's overlay and alerts read it). */
export function sharedStrategyStore(): Promise<StrategyStore> {
  if (!sharedLoad) {
    shared = new StrategyStore()
    const store = shared
    sharedLoad = store.load().then(() => store)
  }
  return sharedLoad
}
