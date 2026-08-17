import type { Encoding, LinePattern } from '../chartlayers/encoding'
import type { SettingsField } from '../chartlayers/settings'

// Display order for the three intervals levels are computed on (wdashboard-server
// levels.py: LEVELS_INTERVAL_ALLOWLIST = ["1M", "1W", "1D"]), short-to-long rather than the
// server's long-to-short — this is a UI reading order, not the wire order.
export const LEVELS_INTERVAL_ORDER = ['1D', '1W', '1M']

// Metric names a Levels emphasis encoding can be pointed at (client/levels/layer.ts's
// METRICS implements exactly these). Exported from here, not layer.ts, so config.ts (the
// field schema) and layer.ts (the metric functions) both depend on one list instead of two
// that could drift.
export const LEVELS_METRIC_NAMES = ['invalidations', 'ageDays', 'untouchedDays', 'intervalRank'] as const
export type LevelsMetricName = (typeof LEVELS_METRIC_NAMES)[number]

// wdashboard-server levels.py: LEVELS_MAX_INVALIDATIONS. A level is spent once its
// invalidation count reaches this — the natural top of the invalidations-emphasis domain.
const SERVER_MAX_INVALIDATIONS = 10

export type LevelsColorMode = 'server' | 'direction' | 'interval'

export interface LevelsConfig {
  /** Per-interval visibility. Only enforced server-side (fewer bars over the wire) when the
   * server advertises 'levels.intervals'; otherwise it's a client-side paint filter. */
  intervals: Record<string, boolean>
  /** -> include_invalidated. Off by default: a spent level is still meaningful context, but
   * showing it is an opt-in, not the default view. */
  showSpent: boolean
  base: {
    pattern: LinePattern
    width: number
    opacity: number
    colorMode: LevelsColorMode
    directionColors: { support: string; resistance: string }
    intervalColors: Record<string, string>
  }
  spent: {
    pattern: LinePattern
    /** Multiplies base.opacity when a level is spent. */
    opacityScale: number
  }
  emphasis: {
    invalidations: Encoding
    age: Encoding
  }
}

// Chosen so the default render is visually identical to what shipped before this feature —
// solid, 1px, the server's own advisory color — with only the two emphasis encodings turned
// on, since drawing thickness/brightness from level metadata is the reason this exists.
export const DEFAULT_LEVELS_CONFIG: LevelsConfig = {
  intervals: Object.fromEntries(LEVELS_INTERVAL_ORDER.map((code) => [code, true])),
  showSpent: false,
  base: {
    pattern: 'solid',
    width: 1,
    opacity: 1,
    colorMode: 'server',
    directionColors: { support: '#089981', resistance: '#f23645' },
    intervalColors: { '1D': '#00BCD4', '1W': '#089981', '1M': '#FFEB3B' }
  },
  spent: {
    pattern: 'dashed',
    opacityScale: 0.6
  },
  emphasis: {
    // Each invalidation is a price interaction with the level; more of them means it has
    // been tested more, so it gets thicker. The domain tops out at the server's own spent
    // threshold — a level can never carry more invalidations than that and still be active.
    invalidations: {
      enabled: true,
      metric: 'invalidations',
      channel: 'width',
      domain: [0, SERVER_MAX_INVALIDATIONS],
      range: [1, 3],
      invert: false
    },
    // Levels reach back to 2000 (wdashboard-server levels.py: LEVELS_HISTORY_START), so
    // without decay a level confirmed in 2003 competes visually with one confirmed last
    // week. `invert` flips this to "an old level that still holds is the important one."
    age: {
      enabled: true,
      metric: 'ageDays',
      channel: 'opacity',
      domain: [0, 730],
      range: [1, 0.45],
      invert: false
    }
  }
}

const METRIC_LABELS: Record<LevelsMetricName, string> = {
  invalidations: 'Invalidation count',
  ageDays: 'Age (days since confirmed)',
  untouchedDays: 'Days since last touch',
  intervalRank: 'Interval (1D < 1W < 1M)'
}

const METRIC_OPTIONS = LEVELS_METRIC_NAMES.map((name) => ({ value: name, label: METRIC_LABELS[name] }))

const CHANNEL_OPTIONS = [
  { value: 'width', label: 'Line width' },
  { value: 'opacity', label: 'Opacity' },
  { value: 'both', label: 'Width and opacity' }
]

const PATTERN_OPTIONS: { value: LinePattern; label: string }[] = [
  { value: 'solid', label: 'Solid' },
  { value: 'dashed', label: 'Dashed' },
  { value: 'dotted', label: 'Dotted' },
  { value: 'dashDot', label: 'Dash-dot' }
]

function encodingFields(key: 'invalidations' | 'age', label: string): SettingsField {
  const base = `emphasis.${key}`
  return {
    kind: 'group',
    label: `Emphasize by ${label.toLowerCase()}`,
    fields: [
      { kind: 'switch', key: `${base}.enabled`, label: 'Enabled' },
      { kind: 'select', key: `${base}.metric`, label: 'Driven by', options: METRIC_OPTIONS },
      { kind: 'select', key: `${base}.channel`, label: 'Affects', options: CHANNEL_OPTIONS },
      { kind: 'number', key: `${base}.domain.0`, label: 'Metric min', min: 0, max: 10_000, step: 1 },
      { kind: 'number', key: `${base}.domain.1`, label: 'Metric max', min: 0, max: 10_000, step: 1 },
      { kind: 'number', key: `${base}.range.0`, label: 'Output at min', min: 0, max: 20, step: 0.05 },
      { kind: 'number', key: `${base}.range.1`, label: 'Output at max', min: 0, max: 20, step: 0.05 },
      { kind: 'switch', key: `${base}.invert`, label: 'Invert' }
    ]
  }
}

export const LEVELS_FIELDS: SettingsField[] = [
  {
    kind: 'group',
    label: 'Timeframes',
    fields: LEVELS_INTERVAL_ORDER.map((code) => ({
      kind: 'switch',
      key: `intervals.${code}`,
      label: code
    }))
  },
  { kind: 'switch', key: 'showSpent', label: 'Show spent levels' },
  {
    kind: 'group',
    label: 'Line',
    fields: [
      { kind: 'select', key: 'base.pattern', label: 'Type', options: PATTERN_OPTIONS },
      { kind: 'number', key: 'base.width', label: 'Width', min: 0.5, max: 8, step: 0.5 },
      { kind: 'number', key: 'base.opacity', label: 'Opacity', min: 0.1, max: 1, step: 0.05 },
      {
        kind: 'select',
        key: 'base.colorMode',
        label: 'Color',
        options: [
          { value: 'server', label: "Server's advisory color" },
          { value: 'direction', label: 'By support / resistance' },
          { value: 'interval', label: 'By timeframe' }
        ]
      },
      { kind: 'color', key: 'base.directionColors.support', label: 'Support color' },
      { kind: 'color', key: 'base.directionColors.resistance', label: 'Resistance color' },
      ...LEVELS_INTERVAL_ORDER.map(
        (code): SettingsField => ({
          kind: 'color',
          key: `base.intervalColors.${code}`,
          label: `${code} color`
        })
      )
    ]
  },
  {
    kind: 'group',
    label: 'Spent levels',
    fields: [
      { kind: 'select', key: 'spent.pattern', label: 'Type', options: PATTERN_OPTIONS },
      { kind: 'number', key: 'spent.opacityScale', label: 'Opacity scale', min: 0, max: 1, step: 0.05 }
    ]
  },
  encodingFields('invalidations', 'invalidations'),
  encodingFields('age', 'age')
]
