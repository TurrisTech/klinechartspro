import type { Encoding } from '../chartlayers/encoding'
import type { SettingsField } from '../chartlayers/settings'

// Display order for the intervals zones are computed on (wdashboard-server levels2.py:
// LEVELS2_INTERVAL_ALLOWLIST), short-to-long -- a UI reading order, not the wire order.
export const LEVELS2_INTERVAL_ORDER = ['1h', '4h', '1D', '1W']

// Metric names an emphasis encoding can be pointed at; client/levels2/layer.ts's METRICS
// implements exactly these.
export const LEVELS2_METRIC_NAMES = ['score', 'touches', 'breaks', 'ageDays', 'untouchedDays', 'members'] as const
export type Levels2MetricName = (typeof LEVELS2_METRIC_NAMES)[number]

export type Levels2ColorMode = 'server' | 'role' | 'direction' | 'interval'

export interface Levels2Config {
  /** Per-interval visibility; also narrows the request (`intervals=`). */
  intervals: Record<string, boolean>
  /** -> include_retired. A retired zone still marks where price turned twice, but showing
   * the whole history of them is an opt-in. */
  showRetired: boolean
  base: {
    /** Fill opacity of a live zone's band. */
    fillOpacity: number
    borderWidth: number
    borderOpacity: number
    colorMode: Levels2ColorMode
    roleColors: { support: string; resistance: string }
    intervalColors: Record<string, string>
  }
  retired: {
    /** Multiplies base.fillOpacity and base.borderOpacity when a zone is retired. */
    opacityScale: number
  }
  emphasis: {
    score: Encoding
    touches: Encoding
  }
}

// Coloured by the side a zone currently acts on (a broken resistance is support), filled
// faintly so candles stay readable through it, with the two encodings on: the score drives
// the fill (a zone price has respected recently reads stronger) and the touch count the
// border (a zone tested often reads heavier). 1h/1D on — the two the store holds documents
// for everywhere today; 4h/1W stay toggles.
export const DEFAULT_LEVELS2_CONFIG: Levels2Config = {
  intervals: Object.fromEntries(LEVELS2_INTERVAL_ORDER.map((code) => [code, code === '1h' || code === '1D'])),
  showRetired: false,
  base: {
    fillOpacity: 0.18,
    borderWidth: 1,
    borderOpacity: 0.7,
    colorMode: 'role',
    roleColors: { support: '#089981', resistance: '#f23645' },
    intervalColors: { '1h': '#089981', '4h': '#AB47BC', '1D': '#00BCD4', '1W': '#FFEB3B' }
  },
  retired: {
    opacityScale: 0.4
  },
  emphasis: {
    // Score = decayed touches minus breaks; ~0 for a fresh or worn zone, a few for one that
    // has held repeatedly and recently. Encoded on opacity, scaled onto the fill.
    score: {
      enabled: true,
      metric: 'score',
      channel: 'opacity',
      domain: [0, 4],
      range: [0.6, 1.4],
      invert: false
    },
    touches: {
      enabled: true,
      metric: 'touches',
      channel: 'width',
      domain: [0, 8],
      range: [1, 2.5],
      invert: false
    }
  }
}

const METRIC_LABELS: Record<Levels2MetricName, string> = {
  score: 'Score (decayed touches − breaks)',
  touches: 'Touch count',
  breaks: 'Break count',
  ageDays: 'Age (days since confirmed)',
  untouchedDays: 'Days since last touch',
  members: 'Merged pivots'
}

const METRIC_OPTIONS = LEVELS2_METRIC_NAMES.map((name) => ({ value: name, label: METRIC_LABELS[name] }))

const CHANNEL_OPTIONS = [
  { value: 'width', label: 'Border width' },
  { value: 'opacity', label: 'Fill opacity' },
  { value: 'both', label: 'Both' }
]

function encodingFields(key: 'score' | 'touches', label: string): SettingsField {
  const base = `emphasis.${key}`
  return {
    kind: 'group',
    label: `Emphasize by ${label}`,
    fields: [
      { kind: 'switch', key: `${base}.enabled`, label: 'Enabled' },
      { kind: 'select', key: `${base}.metric`, label: 'Driven by', options: METRIC_OPTIONS },
      { kind: 'select', key: `${base}.channel`, label: 'Affects', options: CHANNEL_OPTIONS },
      { kind: 'number', key: `${base}.domain.0`, label: 'Metric min', min: -100, max: 10_000, step: 1 },
      { kind: 'number', key: `${base}.domain.1`, label: 'Metric max', min: -100, max: 10_000, step: 1 },
      { kind: 'number', key: `${base}.range.0`, label: 'Output at min', min: 0, max: 20, step: 0.05 },
      { kind: 'number', key: `${base}.range.1`, label: 'Output at max', min: 0, max: 20, step: 0.05 },
      { kind: 'switch', key: `${base}.invert`, label: 'Invert' }
    ]
  }
}

export const LEVELS2_FIELDS: SettingsField[] = [
  {
    kind: 'group',
    label: 'Timeframes',
    fields: LEVELS2_INTERVAL_ORDER.map((code) => ({ kind: 'switch', key: `intervals.${code}`, label: code }))
  },
  { kind: 'switch', key: 'showRetired', label: 'Show retired zones' },
  {
    kind: 'group',
    label: 'Band',
    fields: [
      { kind: 'number', key: 'base.fillOpacity', label: 'Fill opacity', min: 0, max: 1, step: 0.02 },
      { kind: 'number', key: 'base.borderWidth', label: 'Border width', min: 0, max: 6, step: 0.5 },
      { kind: 'number', key: 'base.borderOpacity', label: 'Border opacity', min: 0, max: 1, step: 0.05 },
      {
        kind: 'select',
        key: 'base.colorMode',
        label: 'Color',
        options: [
          { value: 'role', label: 'By current role (support / resistance)' },
          { value: 'direction', label: 'By birth side' },
          { value: 'interval', label: 'By timeframe' },
          { value: 'server', label: "Server's advisory color" }
        ]
      },
      { kind: 'color', key: 'base.roleColors.support', label: 'Support color' },
      { kind: 'color', key: 'base.roleColors.resistance', label: 'Resistance color' },
      ...LEVELS2_INTERVAL_ORDER.map(
        (code): SettingsField => ({ kind: 'color', key: `base.intervalColors.${code}`, label: `${code} color` })
      )
    ]
  },
  {
    kind: 'group',
    label: 'Retired zones',
    fields: [{ kind: 'number', key: 'retired.opacityScale', label: 'Opacity scale', min: 0, max: 1, step: 0.05 }]
  },
  encodingFields('score', 'score'),
  encodingFields('touches', 'touches')
]
