// THE CLIENT ALERTS: this account's list, its edits, and where it is kept.
//
// Account-wide, like the starred timeframes and the trade box's prefs -- not part of a
// workspace -- so an edit is written at once rather than waiting for the workspace's Save
// (client/workspaces). Kept under the `alerts` key of `/preferences` where the server has
// that store, and in this browser's localStorage where it does not.
//
// A rule is compiled on every write (./rules.ts), so a rule that could never be evaluated is
// refused when it is written instead of being an alert that silently never fires.
//
// EVERY WRITE IS AN EDIT BY ID, never this tab's whole list. The user runs a dozen tabs and more
// than one device, and every tab's monitor records its firings: a tab that saved its copy of the
// list on a firing erased every alert made elsewhere since it loaded, and switched back on any
// it still held as on. Now an edit -- create, change, switch, re-arm, delete, a firing -- is
// one function over the rows, run on this tab's at once and on the STORED list when the write
// goes out (`AlertPersistence.update`, which preferences.ts runs again on a conflict). A firing
// touches only the firing fields, skips an alert switched off or deleted elsewhere, and counts
// one bar close once however many tabs saw it. Once written, the tab adopts the stored list --
// every tab's alerts -- under its own edits still on their way.

import { hasFeature } from '../capabilities'
import { loadPreferences, preferencesLoaded, updatePreference } from '../preferences'
import { compile, describeRule, type Labeller, RuleError } from './rules'
import { type Alert, type AlertDefinition, type AlertSource, DEFAULT_REPEAT, DEFAULT_TRIGGER } from './types'
import { instrumentKey, splitInstrumentKey } from '../instrumentkey'

const MAX_ALERTS = 200
const PREFERENCE_KEY = 'alerts'
const STORAGE_KEY = 'wd.alerts'
const DOCUMENT_VERSION = 1

/** Where the list lives. */
export interface AlertPersistence {
  load(): Promise<unknown>
  /** Write `apply(stored)`, where `stored` is the document as it is when the write goes out --
   * not as this tab last read it -- then tell `written` what was stored. */
  update(apply: (stored: unknown) => unknown, written: (stored: unknown) => void): void
}

function preferencesPersistence(): AlertPersistence {
  return {
    load: async () => {
      const data = await loadPreferences()
      // A failed read answers `{}`, which would read as "no alerts".
      if (!preferencesLoaded()) throw new Error('the preferences store could not be read')
      return data[PREFERENCE_KEY]
    },
    update: (apply, written) => updatePreference(PREFERENCE_KEY, apply, written)
  }
}

function localPersistence(storage: () => Storage | null = () => window.localStorage): AlertPersistence {
  const read = (): unknown => {
    try {
      const raw = storage()?.getItem(STORAGE_KEY)
      return raw ? JSON.parse(raw) : undefined
    } catch {
      return undefined
    }
  }
  return {
    load: async () => read(),
    // Synchronous, and every tab of this browser shares the one storage: read, edit, write.
    update: (apply, written) => {
      const next = apply(read())
      try {
        storage()?.setItem(STORAGE_KEY, JSON.stringify(next))
      } catch (err) {
        console.warn('[alerts] could not save to localStorage', err)
        return
      }
      written(next)
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
  const { vendor, ticker } = splitInstrumentKey(raw)
  // An alert names its vendor: a bare ticker is refused here, not read as the default vendor's.
  if (!raw.includes(':') || !vendor || !ticker) throw new RuleError(`not an instrument: '${symbol}' (want vendor:TICKER)`)
  return instrumentKey(vendor.toLowerCase(), ticker.toUpperCase())
}

/** A stored alert with its internal status: `disabled` is derived from `enabled`, never kept. */
type Row = Omit<Alert, 'status'> & { status: 'armed' | 'fired' }

/** One change to the list, by id. Run on this tab's rows and on the stored ones, which may lack
 * its row or hold another version of it, so it decides from the row it is given. */
type Edit = (rows: Map<string, Row>) => void

function arm(row: Row, at: number): void {
  row.status = 'armed'
  row.armedAt = at
}

/** A stored document's rows, by id, and the entries this client cannot read (a newer client's,
 * or a rule that no longer compiles), which a write keeps as they are. */
function storedRows(document: unknown): { rows: Map<string, Row>; unread: unknown[] } {
  const rows = new Map<string, Row>()
  const unread: unknown[] = []
  const list = isRecord(document) && Array.isArray(document.alerts) ? document.alerts : []
  for (const raw of list) {
    const row = readRow(raw)
    if (row) rows.set(row.id, row)
    else unread.push(raw)
  }
  return { rows, unread }
}

/** `edit` applied to a stored document: every stored alert is kept unless the edit is about it. */
function applyToStored(document: unknown, edit: Edit): unknown {
  const { rows, unread } = storedRows(document)
  edit(rows)
  return { version: DOCUMENT_VERSION, alerts: [...rows.values(), ...unread] }
}

/** A firing at the bar close `at`. Not on an alert switched off or deleted since, nor on a `once`
 * alert that has already fired; and a bar close already counted -- by another tab that saw it
 * too -- is not counted again. */
function fired(id: string, at: number): Edit {
  return (rows) => {
    const row = rows.get(id)
    if (!row?.enabled || (row.repeat === 'once' && row.status === 'fired')) return
    if (row.lastFiredAt !== null && at <= row.lastFiredAt) return
    row.fireCount += 1
    row.lastFiredAt = at
    if (row.repeat === 'once') row.status = 'fired'
  }
}

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
  /** This tab's edits not yet confirmed written, in order: laid over the stored list it adopts. */
  private unwritten: Edit[] = []
  /** Inside `change`, which tells the listeners itself once it is done. */
  private changing = false
  private readonly listeners = new Set<() => void>()
  private loaded = false
  /** Set when the stored list could not be read. Nothing is written then: a save would replace
   * the list that is still stored with whatever this tab holds. */
  loadError = ''

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
    let document: unknown
    try {
      document = await this.persistence.load()
      this.loadError = ''
    } catch (err) {
      console.warn('[alerts] could not read the stored alerts', err)
      this.loadError = 'Your saved alerts could not be read, so nothing is saved until they are. Reload the page to try again.'
      document = undefined
    }
    const { rows, unread } = storedRows(document)
    for (const raw of unread) console.warn('[alerts] a stored alert that no longer reads is not shown', raw)
    for (const edit of this.unwritten) edit(rows)
    this.rows = rows
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

  /** The enabled alerts, on every instrument: what a bar replay's Next alert can stop at. */
  enabled(): Alert[] {
    return this.list().filter((a) => a.enabled)
  }

  /** The enabled alerts on one instrument. */
  enabledOn(symbol: string): Alert[] {
    return this.list().filter((a) => a.enabled && a.symbol === symbol)
  }

  async create(definition: AlertDefinition): Promise<Alert> {
    this.writable()
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
    this.change((rows) => {
      if (!rows.has(row.id)) rows.set(row.id, structuredClone(row))
    })
    return toAlert(row)
  }

  /** Replace what an alert watches. A change to what it watches or how it fires re-arms it:
   * a `once` alert that fired on the old rule has said nothing yet about the new one. */
  async update(id: string, definition: AlertDefinition): Promise<Alert> {
    this.writable()
    this.require(id)
    const next = this.validated(definition)
    const at = this.now()
    this.change((rows) => {
      const row = rows.get(id)
      if (!row) return
      const rearm = signature(row) !== signature(next) || (next.enabled && !row.enabled)
      Object.assign(row, structuredClone(next), { updatedAt: at })
      if (rearm) arm(row, at)
    })
    return toAlert(this.require(id))
  }

  async setEnabled(id: string, enabled: boolean): Promise<void> {
    this.writable()
    if (this.require(id).enabled === enabled) return
    const at = this.now()
    this.change((rows) => {
      const row = rows.get(id)
      if (!row || row.enabled === enabled) return
      row.enabled = enabled
      row.updatedAt = at
      if (enabled) arm(row, at)
    })
  }

  async rearm(id: string): Promise<void> {
    this.writable()
    this.require(id)
    const at = this.now()
    this.change((rows) => {
      const row = rows.get(id)
      if (!row) return
      row.enabled = true
      arm(row, at)
      row.updatedAt = at
    })
  }

  async remove(id: string): Promise<void> {
    this.writable()
    if (this.rows.has(id)) this.change((rows) => void rows.delete(id))
  }

  /** A firing, as the live monitor saw it: `at` is the bar close it was about. */
  recordFiring(id: string, at: number): Alert | null {
    if (!this.rows.has(id)) return null
    this.change(fired(id, at))
    const row = this.rows.get(id)
    return row ? toAlert(row) : null
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

  private writable(): void {
    if (this.loadError) throw new RuleError(this.loadError)
  }

  private require(id: string): Row {
    const row = this.rows.get(id)
    if (!row) throw new RuleError(`unknown alert ${id}`)
    return row
  }

  /** `edit` on this tab's rows now, and on the stored list when it is written. */
  private change(edit: Edit): void {
    edit(this.rows)
    this.unwritten.push(edit)
    // A persistence may write at once (this browser's storage) and adopt before it returns.
    this.changing = true
    try {
      this.persistence.update(
        (stored) => applyToStored(stored, edit),
        (stored) => this.adopt(stored, edit)
      )
    } finally {
      this.changing = false
    }
    this.emit()
  }

  /** The stored list as written -- every tab's and device's alerts, `written` and the edits before
   * it among them -- with this tab's later edits, still on their way, laid over it. */
  private adopt(stored: unknown, written: Edit): void {
    const at = this.unwritten.indexOf(written)
    if (at >= 0) this.unwritten.splice(0, at + 1)
    const { rows } = storedRows(stored)
    for (const edit of this.unwritten) edit(rows)
    this.rows = rows
    if (!this.changing) this.emit()
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
