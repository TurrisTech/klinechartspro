// A PARAMETER SWEEP: one number of a strategy run over a range of values, a row of figures per
// value (figures.ts). Every number a strategy holds can be swept -- a published signal's read
// parameters (rank 85's `q`), a NUMBER WRITTEN IN A CONDITION (the 8 of `parent.tf <= child.tf *
// 8`), a stop's or a target's distance, the time limit, the costs -- so the question "how much
// does this rule depend on that 8?" is one sweep, not eight edits.
//
// Each value is a full run of a copy of the draft; the draft itself is untouched until the user
// takes a value (`SweepTarget.apply` on the draft). The data layer holds what the first run read,
// so the rest read only what a changed parameter needs anew (a signal's `q` reads its own
// signals; a stop's ATR multiple reads nothing).
//
// With a holdout (model.ts `HoldoutSpec`) each row also carries the two parts, so a value can be
// chosen on the fitting part and checked on the part held back.
//
// PURE, but for the run it is handed.

import { type Figures, figuresOf } from './figures'
import type { Level, Strategy } from './model'
import type { LabRun } from './runner'

export interface SweepTarget {
  /** Stable for a strategy: what the sweep panel remembers the choice by. */
  id: string
  /** The section it belongs to, for grouping: Signals, Graph, Entries, Exits, Costs. */
  section: string
  label: string
  value: number
  integer: boolean
  /** The least value that means anything (a period of 1, a multiple above 0). */
  min: number | null
  /** Set the number in `strategy` (a copy, or the draft once a value is taken). */
  apply(strategy: Strategy, value: number): void
}

/** A registry parameter's declared type and bounds, where the catalogue knows them. */
export type ParamInfo = (plugin: string, variant: string, name: string) => { type: 'int' | 'float'; min: number | null; max: number | null } | null

// -- numbers written in a condition ------------------------------------------------------------

/** Names (dotted, with digits: `ema1`, `raw.p2`) and quoted strings are skipped, so only a
 * number standing on its own matches -- the 8 of `child.tf * 8`, not the 5 of `tf('5m')`. */
const TOKENS = /'[^']*'|"[^"]*"|[A-Za-z_][A-Za-z0-9_.]*|(\d+(?:\.\d+)?)/g

/** The numbers standing on their own in an expression, in order, with where each is. */
export function exprNumbers(expr: string): Array<{ value: number; index: number; length: number }> {
  const out: Array<{ value: number; index: number; length: number }> = []
  for (const m of expr.matchAll(TOKENS)) if (m[1] !== undefined) out.push({ value: Number(m[1]), index: m.index ?? 0, length: m[1].length })
  return out
}

/** `expr` with its `k`th number (exprNumbers' order) written as `value`. */
export function setExprNumber(expr: string, k: number, value: number): string {
  const n = exprNumbers(expr)[k]
  if (!n) return expr
  return `${expr.slice(0, n.index)}${formatNumber(value)}${expr.slice(n.index + n.length)}`
}

/** A number as an expression literal: no exponent, no float noise (0.1 + 0.2 is written 0.3). */
export function formatNumber(value: number): string {
  const text = String(Number.parseFloat(value.toPrecision(12)))
  // The expression language has no exponent: 1e-7 is written out.
  return text.includes('e') ? value.toFixed(12).replace(/\.?0+$/, '') : text
}

// -- every sweepable number --------------------------------------------------------------------

export function sweepTargets(strategy: Strategy, paramInfo: ParamInfo = () => null): SweepTarget[] {
  const out: SweepTarget[] = []

  strategy.sources.forEach((source, i) => {
    if (source.kind !== 'published') return
    for (const [name, value] of Object.entries(source.params)) {
      const info = paramInfo(source.plugin, source.variant, name)
      out.push({
        id: `source:${source.id}:param:${name}`,
        section: 'Signals',
        label: `${source.title || source.id} · ${name}`,
        value,
        integer: info?.type === 'int',
        min: info?.min ?? null,
        apply: (s, v) => {
          const target = s.sources[i]
          if (target?.kind === 'published') target.params[name] = v
        }
      })
    }
  })

  /** Every number in a condition list's enabled conditions. */
  const conditions = (section: string, where: string, pick: (s: Strategy) => Array<{ expr: string; enabled: boolean }>): void => {
    pick(strategy).forEach((condition, c) => {
      if (!condition.enabled) return
      exprNumbers(condition.expr).forEach((n, k) => {
        out.push({
          id: `${where}:${c}:${k}`,
          section,
          label: `${section} · ${where} ${c + 1} · ${formatNumber(n.value)} in ${condition.expr}`,
          value: n.value,
          integer: Number.isInteger(n.value),
          min: null,
          apply: (s, v) => {
            const target = pick(s)[c]
            if (target) target.expr = setExprNumber(target.expr, k, v)
          }
        })
      })
    })
  }
  if (strategy.graph.enabled) conditions('Graph', 'step test', (s) => s.graph.step)
  conditions('Entries', 'test', (s) => s.entry.when)
  if (strategy.graph.enabled) {
    exprNumbers(strategy.graph.end.when).forEach((n, k) => {
      out.push({
        id: `end:${k}`,
        section: 'Graph',
        label: `Graph · ends when · ${formatNumber(n.value)} in ${strategy.graph.end.when}`,
        value: n.value,
        integer: Number.isInteger(n.value),
        min: null,
        apply: (s, v) => {
          s.graph.end.when = setExprNumber(s.graph.end.when, k, v)
        }
      })
    })
    if (strategy.graph.end.rootBars !== null) {
      out.push({ id: 'end:rootBars', section: 'Graph', label: 'Graph · ends after (root bars)', value: strategy.graph.end.rootBars, integer: true, min: 1, apply: (s, v) => (s.graph.end.rootBars = v) })
    }
  }

  /** A stop's, target's or trail's numbers. */
  const level = (role: string, label: string, get: (s: Strategy) => Level | null | undefined): void => {
    const l = get(strategy)
    if (!l) return
    const add = (key: string, what: string, value: number, integer: boolean, min: number | null, set: (l: Level, v: number) => void): void => {
      out.push({
        id: `exit:${role}:${key}`,
        section: 'Exits',
        label: `Exits · ${label} · ${what}`,
        value,
        integer,
        min,
        apply: (s, v) => {
          const target = get(s)
          if (target && target.kind === l.kind) set(target, v)
        }
      })
    }
    if (l.kind === 'pips')
      add('pips', 'pips', l.value, false, 0, (t, v) => {
        if (t.kind === 'pips') t.value = v
      })
    if (l.kind === 'atr') {
      add('mult', '× ATR', l.mult, false, 0, (t, v) => {
        if (t.kind === 'atr') t.mult = v
      })
      add('period', 'ATR period', l.period, true, 1, (t, v) => {
        if (t.kind === 'atr') t.period = v
      })
    }
    if (l.kind === 'r')
      add('r', '× the stop (R)', l.mult, false, 0, (t, v) => {
        if (t.kind === 'r') t.mult = v
      })
    if (l.kind === 'expr') {
      for (const [k, n] of exprNumbers(l.expr).entries()) {
        add(`expr:${k}`, `${formatNumber(n.value)} in ${l.expr}`, n.value, Number.isInteger(n.value), null, (t, v) => {
          if (t.kind === 'expr') t.expr = setExprNumber(t.expr, k, v)
        })
      }
    }
  }
  level('stop', 'stop', (s) => s.exits.stop)
  level('target', 'target', (s) => s.exits.target)
  level('trail', 'trailing stop', (s) => s.exits.trail?.distance)
  const x = strategy.exits
  const plain = (id: string, section: string, label: string, value: number, integer: boolean, min: number | null, apply: (s: Strategy, v: number) => void): void => {
    out.push({ id, section, label, value, integer, min, apply })
  }
  if (x.breakevenAtR !== null)
    plain('exit:breakeven', 'Exits', 'Exits · breakeven at R', x.breakevenAtR, false, 0, (s, v) => {
      s.exits.breakevenAtR = v
    })
  if (x.trail)
    plain('exit:trail:activate', 'Exits', 'Exits · trailing stop from R', x.trail.activateR, false, 0, (s, v) => {
      if (s.exits.trail) s.exits.trail.activateR = v
    })
  if (x.maxBars)
    plain('exit:time', 'Exits', 'Exits · time limit (bars)', x.maxBars.count, true, 1, (s, v) => {
      if (s.exits.maxBars) s.exits.maxBars.count = v
    })
  plain('cost:slippage', 'Costs', 'Costs · slippage (pips)', strategy.costs.slippagePips, false, 0, (s, v) => {
    s.costs.slippagePips = v
  })
  plain('cost:commission', 'Costs', 'Costs · commission (per million)', strategy.costs.commission, false, 0, (s, v) => {
    s.costs.commission = v
  })
  return out
}

/** `count` values from `from` to `to`, both included; whole and distinct for an integer, and
 * never under `min`. */
export function sweepValues(from: number, to: number, count: number, integer: boolean, min: number | null): number[] {
  const n = Math.max(1, Math.min(50, Math.round(count)))
  const raw = n === 1 ? [from] : Array.from({ length: n }, (_, i) => from + ((to - from) * i) / (n - 1))
  const clean = raw.map((v) => (integer ? Math.round(v) : Number.parseFloat(v.toPrecision(10)))).filter((v) => Number.isFinite(v) && (min === null || v >= min))
  return [...new Set(clean)]
}

/** A sensible range around a value: half to one and a half times it, seven values. */
export function defaultRange(target: SweepTarget): { from: number; to: number; count: number } {
  const v = target.value
  if (v === 0) return { from: 0, to: target.integer ? 6 : 3, count: 7 }
  const lo = v * 0.5
  const hi = v * 1.5
  const from = target.min !== null ? Math.max(target.min, Math.min(lo, hi)) : Math.min(lo, hi)
  return { from, to: Math.max(lo, hi), count: 7 }
}

// -- running it -------------------------------------------------------------------------------

export interface SweepRow {
  value: number
  all: Figures | null
  fit: Figures | null
  holdout: Figures | null
  /** Why this value did not run. */
  error: string | null
}

/** Run `strategy` with `target` at each value, in order, handing each row on as it lands. */
export async function runSweep(
  strategy: Strategy,
  target: SweepTarget,
  values: readonly number[],
  run: (strategy: Strategy) => Promise<LabRun>,
  onRow: (row: SweepRow, index: number) => void,
  isCancelled: () => boolean
): Promise<SweepRow[]> {
  const rows: SweepRow[] = []
  for (let i = 0; i < values.length; i++) {
    if (isCancelled()) break
    const copy = structuredClone(strategy)
    target.apply(copy, values[i])
    let row: SweepRow
    try {
      const result = await run(copy)
      row = rowOf(values[i], result)
    } catch (err) {
      if (isCancelled()) break
      row = { value: values[i], all: null, fit: null, holdout: null, error: err instanceof Error ? err.message : String(err) }
    }
    rows.push(row)
    onRow(row, i)
  }
  return rows
}

function rowOf(value: number, run: LabRun): SweepRow {
  const split = run.split !== null
  return { value, all: figuresOf(run), fit: split ? figuresOf(run, 'fit') : null, holdout: split ? figuresOf(run, 'holdout') : null, error: null }
}
