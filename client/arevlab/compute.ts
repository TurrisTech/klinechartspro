import type { ArevGeneration } from '../arev/api'
import { enabledGenerations, type LabConfig, type LabGeneration } from './config'
import { buildLabels, priorCentre, type LabBar } from './labels'
import {
  bandLines,
  countingBars,
  entrySides,
  fixedLines,
  fixedSides,
  medianLines,
  rankLines,
  type LabPoint,
  type RuleLines
} from './rules'

// Everything the AREV lab draws, as one pure pass from its inputs -- the generations' points
// and, for the prior, the bars -- to a value per chart bar. Kept out of templates.ts so the
// tests exercise exactly what the pane draws without a chart.

/** A rule's window in milliseconds, or 0 for a rule that has none. */
export function spanMs(settings: LabGeneration): number {
  const days =
    settings.signals === 'rank'
      ? settings.rank.days
      : settings.signals === 'median'
        ? settings.median.days
        : settings.signals === 'prior'
          ? settings.prior.days
          : 0
  return days * 86_400_000
}

/** One arrow: which generation placed it and which way it points. */
export interface LabMark {
  generation: ArevGeneration
  side: 1 | -1
  p: number
}

export type LabValue = Record<string, number | undefined> & {
  /** The bar's arrows. Deliberately not a figure: only figure keys widen the pane's axis. */
  __marks?: LabMark[]
}

/** Figure keys per generation. `_` is not a legal character in a generation name, so these
 * cannot collide. */
export function figureKeys(generation: ArevGeneration): { p: string; hi: string; lo: string; centre: string } {
  return { p: `${generation}_p`, hi: `${generation}_hi`, lo: `${generation}_lo`, centre: `${generation}_c` }
}

export interface GenerationResult {
  points: LabPoint[]
  lines: RuleLines | null
  sides: Int8Array
}

/** Points in date order. A store's values are a Map in arrival order, and a pan backwards
 * arrives after the window it widens. */
export function sortedPoints(values: Iterable<LabPoint>): LabPoint[] {
  return [...values].sort((a, b) => a.date - b.date)
}

export function computeGeneration(
  generation: ArevGeneration,
  settings: LabGeneration,
  points: readonly LabPoint[],
  bars: readonly LabBar[]
): GenerationResult {
  const counts = countingBars(points, settings.minNeighbours, settings.samplesOnly)
  const span = spanMs(settings)
  switch (settings.signals) {
    case 'none':
      return { points: [...points], lines: null, sides: new Int8Array(points.length) }
    case 'fixed':
      return {
        points: [...points],
        lines: fixedLines(points.length, settings.fixed.confidence),
        sides: fixedSides(points, counts, settings.fixed.confidence)
      }
    case 'rank': {
      const lines = rankLines(points, counts, span, settings.rank.q)
      return { points: [...points], lines, sides: entrySides(points, counts, lines) }
    }
    case 'median': {
      const lines = medianLines(points, counts, span, settings.median.width)
      return { points: [...points], lines, sides: entrySides(points, counts, lines) }
    }
    case 'prior': {
      // Labels are the TRAINING side and always come from sample bars, whatever is being
      // compared: a label is what the model was asked to predict at a sample.
      const labels = buildLabels(generation, points, bars)
      const centre = priorCentre(
        points.map((pt) => pt.date),
        labels,
        span
      )
      const lines = bandLines(centre, settings.prior.width)
      return { points: [...points], lines, sides: entrySides(points, counts, lines) }
    }
  }
}

const finite = (v: number): number | undefined => (Number.isFinite(v) ? v : undefined)

/** Per chart bar, every enabled generation's p, its rule lines where asked for, and its
 * arrows. A bar with no point for a generation is blank for it -- never carried forward. */
export function labValues(
  timestamps: readonly number[],
  config: LabConfig,
  results: Partial<Record<ArevGeneration, GenerationResult>>
): LabValue[] {
  const out: LabValue[] = timestamps.map(() => ({}))
  const slot = new Map<number, number>()
  for (let i = 0; i < timestamps.length; i++) slot.set(timestamps[i], i)
  for (const generation of enabledGenerations(config)) {
    const result = results[generation]
    if (!result) continue
    const settings = config.generations[generation]
    const keys = figureKeys(generation)
    const drawLines = settings.lines && result.lines !== null
    result.points.forEach((pt, j) => {
      const i = slot.get(pt.date)
      if (i === undefined) return
      const value = out[i]
      value[keys.p] = finite(pt.p)
      if (drawLines && result.lines) {
        value[keys.hi] = finite(result.lines.hi[j])
        value[keys.lo] = finite(result.lines.lo[j])
        value[keys.centre] = finite(result.lines.centre[j])
      }
      const side = result.sides[j]
      if (side !== 0) {
        const marks = value.__marks ?? []
        marks.push({ generation, side: side as 1 | -1, p: pt.p })
        value.__marks = marks
      }
    })
  }
  return out
}
