import { AREV_GENERATIONS, type ArevGeneration } from '../arev/api'
import type { SettingsField } from '../chartlayers/settings'

// The AREV lab's settings: which AREV generations it draws in its one sub-pane, how each
// looks, and which signal rule each one's arrows follow, with that rule's levers.
//
// Per generation rather than per indicator, because the point of drawing arev19 beside
// arev21 is reading them against each other -- one colour or one rule for all of them would
// defeat it. Like the AREV21 multi-timeframe overlay (client/mtf/config.ts) this is NOT
// klinecharts' calcParams: those are a flat numeric array printed into the legend, and this is
// a record per generation with colours, enums and a dozen numbers.
//
// The signal rules:
//
//   * `fixed`  -- the published AREV rule, `|p - 0.5| >= confidence` on a sample bar with at
//     least `minNeighbours` voting. At the defaults it is exactly the arrows the AREV panes
//     draw.
//   * `rank`   -- p's `q` and `1 - q` quantiles over the last `days` of p; an arrow when p
//     ENTERS the zone beyond one (wdashboard-server services/arev21outlier.py, whose window is
//     a count of samples rather than a span).
//   * `median` -- the median of the last `days` of p, ± `width`; entry.
//   * `prior`  -- ± `width` around the up-rate of the labels resolved in the last `days`, each
//     rebuilt from the bars exactly as the generation labels a sample; entry. The server's
//     arev21_outlier_prior uses the same kind of window over the model's own training span (5
//     years on minute timeframes, 20 on hours, all history on 1D+), which a browser cannot read
//     below 1D -- so the span is shorter here, and nothing else differs.
//
// Every window is a span of DAYS, not a count of bars or samples: that is what the model's own
// window is, it means the same thing on every timeframe, and it tells the chart exactly how much
// history to load instead of estimating how many bars hold N of something.
//
// By default every bar with a usable p is compared and may print an arrow. `samplesOnly` narrows
// that to the bars the model actually predicts on -- a moving-average cross, a fresh extreme,
// the stride -- which is what the published rule and the AREV panes draw; the server notes the
// vote is right ~60% of the time there and inverted between samples.
//
// One table (`LEVERS`) drives the settings panel, the clamping every edit goes through, the
// stored diff and its validation -- so the panel and the document cannot disagree about a
// lever's range.

export type LabRule = 'none' | 'fixed' | 'rank' | 'median' | 'prior'
export const LAB_RULES: readonly LabRule[] = ['none', 'fixed', 'rank', 'median', 'prior']

export interface LabGeneration {
  /** Whether this generation's line is drawn at all. */
  enabled: boolean
  color: string
  lineWidth: number
  /** Which rule places this generation's arrows. */
  signals: LabRule
  /** Draw the rule's lines (its centre and the two thresholds) beside p. */
  lines: boolean
  /** Half-width of an arrow, in pixels. */
  arrowSize: number
  /** A bar counts only with at least this many samples behind its p (every rule). */
  minNeighbours: number
  /** Compare, and print arrows on, only the bars the model predicts on (`atCross`). */
  samplesOnly: boolean
  fixed: { confidence: number }
  rank: { days: number; q: number }
  median: { days: number; width: number }
  prior: { days: number; width: number }
}

export interface LabConfig {
  generations: Record<ArevGeneration, LabGeneration>
}

/** Distinct hues, one per generation, so a line names its generation without a legend read.
 * Arrows take their generation's colour too: direction is already carried by the arrow. */
const PALETTE: Record<ArevGeneration, string> = {
  arev19: '#29B6F6',
  arev20: '#AB47BC',
  arev21: '#FFCA28',
  arev22: '#66BB6A',
  arev23: '#EF5350'
}

function defaultGeneration(generation: ArevGeneration): LabGeneration {
  return {
    // arev21 alone by default: it is the generation the chart's AREV work is built on, and
    // five lines at once is a choice, not a starting point.
    enabled: generation === 'arev21',
    color: PALETTE[generation],
    lineWidth: 1.5,
    signals: 'fixed',
    lines: false,
    arrowSize: 5,
    minNeighbours: 50,
    // Off: every bar with a usable p is compared and may print an arrow (the user's choice,
    // 2026-09-16). On, the lab draws the published arrows and nothing else.
    samplesOnly: false,
    // The research defaults: wdashboard-server services/arev.py SIGNAL_CONFIDENCE and
    // services/arev21outlier.py VARIANTS. The spans are the lab's own -- 90 days is a quarter of
    // p's recent history on any timeframe, and a year of labels is a base rate that still moves.
    fixed: { confidence: 0.075 },
    rank: { days: 90, q: 0.85 },
    median: { days: 90, width: 0.025 },
    prior: { days: 365, width: 0.025 }
  }
}

export const LAB_DEFAULTS: LabConfig = {
  generations: Object.fromEntries(AREV_GENERATIONS.map((g) => [g, defaultGeneration(g)])) as Record<
    ArevGeneration,
    LabGeneration
  >
}

type Lever =
  | { path: string; kind: 'bool'; label: string; when?: LabRule[] }
  | { path: string; kind: 'color'; label: string; when?: LabRule[] }
  | { path: string; kind: 'rule'; label: string; when?: LabRule[] }
  | {
      path: string
      kind: 'number'
      label: string
      min: number
      max: number
      step: number
      integer?: boolean
      when?: LabRule[]
    }

/** Every lever of one generation: its path under `generations.<gen>`, its control, its range,
 * and the rules it belongs to (absent: every rule). */
export const LEVERS: readonly Lever[] = [
  { path: 'color', kind: 'color', label: 'Colour' },
  { path: 'lineWidth', kind: 'number', label: 'Line width', min: 0.5, max: 4, step: 0.5 },
  { path: 'signals', kind: 'rule', label: 'Signals' },
  { path: 'arrowSize', kind: 'number', label: 'Signal size', min: 2, max: 14, step: 0.5, when: ['fixed', 'rank', 'median', 'prior'] },
  { path: 'lines', kind: 'bool', label: 'Rule lines', when: ['fixed', 'rank', 'median', 'prior'] },
  { path: 'minNeighbours', kind: 'number', label: 'Min neighbours', min: 0, max: 1000, step: 10, integer: true, when: ['fixed', 'rank', 'median', 'prior'] },
  { path: 'samplesOnly', kind: 'bool', label: 'Sample bars only', when: ['fixed', 'rank', 'median', 'prior'] },
  { path: 'fixed.confidence', kind: 'number', label: 'Confidence |p − 0.5|', min: 0, max: 0.5, step: 0.005, when: ['fixed'] },
  { path: 'rank.days', kind: 'number', label: 'Window (days)', min: 1, max: 3650, step: 5, integer: true, when: ['rank'] },
  // Up to 1.0, which IS the window's high and low -- the rolling form of the running extrema the
  // AREV wire retired, and the one that cannot freeze as history accumulates.
  { path: 'rank.q', kind: 'number', label: 'Upper quantile q', min: 0.5, max: 1, step: 0.005, when: ['rank'] },
  { path: 'median.days', kind: 'number', label: 'Window (days)', min: 1, max: 3650, step: 5, integer: true, when: ['median'] },
  { path: 'median.width', kind: 'number', label: 'Band ± around median', min: 0, max: 0.5, step: 0.005, when: ['median'] },
  { path: 'prior.days', kind: 'number', label: 'Window (days)', min: 1, max: 3650, step: 5, integer: true, when: ['prior'] },
  { path: 'prior.width', kind: 'number', label: 'Band ± around prior', min: 0, max: 0.5, step: 0.005, when: ['prior'] }
]

const RULE_LABELS: Record<LabRule, string> = {
  none: 'None',
  fixed: 'Fixed level',
  rank: 'Rank (quantiles)',
  median: 'Median band',
  prior: 'Prior band'
}

/** One group per generation: Show, then -- only while shown -- its style, its rule, and the
 * levers of that rule alone (settings.ts `when`). */
export const LAB_FIELDS: SettingsField[] = AREV_GENERATIONS.map(
  (generation): SettingsField => {
    const base = `generations.${generation}`
    const shownWhenEnabled = { key: `${base}.enabled`, is: [true] }
    return {
      kind: 'group',
      label: generation,
      fields: [
        { kind: 'switch', key: `${base}.enabled`, label: 'Show' },
        {
          kind: 'group',
          label: `${generation} settings`,
          when: shownWhenEnabled,
          fields: LEVERS.map((lever): SettingsField => {
            const key = `${base}.${lever.path}`
            const when = lever.when ? { key: `${base}.signals`, is: [...lever.when] } : undefined
            if (lever.kind === 'bool') return { kind: 'switch', key, label: lever.label, when }
            if (lever.kind === 'color') return { kind: 'color', key, label: lever.label, when }
            if (lever.kind === 'rule') {
              return {
                kind: 'select',
                key,
                label: lever.label,
                options: LAB_RULES.map((rule) => ({ value: rule, label: RULE_LABELS[rule] })),
                when
              }
            }
            return { kind: 'number', key, label: lever.label, min: lever.min, max: lever.max, step: lever.step, when }
          })
        }
      ]
    }
  }
)

function read(target: object, path: string): unknown {
  return path.split('.').reduce<unknown>((acc, k) => (acc && typeof acc === 'object' ? (acc as Record<string, unknown>)[k] : undefined), target)
}

function write(target: object, path: string, value: unknown): void {
  const keys = path.split('.')
  let current = target as Record<string, unknown>
  for (const k of keys.slice(0, -1)) current = current[k] as Record<string, unknown>
  current[keys.at(-1) as string] = value
}

/** A lever's value made legal, or undefined when it cannot be. Numbers are clamped (the
 * panel's number input commits every keystroke, unclamped), integers rounded, and anything
 * of the wrong type refused -- these become window sizes and canvas coordinates. */
function coerce(lever: Lever, value: unknown): unknown {
  switch (lever.kind) {
    case 'bool':
      return typeof value === 'boolean' ? value : undefined
    case 'color':
      return typeof value === 'string' && /^#[0-9a-fA-F]{3,8}$/.test(value) ? value : undefined
    case 'rule':
      return typeof value === 'string' && (LAB_RULES as readonly string[]).includes(value) ? value : undefined
    case 'number': {
      if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
      const clamped = Math.min(lever.max, Math.max(lever.min, value))
      return lever.integer ? Math.round(clamped) : clamped
    }
  }
}

/** Every lever made legal; an illegal value falls back to the default. What the plugin
 * applies to each panel edit before it reaches a binding. */
export function normaliseLabConfig(config: LabConfig): LabConfig {
  const out = structuredClone(LAB_DEFAULTS)
  for (const generation of AREV_GENERATIONS) {
    const source = config?.generations?.[generation]
    if (!source) continue
    write(out.generations[generation], 'enabled', typeof source.enabled === 'boolean' ? source.enabled : LAB_DEFAULTS.generations[generation].enabled)
    for (const lever of LEVERS) {
      const value = coerce(lever, read(source, lever.path))
      if (value !== undefined) write(out.generations[generation], lever.path, value)
    }
  }
  return out
}

/** The generations to draw, in their fixed order. Tolerates a missing config: klinecharts
 * draws a template before the first extendData lands. */
export function enabledGenerations(config: LabConfig | undefined): ArevGeneration[] {
  const generations = config?.generations
  if (!generations) return []
  return AREV_GENERATIONS.filter((g) => generations[g]?.enabled === true)
}

/** What the wall document stores: only what differs from LAB_DEFAULTS, by lever path. */
export type StoredLabConfig = Partial<Record<ArevGeneration, Record<string, unknown>>>

const STORED_PATHS: readonly Lever[] = [{ path: 'enabled', kind: 'bool', label: 'Show' }, ...LEVERS]

export function toStoredLabConfig(config: LabConfig): StoredLabConfig | undefined {
  const stored: StoredLabConfig = {}
  for (const generation of AREV_GENERATIONS) {
    const current = config.generations[generation]
    const base = LAB_DEFAULTS.generations[generation]
    if (!current) continue
    const diff: Record<string, unknown> = {}
    for (const lever of STORED_PATHS) {
      const value = read(current, lever.path)
      if (value !== read(base, lever.path)) diff[lever.path] = value
    }
    if (Object.keys(diff).length > 0) stored[generation] = diff
  }
  return Object.keys(stored).length > 0 ? stored : undefined
}

/** A stored diff merged onto the defaults, each value validated; undefined when nothing
 * usable is there. A generation or lever this build does not know is ignored. */
export function fromStoredLabConfig(stored: unknown): LabConfig | undefined {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined
  const config = structuredClone(LAB_DEFAULTS)
  let touched = false
  for (const [generation, diff] of Object.entries(stored as Record<string, unknown>)) {
    if (!(AREV_GENERATIONS as readonly string[]).includes(generation) || !diff || typeof diff !== 'object') continue
    for (const lever of STORED_PATHS) {
      const raw = (diff as Record<string, unknown>)[lever.path]
      if (raw === undefined) continue
      const value = coerce(lever, raw)
      if (value === undefined) continue
      write(config.generations[generation as ArevGeneration], lever.path, value)
      touched = true
    }
  }
  return touched ? config : undefined
}
