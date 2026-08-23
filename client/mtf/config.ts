import type { SettingsField } from '../chartlayers/settings'
import { loadLayerConfig } from '../chartlayers/store'
import { MTF_INTERVALS, type MtfInterval } from './api'

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
// WHERE these are stored is client/mtf/prefs.ts's business, not this module's: one config
// per pane, inside the active workspace, beside the server indicators' own per-pane
// parameters. This module owns only the shape, the defaults and the field schema.

export const MTF_CONFIG_ID = 'mtf-arev21'

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

export interface MtfConfig {
  timeframes: Record<MtfInterval, MtfTimeframeStyle>
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
  '30m': '#26A69A',
  '1h': '#9CCC65',
  '4h': '#FFCA28',
  '8h': '#FF7043',
  '1D': '#EF5350'
}

// Sizes grow with the timeframe for the same reason the palette warms: a 1D signal is
// rarer and worth more room. Only 1h and up are on by default — the sub-hour series exist
// and can be ticked, but eight timeframes at once is not a chart anyone can read, and the
// hourly-and-up set is what the research is actually calibrated on.
function defaultStyle(interval: MtfInterval, index: number): MtfTimeframeStyle {
  return {
    enabled: index >= MTF_INTERVALS.indexOf('1h'),
    color: PALETTE[interval],
    arrowSize: 4 + index * 0.5,
    textSize: 9 + (index >= MTF_INTERVALS.indexOf('4h') ? 1 : 0)
  }
}

export const MTF_DEFAULTS: MtfConfig = {
  timeframes: Object.fromEntries(
    MTF_INTERVALS.map((interval, index) => [interval, defaultStyle(interval, index)])
  ) as Record<MtfInterval, MtfTimeframeStyle>
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

/** The single global config this overlay kept before its settings became per-pane.
 *
 * Read-only now, and read exactly once: client/mtf/prefs.ts uses it to seed a pane that has
 * no settings of its own, so a user who had already picked their timeframes and colours
 * keeps them. Nothing writes this key any more, so it stays as whatever it was and quietly
 * stops mattering once every pane has been configured; where it was never written,
 * loadLayerConfig answers MTF_DEFAULTS, which is the same seed. */
export function loadLegacyGlobalMtfConfig(): Promise<MtfConfig> {
  return loadLayerConfig(MTF_CONFIG_ID, MTF_DEFAULTS)
}
