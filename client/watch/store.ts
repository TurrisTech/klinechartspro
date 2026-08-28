import { hasFeature } from '../capabilities'
import { watchApi } from './api'
import type { SourceCatalogue } from './api'
import type { Watch, WatchDraft, WatchSource } from './types'
import { instrumentTarget } from './types'

// This browser's view of the watches the SERVER holds.
//
// A cache, not a store: every mutation is a call, and what comes back replaces the local
// copy. Nothing is persisted here and nothing is evaluated here -- the previous version of
// this feature kept the alerts in `/preferences` and ran a monitor in the tab, and both are
// gone because the server does the watching now.
//
// `subscribe` reports the current list immediately, then every change, so the overlays never
// have to render once before subscribing (the same contract `stream.onStatus` has).

export type WatchesListener = (watches: Watch[]) => void

/** The half of the wire the store uses. Named so a test can hand in a fake without a
 * network, a window, or a running server. */
export interface WatchApi {
  sources(): Promise<SourceCatalogue>
  list(): Promise<Watch[]>
  create(draft: WatchDraft): Promise<Watch>
  update(id: string, patch: Partial<WatchDraft>): Promise<Watch>
  arm(id: string): Promise<Watch>
  remove(id: string): Promise<unknown>
}

export class WatchStore {
  private watches: Watch[] = []
  private sources: WatchSource[] = []
  private readonly listeners = new Set<WatchesListener>()

  constructor(private readonly api: WatchApi = watchApi) {}

  /** Newest first, as the server orders them. A copy. */
  list(): Watch[] {
    return [...this.watches]
  }

  get(id: string): Watch | null {
    return this.watches.find((watch) => watch.id === id) ?? null
  }

  /** Every `price` watch on one instrument, oldest first — the order the overlays and the
   * context menu want, so neither has to sort. */
  forInstrument(vendor: string, symbol: string): Watch[] {
    const target = instrumentTarget(vendor, symbol)
    return this.watches
      .filter((watch) => watch.target === target)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** The source catalogue, for anything building a form. Empty until `load`. */
  catalogue(): WatchSource[] {
    return [...this.sources]
  }

  source(id: string): WatchSource | null {
    return this.sources.find((source) => source.id === id) ?? null
  }

  async load(): Promise<void> {
    // The catalogue and the list are independent: a failure to read one must not cost the
    // other, and neither must stop the wall mounting.
    const [sources, watches] = await Promise.all([
      this.api.sources().catch((err) => {
        console.warn('[watch] could not read the source catalogue', err)
        return { sources: [] as WatchSource[], ops: [], maxWatches: 0 }
      }),
      this.api.list().catch((err) => {
        console.warn('[watch] could not read the watches', err)
        return [] as Watch[]
      })
    ])
    this.sources = sources.sources
    this.watches = watches
    this.emit()
  }

  /** Re-read the list. Called when a watch fires — the server has just changed its status,
   * and nothing else tells this tab about it. */
  async refresh(): Promise<void> {
    try {
      this.watches = await this.api.list()
      this.emit()
    } catch (err) {
      console.warn('[watch] could not refresh', err)
    }
  }

  async create(draft: WatchDraft): Promise<Watch | null> {
    return this.apply(() => this.api.create(draft))
  }

  async update(id: string, patch: Partial<WatchDraft>): Promise<Watch | null> {
    return this.apply(() => this.api.update(id, patch))
  }

  async arm(id: string): Promise<Watch | null> {
    return this.apply(() => this.api.arm(id))
  }

  async remove(id: string): Promise<void> {
    try {
      await this.api.remove(id)
    } catch (err) {
      console.error('[watch] could not delete', err)
      return
    }
    this.watches = this.watches.filter((watch) => watch.id !== id)
    this.emit()
  }

  subscribe(listener: WatchesListener): () => void {
    this.listeners.add(listener)
    listener(this.list())
    return () => this.listeners.delete(listener)
  }

  private async apply(request: () => Promise<Watch>): Promise<Watch | null> {
    let watch: Watch
    try {
      watch = await request()
    } catch (err) {
      // The server refuses a condition it cannot evaluate (a 400 carrying the reason), which
      // is worth surfacing rather than swallowing -- but not worth tearing the wall down for.
      console.error('[watch] refused', err)
      return null
    }
    const index = this.watches.findIndex((existing) => existing.id === watch.id)
    this.watches =
      index < 0
        ? [watch, ...this.watches]
        : [...this.watches.slice(0, index), watch, ...this.watches.slice(index + 1)]
    this.emit()
    return watch
  }

  private emit(): void {
    const snapshot = this.list()
    for (const listener of this.listeners) listener(snapshot)
  }
}

let loading: Promise<WatchStore> | null = null

/** The page's store, built once. Empty (and inert) on a server without the `watch` feature,
 * so an older server simply has no watches rather than a wall of failed requests. */
export function loadWatches(): Promise<WatchStore> {
  if (!loading) {
    const store = new WatchStore()
    loading = hasFeature('watch') ? store.load().then(() => store) : Promise.resolve(store)
  }
  return loading
}
