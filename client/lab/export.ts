// WHAT LEAVES THE PAGE AS A FILE: a run's entries and trades as CSV, and a strategy as JSON --
// the way a strategy moves between the dev and prod dashboards, whose saved strategies live in
// each environment's own preferences.
//
// CSV holds raw values -- instants as ISO UTC, prices and pips unrounded -- for a spreadsheet or a
// notebook, not the table's formatting.
//
// PURE but for `download`.

import { rootIndex } from './entries'
import { newStrategyId, readStrategy, type Strategy } from './model'
import type { LabRun } from './runner'

const iso = (ms: number | null | undefined): string => (ms === null || ms === undefined ? '' : new Date(ms).toISOString())

/** One CSV field: quoted when it holds a comma, a quote or a line break. */
function field(value: unknown): string {
  if (value === null || value === undefined) return ''
  const text = typeof value === 'number' ? (Number.isFinite(value) ? String(value) : '') : String(value)
  return /[",\n\r]/.test(text) ? `"${text.replace(/"/g, '""')}"` : text
}

function csv(header: string[], rows: unknown[][]): string {
  return `${[header, ...rows].map((r) => r.map(field).join(',')).join('\n')}\n`
}

/** Entries and the filter's rejects, in time, with every outcome measured. */
export function entriesCsv(run: LabRun): string {
  const horizons = [...run.strategy.outcomes.horizons].filter((h) => h >= 1).sort((a, b) => a - b)
  const touches = run.strategy.outcomes.touches
  const all = [...run.entries.map((e) => ({ e, filtered: false })), ...run.filtered.map((e) => ({ e, filtered: true }))].sort((a, b) => a.e.at - b.e.at)
  const header = [
    'symbol',
    'at_utc',
    'interval',
    'side',
    'direction',
    'filtered',
    'holdout',
    'price',
    'source',
    'root_interval',
    'root_at_utc',
    'depth',
    'atr',
    ...horizons.map((h) => `fwd_pips_${h}`),
    ...touches.map((k) => `first_to_${k}atr`),
    'mfe_pips',
    'mae_pips',
    'mfe_atr',
    'mae_atr'
  ]
  const rows = all.map(({ e, filtered }) => {
    const o = run.outcomes.get(e.id)
    const root = e.graph ? (e.graph.nodes[rootIndex(e.graph, e.node)] ?? null) : null
    return [
      run.symbol,
      iso(e.at),
      e.signal.interval,
      e.side,
      e.direction,
      filtered,
      run.split !== null && e.at >= run.split,
      e.signal.price,
      e.signal.source,
      e.graph?.root ?? '',
      iso(root?.signal.knownAt),
      e.graph ? e.graph.nodes[e.node].depth : '',
      o?.atr,
      ...horizons.map((_, h) => o?.forward[h]?.pips),
      ...touches.map((_, t) => o?.touches[t]?.result ?? ''),
      o?.mfePips,
      o?.maePips,
      o?.mfeAtr,
      o?.maeAtr
    ]
  })
  return csv(header, rows)
}

/** The simulated trades, in the order they opened. */
export function tradesCsv(run: LabRun): string {
  const header = [
    'symbol',
    'opened_utc',
    'direction',
    'units',
    'capped',
    'open_price',
    'stop',
    'target',
    'closed_utc',
    'reason',
    'close_price',
    'pips',
    'r',
    'pnl',
    'commission',
    'financing',
    'slippage',
    'bars_held',
    'holdout',
    'entry_interval'
  ]
  const rows = (run.sim?.trades ?? []).map((t) => [
    run.symbol,
    iso(t.openedAt),
    t.direction,
    t.units,
    t.capped,
    t.openPrice,
    t.stop,
    t.target,
    iso(t.closedAt),
    t.reason ?? '',
    t.closePrice,
    t.pips,
    t.r,
    t.pnl,
    t.commission,
    t.financing,
    t.slippage,
    t.barsHeld,
    run.split !== null && t.openedAt >= run.split,
    t.entry.signal.interval
  ])
  return csv(header, rows)
}

/** A file name from a strategy's name: letters, digits and dashes. */
export function fileStem(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'strategy'
  )
}

/** A strategy as a file: the stored document, with a marker saying what it is. */
export function strategyJson(strategy: Strategy): string {
  return `${JSON.stringify({ kind: 'wdashboard-strategy', strategy }, null, 2)}\n`
}

export class ImportError extends Error {}

/** A strategy file read back as a NEW strategy: a fresh id, so importing never overwrites one
 * that exists. Accepts the file `strategyJson` writes, or a bare stored strategy. */
export function readStrategyFile(text: string, now = Date.now()): Strategy {
  let raw: unknown
  try {
    raw = JSON.parse(text)
  } catch {
    throw new ImportError('not a JSON file')
  }
  const body = raw && typeof raw === 'object' && 'strategy' in raw ? (raw as { strategy: unknown }).strategy : raw
  const strategy = readStrategy(body)
  if (!strategy) throw new ImportError('not a strategy this lab can read (or one from a newer version of it)')
  return { ...strategy, id: newStrategyId(now), createdAt: now, updatedAt: now }
}

/** Hand `text` to the browser as a file to save. */
export function download(name: string, text: string, type: string): void {
  const url = URL.createObjectURL(new Blob([text], { type }))
  const a = document.createElement('a')
  a.href = url
  a.download = name
  document.body.appendChild(a)
  a.click()
  a.remove()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
}
