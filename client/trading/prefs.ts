// The trading choices a user makes once and expects to find again: how the ticket sizes an
// order (and the number behind each way of sizing it) and states a stop, the risk and reward numbers, and whether the on-chart order card is
// rolled up. One document per browser, read by the ticket and by every pane's card.
//
// It is also the channel that keeps those consumers in step: a change from any of them notifies
// the rest (rolling the card up on one pane rolls it up on every pane), and a change in another
// tab arrives through the `storage` event, so two windows on one wall agree as well.

/** How the ticket sizes an order: units, standard lots, a share of the balance lost at the stop,
 * an amount lost at the stop, the position's value, or the margin it ties up as a share of the
 * balance. */
export type SizeMode = 'units' | 'lots' | 'risk' | 'riskAmount' | 'notional' | 'margin'
export const SIZE_MODES: SizeMode[] = ['units', 'lots', 'risk', 'riskAmount', 'notional', 'margin']

/** The modes whose size comes from the stop: they fix the loss, so a stop cannot be stated as a
 * share of the balance on top of them. */
export function sizedByStop(mode: SizeMode): boolean {
  return mode === 'risk' || mode === 'riskAmount'
}
export type ProtectMode = 'pips' | 'price' | 'percent'

export interface TradePrefs {
  /** The ticket's size when it is given in units. */
  units: number
  /** Which of the numbers below sizes the ticket. */
  sizeMode: SizeMode
  /** Standard lots (100,000 units), forex only. */
  lots: number
  /** Account currency lost at the stop. */
  riskAmount: number
  /** The position's value in the account currency. */
  notional: number
  /** Margin as a percent of the balance. */
  marginPercent: number
  /** Percent of balance a stop may lose: the ticket's risk sizing and the card's "Risk %" stop. */
  riskPercent: number
  /** How the ticket states a stop and a target. */
  protectMode: ProtectMode
  /** The target multiple last chosen (1R/2R/3R), which the card's target button uses. */
  rewardRatio: number
  /** The on-chart order card rolled up on every pane; null until chosen, when a phone-sized pane
   * starts rolled up and a larger one open. */
  cardCollapsed: boolean | null
}

export const DEFAULT_PREFS: TradePrefs = {
  units: 10_000,
  sizeMode: 'units',
  lots: 0.1,
  riskAmount: 100,
  notional: 10_000,
  marginPercent: 5,
  riskPercent: 1,
  protectMode: 'pips',
  rewardRatio: 2,
  cardCollapsed: null
}

const STORAGE_KEY = 'wd-trade-prefs'

type Listener = (prefs: TradePrefs) => void

let current: TradePrefs | null = null
const listeners = new Set<Listener>()
let watching = false

const positive = (v: unknown, max = Number.POSITIVE_INFINITY): v is number =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 && v <= max

/** Anything malformed falls back field by field, so a bad value never costs the rest. */
export function parsePrefs(raw: unknown): TradePrefs {
  const p = raw && typeof raw === 'object' ? (raw as Record<string, unknown>) : {}
  return {
    units: positive(p.units) ? p.units : DEFAULT_PREFS.units,
    sizeMode: SIZE_MODES.includes(p.sizeMode as SizeMode) ? (p.sizeMode as SizeMode) : DEFAULT_PREFS.sizeMode,
    lots: positive(p.lots) ? p.lots : DEFAULT_PREFS.lots,
    riskAmount: positive(p.riskAmount) ? p.riskAmount : DEFAULT_PREFS.riskAmount,
    notional: positive(p.notional) ? p.notional : DEFAULT_PREFS.notional,
    marginPercent: positive(p.marginPercent, 100) ? p.marginPercent : DEFAULT_PREFS.marginPercent,
    riskPercent: positive(p.riskPercent, 100) ? p.riskPercent : DEFAULT_PREFS.riskPercent,
    protectMode:
      p.protectMode === 'pips' || p.protectMode === 'price' || p.protectMode === 'percent'
        ? p.protectMode
        : DEFAULT_PREFS.protectMode,
    rewardRatio: positive(p.rewardRatio, 100) ? p.rewardRatio : DEFAULT_PREFS.rewardRatio,
    cardCollapsed: typeof p.cardCollapsed === 'boolean' ? p.cardCollapsed : null
  }
}

function read(): TradePrefs {
  try {
    const raw = window.localStorage.getItem(STORAGE_KEY)
    return parsePrefs(raw ? JSON.parse(raw) : null)
  } catch {
    // storage blocked or corrupt: defaults, and the session still works
    return { ...DEFAULT_PREFS }
  }
}

function notify(): void {
  const prefs = tradePrefs()
  for (const listener of [...listeners]) {
    try {
      listener(prefs)
    } catch (err) {
      console.error('[trade-prefs] listener failed', err)
    }
  }
}

function watchOtherTabs(): void {
  if (watching || typeof window.addEventListener !== 'function') return
  watching = true
  window.addEventListener('storage', (event) => {
    if (event.key !== STORAGE_KEY) return
    current = read()
    notify()
  })
}

export function tradePrefs(): TradePrefs {
  if (!current) current = read()
  return current
}

export function setTradePrefs(patch: Partial<TradePrefs>): void {
  const next = parsePrefs({ ...tradePrefs(), ...patch })
  current = next
  try {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  } catch {
    // the change still applies to this tab
  }
  notify()
}

export function subscribeTradePrefs(listener: Listener): () => void {
  watchOtherTabs()
  listeners.add(listener)
  return () => {
    listeners.delete(listener)
  }
}
