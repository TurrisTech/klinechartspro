import { hasFeature } from '../capabilities'
import { loadPreferences, savePreference } from '../preferences'
import { sideOf } from './cross'
import { type AlertDraft, instrumentKey, type PriceAlert } from './types'

// Every price alert this account has, and where they are kept.
//
// Storage mirrors client/workspaces/store.ts: the /preferences document is authoritative
// wherever the server advertises `preferences`, and localStorage is both the fallback (prod
// has no appstate database) and a mirror that answers a reload when /preferences is
// unreachable. Unlike workspaces this is ONE key holding the whole list rather than a key per
// alert -- alerts are small, they are edited one at a time, and the multi-device merge a
// key-per-document buys is not worth a key space per row. Two devices editing alerts at the
// same moment is therefore last-write-wins across the whole list.
//
// The store is the feature's single source of truth: the overlays, the monitor and the
// dialogs all read it and all react to `subscribe`, so there is exactly one place an alert
// can change and one place a change is announced from.

const KEY = 'priceAlerts'
const LOCAL_KEY = `wd.${KEY}`

/** A ceiling, not a quota. The whole preferences document is 64 KiB (appstate.py's
 * MAX_PREFERENCES_BYTES) and shares it with the workspaces, so a runaway alert list must hit
 * a clear limit here rather than a 413 on a PUT nobody sees. */
export const MAX_ALERTS = 200

export type AlertsListener = (alerts: PriceAlert[]) => void

function isAlert(value: unknown): value is PriceAlert {
  if (!value || typeof value !== 'object') return false
  const row = value as Record<string, unknown>
  return (
    typeof row.id === 'string' &&
    typeof row.vendor === 'string' &&
    typeof row.symbol === 'string' &&
    typeof row.price === 'number' &&
    Number.isFinite(row.price) &&
    (row.from === 'above' || row.from === 'below') &&
    (row.status === 'armed' || row.status === 'triggered')
  )
}

// Tolerant in the same way isPersistedLayout is: a row this client cannot read is dropped,
// never half-restored. The two timestamps are repaired rather than required, because an
// alert written by an older build predates `armedAt`.
function adopt(value: unknown): PriceAlert | null {
  if (!isAlert(value)) return null
  const row = value as PriceAlert
  const createdAt = typeof row.createdAt === 'number' ? row.createdAt : Date.now()
  return {
    ...row,
    createdAt,
    armedAt: typeof row.armedAt === 'number' ? row.armedAt : createdAt,
    reference: typeof row.reference === 'number' ? row.reference : row.price
  }
}

function newId(): string {
  return `a${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`
}

function readLocal(): unknown {
  try {
    const raw = window.localStorage.getItem(LOCAL_KEY)
    return raw === null ? null : (JSON.parse(raw) as unknown)
  } catch (err) {
    console.warn('[alerts] could not read the local mirror', err)
    return null
  }
}

function writeLocal(alerts: PriceAlert[]): void {
  try {
    window.localStorage.setItem(LOCAL_KEY, JSON.stringify(alerts))
  } catch (err) {
    console.warn('[alerts] could not write the local mirror', err)
  }
}

export class AlertStore {
  private alerts: PriceAlert[] = []
  private readonly listeners = new Set<AlertsListener>()

  /** `remote` false keeps everything in localStorage — prod, and every test. */
  constructor(private readonly remote: boolean) {}

  /** Newest first. A copy; nothing outside mutates the list in place. */
  list(): PriceAlert[] {
    return [...this.alerts]
  }

  get(id: string): PriceAlert | null {
    return this.alerts.find((alert) => alert.id === id) ?? null
  }

  /** Every alert on one instrument, in the order they were created — which is the order the
   * overlays and the context menu want, so neither has to sort. */
  forInstrument(vendor: string, symbol: string): PriceAlert[] {
    const key = instrumentKey(vendor, symbol)
    return this.alerts
      .filter((alert) => instrumentKey(alert.vendor, alert.symbol) === key)
      .sort((a, b) => a.createdAt - b.createdAt)
  }

  /** Every instrument with at least one ARMED alert — what the monitor subscribes to. */
  armedInstruments(): Array<{ vendor: string; symbol: string }> {
    const seen = new Map<string, { vendor: string; symbol: string }>()
    for (const alert of this.alerts) {
      if (alert.status !== 'armed') continue
      seen.set(instrumentKey(alert.vendor, alert.symbol), { vendor: alert.vendor, symbol: alert.symbol })
    }
    return [...seen.values()]
  }

  atCapacity(): boolean {
    return this.alerts.length >= MAX_ALERTS
  }

  add(draft: AlertDraft): PriceAlert | null {
    if (this.atCapacity()) {
      console.warn(`[alerts] refusing a new alert — at the ${MAX_ALERTS} limit`)
      return null
    }
    const now = Date.now()
    const alert: PriceAlert = {
      id: newId(),
      vendor: draft.vendor,
      symbol: draft.symbol,
      price: draft.price,
      // From the MARKET price, never from the level the dialog was seeded with: picking a
      // bar's high seeds the dialog above the market, and the side the alert waits on is a
      // fact about where the market is, not about which number was clicked.
      from: sideOf(draft.reference, draft.price),
      reference: draft.reference,
      note: draft.note,
      armedAt: now,
      createdAt: now,
      status: 'armed'
    }
    this.alerts = [alert, ...this.alerts]
    this.commit()
    return alert
  }

  /** Move an alert's level and re-arm it against the market price now. The one path a drag
   * and an edit both take: a new level means a new side, and a new `armedAt` so a bar that
   * was already forming cannot fire it. */
  rearm(id: string, price: number, reference: number, note?: string): PriceAlert | null {
    return this.patch(id, (alert) => ({
      ...alert,
      price,
      reference,
      from: sideOf(reference, price),
      note: note ?? alert.note,
      armedAt: Date.now(),
      status: 'armed',
      triggeredAt: undefined,
      triggeredPrice: undefined
    }))
  }

  /** Called by the monitor. Idempotent: a second call on an already-triggered alert is a
   * no-op, so a duplicate frame cannot raise a second notification. */
  markTriggered(id: string, price: number, at: number): PriceAlert | null {
    const current = this.get(id)
    if (!current || current.status === 'triggered') return null
    return this.patch(id, (alert) => ({
      ...alert,
      status: 'triggered',
      triggeredAt: at,
      triggeredPrice: price
    }))
  }

  remove(id: string): void {
    const next = this.alerts.filter((alert) => alert.id !== id)
    if (next.length === this.alerts.length) return
    this.alerts = next
    this.commit()
  }

  clearTriggered(): void {
    const next = this.alerts.filter((alert) => alert.status !== 'triggered')
    if (next.length === this.alerts.length) return
    this.alerts = next
    this.commit()
  }

  subscribe(listener: AlertsListener): () => void {
    this.listeners.add(listener)
    listener(this.list())
    return () => this.listeners.delete(listener)
  }

  /** Replace the whole list — the boot path, and the only writer that does not persist:
   * what was just read back does not need writing again. */
  hydrate(alerts: PriceAlert[]): void {
    this.alerts = alerts
    this.emit()
  }

  private patch(id: string, change: (alert: PriceAlert) => PriceAlert): PriceAlert | null {
    const index = this.alerts.findIndex((alert) => alert.id === id)
    if (index < 0) return null
    const next = change(this.alerts[index])
    this.alerts = [...this.alerts.slice(0, index), next, ...this.alerts.slice(index + 1)]
    this.commit()
    return next
  }

  private commit(): void {
    if (this.remote) savePreference(KEY, this.alerts)
    writeLocal(this.alerts)
    this.emit()
  }

  private emit(): void {
    const snapshot = this.list()
    for (const listener of this.listeners) listener(snapshot)
  }
}

let loading: Promise<AlertStore> | null = null

/** The page's store, built once. Like the workspaces', it reads /preferences where the
 * server has it and falls back to the local mirror otherwise. */
export function loadAlerts(): Promise<AlertStore> {
  if (!loading) loading = build()
  return loading
}

async function build(): Promise<AlertStore> {
  const remote = hasFeature('preferences')
  const store = new AlertStore(remote)

  let stored: unknown = null
  if (remote) {
    try {
      stored = (await loadPreferences())[KEY] ?? null
    } catch (err) {
      console.warn('[alerts] preferences load failed', err)
    }
  }
  // The mirror answers both the no-server case (prod) and a dev boot where /preferences was
  // unreachable or has never been written.
  if (!Array.isArray(stored)) stored = readLocal()

  const alerts = Array.isArray(stored)
    ? stored.map(adopt).filter((alert): alert is PriceAlert => alert !== null).slice(0, MAX_ALERTS)
    : []
  store.hydrate(alerts)
  return store
}

/** Tests and the dev console; never used by the app. */
export function resetAlertsForTests(): void {
  loading = null
}
