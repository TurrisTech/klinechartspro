import type { SettingsField } from '../chartlayers/settings'
import { MTF_INTERVALS, isMtfInterval, type MtfInterval } from './api'

// The one AREV21 multi-timeframe overlay's settings: which timeframes it draws, and how
// each one looks. Per timeframe rather than per indicator, because the whole point of the
// overlay is telling two timeframes apart at a glance — one colour and one size for all of
// them would defeat it.
//
// This is NOT klinecharts' `calcParams`. That array is numeric, it is what the built-in
// settings dialog edits, and klinecharts prints it into the legend (`MA(5,10,30,60)`), so
// eight timeframes x four fields would render as a legend nobody could read and a dialog of
// thirty-two anonymous number boxes. The config lives here instead, is edited by the
// panel client/chartlayers/settings.ts already draws (it has `switch`, `color`, `number`
// and `group` — the exact vocabulary this needs, and the same one the Levels layer uses for
// its per-timeframe colours), and reaches `calc`/`draw` through the indicator's extendData.
//
// WHERE these are stored is client/layout.ts's business: one config per pane, in that pane's
// own entry of the wall document, beside its indicator parameters and its view state. This
// module owns only the shape, the defaults, the field schema and the validator a stored
// document is read back through.

export interface MtfTimeframeStyle {
  /** Whether this timeframe is drawn at all. */
  enabled: boolean
  /** The marker's colour. Overrides the up/down convention — see the note in DEFAULTS. */
  color: string
  /** Half-width of the arrow, in pixels. The arrow is `1.4x` this deep. */
  arrowSize: number
  /** Point size of the `4h 0.41` label, in pixels. 0 hides the label entirely. */
  textSize: number
}

/** The timeframes a signal graph may start from (user, 2026-09-21). */
export const GRAPH_ROOTS = ['1D', '8h', '4h', '2h', '1h'] as const satisfies readonly MtfInterval[]
export type GraphRoot = (typeof GRAPH_ROOTS)[number]

export function isGraphRoot(code: unknown): code is GraphRoot {
  return (GRAPH_ROOTS as readonly unknown[]).includes(code)
}

/** The signal graph drawn over the markers (graph.ts), on an overlay that offers one. */
export interface MtfGraphConfig {
  /** The timeframe every graph starts from, or `'off'`. */
  from: GraphRoot | 'off'
  /** The most one step may shrink the timeframe by: 8 lets 8h reach 1h but not 30m. */
  maxStep: number
  /** The graph's line width, in pixels. */
  lineWidth: number
}

export interface MtfConfig {
  timeframes: Record<MtfInterval, MtfTimeframeStyle>
  /** Read through `graphConfig`: a config built before the field existed has none. */
  graph: MtfGraphConfig
}

// Distinct hues rather than the red/green up/down convention the AREV panes and the retired
// KREV markers use. On a single-timeframe overlay direction is the only thing colour could
// carry, so red/green was right there; here the reader's first question is WHICH TIMEFRAME
// said this, and direction is already unambiguous from the arrow pointing up or down and
// from which side of the candle it sits on. Colour is the only channel left that can name
// eight things at once.
//
// Ordered coolest-to-warmest along the timeframe list, so the visual weight rises with the
// timeframe: a 1D marker reads as more significant than a 3m one before anything is read.
const PALETTE: Record<MtfInterval, string> = {
  '3m': '#7E57C2',
  '5m': '#5C6BC0',
  '15m': '#42A5F5',
  '20m': '#26C6DA',
  '30m': '#26A69A',
  '1h': '#9CCC65',
  '2h': '#D4E157',
  '4h': '#FFCA28',
  '8h': '#FF7043',
  '1D': '#EF5350'
}

// Sizes grow with the timeframe for the same reason the palette warms: a 1D signal is
// rarer and worth more room. Only 1h and up are on by default — the sub-hour series exist
// and can be ticked, but eight timeframes at once is not a chart anyone can read, and the
// hourly-and-up set is what the research is actually calibrated on.
// The sizes are a step per timeframe along the ORIGINAL eight. 20m and 2h came later and sit
// half a step between their neighbours rather than renumbering the rest: a stored wall keeps
// only its diff from these defaults (toStoredMtfConfig), so shifting one existing default
// would silently restyle every saved pane that relies on it.
const SIZE_STEP: Record<MtfInterval, number> = {
  '3m': 0,
  '5m': 1,
  '15m': 2,
  '20m': 2.5,
  '30m': 3,
  '1h': 4,
  '2h': 4.5,
  '4h': 5,
  '8h': 6,
  '1D': 7
}

function defaultStyle(interval: MtfInterval): MtfTimeframeStyle {
  const step = SIZE_STEP[interval]
  return {
    enabled: step >= SIZE_STEP['1h'],
    color: PALETTE[interval],
    arrowSize: 4 + step * 0.5,
    textSize: 9 + (step >= SIZE_STEP['4h'] ? 1 : 0)
  }
}

export const MTF_DEFAULTS: MtfConfig = {
  timeframes: Object.fromEntries(
    MTF_INTERVALS.map((interval) => [interval, defaultStyle(interval)])
  ) as Record<MtfInterval, MtfTimeframeStyle>,
  // On from the highest timeframe, which is where the user's list starts. Only an overlay
  // that offers a graph (overlays.ts `graph`) reads this at all; the others carry it inertly.
  graph: { from: '1D', maxStep: 8, lineWidth: 1.5 }
}

/** The graph settings, or the defaults for a config that has none. */
export function graphConfig(config: MtfConfig | undefined): MtfGraphConfig {
  return config?.graph ?? MTF_DEFAULTS.graph
}

// One collapsible group per timeframe, each holding the four fields for it. Grouping by
// timeframe rather than by field ("all the colours", "all the sizes") because a user
// arrives wanting to change ONE timeframe and should find its settings together.
export const MTF_FIELDS: SettingsField[] = MTF_INTERVALS.map(
  (interval): SettingsField => ({
    kind: 'group',
    label: interval,
    fields: [
      { kind: 'switch', key: `timeframes.${interval}.enabled`, label: 'Show' },
      { kind: 'color', key: `timeframes.${interval}.color`, label: 'Colour' },
      { kind: 'number', key: `timeframes.${interval}.arrowSize`, label: 'Signal size', min: 2, max: 14, step: 0.5 },
      // 0 is a real setting, not a floor to clamp away: on a busy wall the arrows alone
      // read fine and the probabilities are what crowd the pane.
      { kind: 'number', key: `timeframes.${interval}.textSize`, label: 'Text size (0 hides)', min: 0, max: 20, step: 1 }
    ]
  })
)

/** The graph's settings, as one group ahead of the timeframes on an overlay that offers one.
 * The graph is drawn in each step's timeframe colour, so it has no colour of its own. */
export const MTF_GRAPH_FIELDS: SettingsField[] = [
  {
    kind: 'group',
    label: 'Graph',
    fields: [
      {
        kind: 'select',
        key: 'graph.from',
        label: 'Start from',
        options: [{ value: 'off', label: 'Off' }, ...GRAPH_ROOTS.map((root) => ({ value: root, label: root }))]
      },
      { kind: 'number', key: 'graph.maxStep', label: 'Largest step (×)', min: 2, max: 480, step: 1 },
      { kind: 'number', key: 'graph.lineWidth', label: 'Line width', min: 0.5, max: 6, step: 0.5 }
    ]
  }
]

/** The timeframes to draw, shortest-first — which is also the lane order, so the markers
 * nearest the candles come from the timeframe nearest the chart's own.
 *
 * Tolerates a config missing entries rather than indexing straight into it. klinecharts
 * calls an indicator's `draw` as soon as it is created, which is BEFORE the controller's
 * next poll has applied any extendData, so the very first frames run against whatever the
 * template declared as its placeholder — and a config that has not loaded yet is a normal
 * state here, not a broken one. Reading `.enabled` off an absent entry threw a TypeError
 * every frame of that window. */
export function enabledIntervals(config: MtfConfig | undefined): MtfInterval[] {
  const timeframes = config?.timeframes
  if (!timeframes) return []
  return MTF_INTERVALS.filter((interval) => timeframes[interval]?.enabled === true)
}

/** What actually goes in the wall document: only the fields that differ from MTF_DEFAULTS.
 *
 * A full config is ~620 bytes, and the whole workspace SET shares one 64 KiB document — up
 * to twelve walls of up to twelve panes, where client/layout.ts budgets a following-the-
 * market pane at thirty bytes. Storing the whole object per pane would be the largest thing
 * in that document by an order of magnitude, for a user who typically changes one colour.
 * A diff makes the common case a few dozen bytes and costs one merge on the way back in. */
export type StoredMtfConfig = Partial<Record<MtfInterval, Partial<MtfTimeframeStyle>>> & {
  graph?: Partial<MtfGraphConfig>
}

const STYLE_KEYS = ['enabled', 'color', 'arrowSize', 'textSize'] as const

function validStyleValue(key: (typeof STYLE_KEYS)[number], value: unknown): boolean {
  if (key === 'enabled') return typeof value === 'boolean'
  if (key === 'color') return typeof value === 'string'
  return typeof value === 'number' && Number.isFinite(value)
}

const GRAPH_KEYS = ['from', 'maxStep', 'lineWidth'] as const

function validGraphValue(key: (typeof GRAPH_KEYS)[number], value: unknown): boolean {
  if (key === 'from') return value === 'off' || isGraphRoot(value)
  if (typeof value !== 'number' || !Number.isFinite(value)) return false
  // A step under 2 admits no timeframe pair at all, and a width of 0 or less draws nothing
  // while the legend says the graph is on.
  return key === 'maxStep' ? value >= 2 : value > 0
}

/** The diff to store, or undefined when this pane is on the defaults and has nothing to say. */
export function toStoredMtfConfig(config: MtfConfig): StoredMtfConfig | undefined {
  const stored: StoredMtfConfig = {}
  for (const interval of MTF_INTERVALS) {
    const style = config.timeframes[interval]
    const base = MTF_DEFAULTS.timeframes[interval]
    if (!style) continue
    const diff: Partial<MtfTimeframeStyle> = {}
    for (const key of STYLE_KEYS) {
      if (style[key] !== base[key]) (diff as unknown as Record<string, unknown>)[key] = style[key]
    }
    if (Object.keys(diff).length > 0) stored[interval] = diff
  }
  const graph = graphConfig(config)
  const graphDiff: Partial<MtfGraphConfig> = {}
  for (const key of GRAPH_KEYS) {
    if (graph[key] !== MTF_DEFAULTS.graph[key]) (graphDiff as Record<string, unknown>)[key] = graph[key]
  }
  if (Object.keys(graphDiff).length > 0) stored.graph = graphDiff
  return Object.keys(stored).length > 0 ? stored : undefined
}

/** A stored diff merged back onto the defaults, or undefined when there is nothing usable.
 *
 * Every field is type-checked on the way in and a bad one falls back to its default rather
 * than reaching the drawing code: these become canvas coordinates, where a non-finite size
 * is a silently invisible marker and a missing `enabled` drops a timeframe the user turned
 * on. A document from a future version naming a timeframe this build does not know is
 * ignored, which is what lets the field be added to without a version bump. */
export function fromStoredMtfConfig(stored: unknown): MtfConfig | undefined {
  if (!stored || typeof stored !== 'object' || Array.isArray(stored)) return undefined
  const config = structuredClone(MTF_DEFAULTS)
  let touched = false
  // `graph` is not a timeframe, so a build from before it existed skips it as it skips any
  // timeframe it does not know, and reads the rest of the document unchanged.
  const { graph, ...timeframes } = stored as Record<string, unknown>
  if (graph && typeof graph === 'object' && !Array.isArray(graph)) {
    for (const key of GRAPH_KEYS) {
      const value = (graph as Record<string, unknown>)[key]
      if (value === undefined || !validGraphValue(key, value)) continue
      ;(config.graph as unknown as Record<string, unknown>)[key] = value
      touched = true
    }
  }
  for (const [interval, diff] of Object.entries(timeframes)) {
    if (!isMtfInterval(interval) || !diff || typeof diff !== 'object') continue
    const target = config.timeframes[interval]
    for (const key of STYLE_KEYS) {
      const value = (diff as Record<string, unknown>)[key]
      if (value === undefined || !validStyleValue(key, value)) continue
      ;(target as unknown as Record<string, unknown>)[key] = value
      touched = true
    }
  }
  return touched ? config : undefined
}
