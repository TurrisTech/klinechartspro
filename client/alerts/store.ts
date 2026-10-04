// THE CLIENT ALERTS: this account's list, its edits, and where it is kept.
//
// Account-wide, like the starred timeframes and the trade box's prefs -- not part of a
// workspace -- so an edit is written at once rather than waiting for the workspace's Save
// (client/workspaces). Kept under the `alerts` key of `/preferences` where the server has
// that store, and in this browser's localStorage where it does not.
//
// A rule is compiled on every write (./rules.ts), so a rule that could never be evaluated is
// refused when it is written instead of being an alert that silently never fires.

import { hasFeature } from '../capabilities'
import { loadPreferences, savePreference } from '../preferences'
import { compile, describeRule, type Labeller, RuleError } from './rules'
import { type Alert, type AlertDefinition, type AlertSource, DEFAULT_REPEAT, DEFAULT_TRIGGER } from './types'

export const MAX_ALERTS = 200
const PREFERENCE_KEY = 'alerts'
const STORAGE_KEY = 'wd.alerts'
const DOCUMENT_VERSION = 1

/** Where the list lives. */
export interface AlertPersistence {
  load(): Promise<unknown>
  save(document: unknown): void
}

export function preferencesPersistence(): AlertPersistence {
  return {
    load: async () => (await loadPreferences())[PREFERENCE_KEY],
    save: (document) => savePreference(PREFERENCE_KEY, document)
  }
}

export function localPersistence(storage: () => Storage | null = () => window.localStorage): AlertPersistence {
  return {
    load: async () => {
      try {
        const raw = storage()?.getItem(STORAGE_KEY)
        return raw ? JSON.parse(raw) : undefined
      } catch {
        return undefined
      }
    },
    save: (document) => {
      try {
        storage()?.setItem(STORAGE_KEY, JSON.stringify(document))
      } catch (err) {
        console.warn('[alerts] could not save to localStorage', err)
      }
    }
  }
}

/** The server's store where it has one, this browser's otherwise. */
export function defaultPersistence(): AlertPersistence {
  return hasFeature('preferences') ? preferencesPersistence() : localPersistence()
}

/** `oanda:EURUSD` from any spelling of it; throws on something that is not `vendor:TICKER`. */
export function normaliseSymbol(symbol: string): string {
  const raw = symbol.trim()
  const at = raw.indexOf(':')
  if (at <= 0 || at === raw.length - 1) throw new RuleError(`not an instrument: '${symbol}' (want vendor:TICKER)`)
  return `${raw.slice(0, at).toLowerCase()}:${raw.slice(at + 1).toUpperCase()}`
}

/** A stored alert with its internal status: `disabled` is derived from `enabled`, never kept. */
type Row = Omit<Alert, 'status'> & { status: 'armed' | 'fired' }

let counter = 0
function newId(now: number): string {
  counter += 1
  return `al${now.toString(36)}${counter.toString(36)}`
}

export class ClientAlertStore implements AlertSource {
  readonly kind = 'client' as const
  readonly available = true
  readonly unavailable = ''
  private rows = new Map<string, Row>()
  private readonly listeners = new Set<() => void>()
  private loaded = false

  constructor(
    private readonly persistence: AlertPersistence,
    private readonly options: { now?: () => number; label?: Labeller } = {}
  ) {}

  private now(): number {
    return this.options.now?.() ?? Date.now()
  }

  /** Read the stored list. A row whose rule no longer compiles is dropped with a warning
   * rather than kept as an alert that cannot be evaluated. */
  async load(): Promise<void> {
    const document = await this.persistence.load().catch(() => undefined)
    this.rows.clear()
    const list = isRecord(document) && Array.isArray(document.alerts) ? document.alerts : []
    for (const raw of list) {
      const row = readRow(raw)
      if (row) this.rows.set(row.id, row)
      else console.warn('[alerts] dropping a stored alert that no longer reads', raw)
    }
    this.loaded = true
    this.emit()
  }

  get isLoaded(): boolean {
    return this.loaded
  }

  list(): Alert[] {
    return [...this.rows.values()].map(toAlert).sort((a, b) => b.createdAt - a.createdAt)
  }

  get(id: string): Alert | null {
    const row = this.rows.get(id)
    return row ? toAlert(row) : null
  }

  /** The enabled alerts on one instrument: what a replay of it can stop at. */
  enabledOn(symbol: string): Alert[] {
    return this.list().filter((a) => a.enabled && a.symbol === symbol)
  }

  async create(definition: AlertDefinition): Promise<Alert> {
    if (this.rows.size >= MAX_ALERTS) throw new RuleError(`at the limit of ${MAX_ALERTS} alerts`)
    const at = this.now()
    const row: Row = {
      ...this.validated(definition),
      id: newId(at),
      kind: 'client',
      createdAt: at,
      updatedAt: at,
      armedAt: at,
      status: 'armed',
      lastFiredAt: null,
      fireCount: 0
    }
    this.rows.set(row.id, row)
    this.commit()
    return toAlert(row)
  }

  /** Replace what an alert watches. A change to what it watches or how it fires re-arms it:
   * a `once` alert that fired on the old rule has said nothing yet about the new one. */
  async update(id: string, definition: AlertDefinition): Promise<Alert> {
    const row = this.require(id)
    const next = this.validated(definition)
    const rearm = signature(row) !== signature(next) || (next.enabled && !row.enabled)
    Object.assign(row, next, { updatedAt: this.now() })
    if (rearm) this.arm(row)
    this.commit()
    return toAlert(row)
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    const row = this.require(id)
    if (row.enabled === enabled) return
    row.enabled = enabled
    row.updatedAt = this.now()
    if (enabled) this.arm(row)
    this.commit()
  }

  async rearm(id: string): Promise<void> {
    const row = this.require(id)
    row.enabled = true
    this.arm(row)
    row.updatedAt = this.now()
    this.commit()
  }

  async remove(id: string): Promise<void> {
    if (this.rows.delete(id)) this.commit()
  }

  /** A firing, as the live monitor saw it: `at` is the bar close it was about. */
  recordFiring(id: string, at: number): Alert | null {
    const row = this.rows.get(id)
    if (!row) return null
    row.fireCount += 1
    row.lastFiredAt = at
    if (row.repeat === 'once') row.status = 'fired'
    this.commit()
    return toAlert(row)
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  // -- internals ----------------------------------------------------------------------------

  private validated(definition: AlertDefinition): AlertDefinition {
    compile(definition.rule)
    const trigger = definition.trigger ?? DEFAULT_TRIGGER
    const repeat = definition.repeat ?? DEFAULT_REPEAT
    if (trigger !== 'edge' && trigger !== 'level') throw new RuleError(`unknown trigger '${trigger}'`)
    if (repeat !== 'once' && repeat !== 'always') throw new RuleError(`unknown repeat '${repeat}'`)
    const cooldownMs = definition.cooldownMs ?? 0
    if (!Number.isFinite(cooldownMs) || cooldownMs < 0) throw new RuleError('the cooldown must not be negative')
    return {
      name: definition.name.trim() || describeRule(definition.rule, this.options.label),
      note: definition.note?.trim() ?? '',
      enabled: definition.enabled !== false,
      symbol: normaliseSymbol(definition.symbol),
      rule: structuredClone(definition.rule),
      trigger,
      repeat,
      cooldownMs
    }
  }

  private arm(row: Row): void {
    row.status = 'armed'
    row.armedAt = this.now()
  }

  private require(id: string): Row {
    const row = this.rows.get(id)
    if (!row) throw new RuleError(`unknown alert ${id}`)
    return row
  }

  private commit(): void {
    this.persistence.save({ version: DOCUMENT_VERSION, alerts: [...this.rows.values()] })
    this.emit()
  }

  private emit(): void {
    for (const listener of [...this.listeners]) {
      try {
        listener()
      } catch (err) {
        console.error('[alerts] listener failed', err)
      }
    }
  }
}

/** What an alert watches and how it fires -- what a re-arm is keyed on. */
export function signature(definition: Pick<AlertDefinition, 'symbol' | 'rule' | 'trigger' | 'repeat' | 'cooldownMs'>): string {
  return JSON.stringify([definition.symbol, definition.rule, definition.trigger, definition.repeat, definition.cooldownMs])
}

function toAlert(row: Row): Alert {
  return { ...row, rule: structuredClone(row.rule), status: row.enabled ? row.status : 'disabled' }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

function readRow(raw: unknown): Row | null {
  if (!isRecord(raw) || typeof raw.id !== 'string' || typeof raw.symbol !== 'string' || !isRecord(raw.rule)) return null
  try {
    compile(raw.rule as unknown as AlertDefinition['rule'])
  } catch {
    return null
  }
  const num = (value: unknown, fallback: number): number => (typeof value === 'number' && Number.isFinite(value) ? value : fallback)
  return {
    id: raw.id,
    kind: 'client',
    name: typeof raw.name === 'string' ? raw.name : '',
    note: typeof raw.note === 'string' ? raw.note : '',
    enabled: raw.enabled !== false,
    symbol: raw.symbol,
    rule: raw.rule as unknown as AlertDefinition['rule'],
    trigger: raw.trigger === 'edge' ? 'edge' : 'level',
    repeat: raw.repeat === 'once' ? 'once' : 'always',
    cooldownMs: num(raw.cooldownMs, 0),
    createdAt: num(raw.createdAt, 0),
    updatedAt: num(raw.updatedAt, 0),
    armedAt: num(raw.armedAt, 0),
    status: raw.status === 'fired' ? 'fired' : 'armed',
    lastFiredAt: typeof raw.lastFiredAt === 'number' ? raw.lastFiredAt : null,
    fireCount: num(raw.fireCount, 0)
  }
}
