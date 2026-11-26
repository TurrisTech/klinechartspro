import type { SymbolInfo } from '../../../src'
import { symbolVendor } from '../../symbols'
import type { WatchStore } from '../../watch/store'
import { instrumentTarget, PRICE_SOURCE, type Watch, type WatchRepeat } from '../../watch/types'
import type { AlertTarget } from '../types'
import { alertName, alertNote, centredOn, type Zone, zoneAround, zoneCondition, zoneOf, zoneUnit } from './zone'

// The PRICE ALERTS the chart's layers can see: a view of one watch backend, narrowed to the
// watches that are price alerts (zone.ts), plus the things a line can have done to it -- enable
// (once, or every time), a new buffer, once or every time again, remove. One per wall, shared by
// every layer that offers alerts.
//
// The backend is the one the chart's price-watch lines use, handed in once the wall knows which
// it is (client/index.ts): this browser's view of the SERVER's watches on a live wall, which is
// what lets an alert fire with the tab closed, and the replay's own registry on a replay wall,
// whose market only exists in this tab. No backend -- a server without `watch` -- and the lines
// are simply not clickable. Nothing here evaluates anything or persists anything; every change
// is a call, and the store's answer is what is drawn (client/watch/store.ts).

export interface PriceAlertBackend {
  store: WatchStore
  /** Why an instrument cannot be watched on this wall, or null when it can -- a replay walks
   * one instrument. */
  canWatch?(target: string): string | null
}

export interface PriceAlert {
  watch: Watch
  zone: Zone
}

/** An alert armed once that has fired, and so is done: the grey pill with the 1. It waits on
 * nothing until a click takes it round again. A switched-off alert is not one -- it is off. */
export function firedOnce(watch: Pick<Watch, 'enabled' | 'repeat' | 'status'>): boolean {
  return watch.enabled && watch.repeat === 'once' && watch.status === 'fired'
}

/** The quiet spell after an alert fires. An alert on a line keeps watching (`repeat:
 * 'always'`: the line is ENABLED, not set once), and entering the zone needs leaving it first
 * -- but a price that chops across the zone's edge would still raise one a minute on the
 * server's default. */
export const PRICE_ALERT_COOLDOWN_MS = 5 * 60_000

export type PriceAlertsListener = () => void

export class PriceAlerts {
  private backend: PriceAlertBackend | null = null
  private unsubscribe: (() => void) | null = null
  private alerts: PriceAlert[] = []
  /** `target|price` of the enables in flight, so a double click makes one watch. */
  private readonly pending = new Set<string>()
  private readonly listeners = new Set<PriceAlertsListener>()

  /** Use `backend`, or none. Replaces whatever was used before. */
  connect(backend: PriceAlertBackend | null): void {
    this.unsubscribe?.()
    this.unsubscribe = null
    this.backend = backend
    this.alerts = []
    if (!backend) {
      this.emit()
      return
    }
    // The store reports its list at once and then every change -- a create, an edit, a
    // delete, and the re-read a firing triggers.
    this.unsubscribe = backend.store.subscribe((watches) => {
      this.alerts = watches.flatMap((watch) => {
        const zone = zoneOf(watch)
        return zone ? [{ watch, zone }] : []
      })
      this.emit()
    })
  }

  /** Whether lines can be alerted on at all here. */
  get available(): boolean {
    return this.backend !== null
  }

  /** Why `target` cannot have an alert, or null when it can. */
  refusal(target: string): string | null {
    if (!this.backend) return 'Alerts are not served here'
    return this.backend.canWatch?.(target) ?? null
  }

  /** Every price alert on one instrument. */
  forInstrument(vendor: string, ticker: string): PriceAlert[] {
    const target = instrumentTarget(vendor, ticker)
    return this.alerts.filter((alert) => alert.watch.target === target)
  }

  /** The alert of the line at `price` on one instrument, or null when it is not enabled. */
  at(vendor: string, ticker: string, price: number, precision: number): PriceAlert | null {
    return this.forInstrument(vendor, ticker).find((alert) => centredOn(alert.zone, price, precision)) ?? null
  }

  get(id: string): PriceAlert | null {
    return this.alerts.find((alert) => alert.watch.id === id) ?? null
  }

  /** Enable a line: an alert when price enters its price plus or minus `pips` -- every time it
   * does (`always`, after a cooldown), or the first time only (`once`), after which it stays
   * fired until armed again. */
  async enable(symbol: SymbolInfo, line: AlertTarget, pips: number, repeat: WatchRepeat = 'always'): Promise<Watch | null> {
    const backend = this.backend
    if (!backend) return null
    const vendor = symbolVendor(symbol)
    const precision = symbol.pricePrecision ?? 5
    const existing = this.at(vendor, symbol.ticker, line.price, precision)
    if (existing) return existing.watch
    const target = instrumentTarget(vendor, symbol.ticker)
    const key = `${target}|${line.price}`
    if (this.pending.has(key)) return null
    this.pending.add(key)
    try {
      const unit = zoneUnit(symbol)
      const zone = zoneAround(line.price, pips, unit, precision)
      return await backend.store.create({
        source: PRICE_SOURCE,
        target,
        condition: zoneCondition(zone),
        name: alertName(symbol.ticker, line, precision),
        note: alertNote(zone, unit, precision),
        trigger: 'edge',
        repeat,
        cooldownMs: PRICE_ALERT_COOLDOWN_MS
      })
    } finally {
      this.pending.delete(key)
    }
  }

  /** A new buffer for an enabled line. One PATCH: a changed condition re-arms the watch, so
   * the backend re-seeds the crossing baseline from the market as it is now. */
  async setPips(id: string, symbol: SymbolInfo, pips: number): Promise<Watch | null> {
    const alert = this.get(id)
    if (!alert || !this.backend) return null
    const precision = symbol.pricePrecision ?? 5
    const unit = zoneUnit(symbol)
    const zone = zoneAround(alert.zone.center, pips, unit, precision)
    return this.backend.store.update(id, { condition: zoneCondition(zone), note: alertNote(zone, unit, precision) })
  }

  /** Arm an enabled line's alert once or every time from here: switched on, and armed afresh
   * when it had fired (a one-shot spent) or was switched off -- the crossing baseline seeded from
   * the market as it is now, as on any arm. */
  async setRepeat(id: string, repeat: WatchRepeat): Promise<Watch | null> {
    const alert = this.get(id)
    if (!alert || !this.backend) return null
    const { watch } = alert
    const store = this.backend.store
    let next: Watch | null = watch
    if (watch.repeat !== repeat || !watch.enabled) next = await store.update(id, { repeat, enabled: true })
    // A changed repeat re-arms on its own; a spent one-shot asked for again does not.
    if (next && next.status !== 'armed') next = await store.arm(id)
    return next
  }

  async remove(id: string): Promise<void> {
    if (!this.backend || !this.get(id)) return
    await this.backend.store.remove(id)
  }

  /** Remove every one of `ids` that is still here, at once; resolves to how many went. One the
   * backend refused is kept (the store logs it), and not counted. */
  async removeMany(ids: readonly string[]): Promise<number> {
    const here = [...new Set(ids)].filter((id) => this.get(id))
    await Promise.all(here.map((id) => this.remove(id)))
    return here.filter((id) => !this.get(id)).length
  }

  subscribe(listener: PriceAlertsListener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  private emit(): void {
    for (const listener of this.listeners) listener()
  }
}
