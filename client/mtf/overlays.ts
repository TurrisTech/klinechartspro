import type { Feature } from '../capabilities'
import { MTF_GENERATION } from './api'

// WHICH signals a multi-timeframe overlay draws. Everything else -- reading them, placing each at
// the instant it became knowable, the graph between them, the per-timeframe lanes and styles,
// the per-pane settings -- is the same whichever family it is, so that machinery takes one of
// these and the overlays differ only here.
//
// A family is named as the server publishes it (`plugin:variant`, the producer of the signal
// labels) and read through `GET /mtf/graph`, which builds every overlay's markers and graph from
// the producer's own published labels (wdashboard-server services/mtfgraph.py).

export interface MtfOverlay {
  /** Plugin id, and the key its per-pane settings are filed under (`host.paneState`). */
  id: string
  /** The klinecharts template name -- a saved-layout compatibility surface: a wall stores it
   * in the pane's indicator list, so renaming one drops it from every saved wall. */
  templateName: string
  /** Legend, settings-panel title and picker label. */
  title: string
  /** The picker group heading. */
  groupLabel: string
  /** The picker entry's description. */
  description: string
  /** The server capability its signal family needs, beside `mtf_graph` itself. */
  feature: Feature
  /** The registry entry whose live wire says a source timeframe has a new bar -- the entry
   * itself where its own plugin pushes, else the first dependency that does (`liveWire`).
   * Either way a pushed point is only a cue to re-read that timeframe's tail (plugin.ts). */
  liveEntry: string
  /** Where a mark sits relative to its bar. `'direction'` (the default) puts a long below the
   * low and a short above the high, the arrow pointing into the candle. `'zone'` puts it on
   * the side of the zone `p` entered: a top-zone (long) signal above the high and a
   * bottom-zone (short) one below the low. The arrow keeps pointing the signal's way either
   * way, so a long is still an up arrow -- only its position moves. */
  placement?: 'direction' | 'zone'
  /** Whether it offers the signal graph (built by the server): lines from a higher timeframe's
   * signal down to lower timeframes' signals that went further the same way. Only on a `'zone'`
   * overlay, whose top signals sit over the price and bottom ones under it -- which is what
   * lets a graph of top signals climb over the candles and one of bottom signals fall under
   * them, rather than cross through. */
  graph?: boolean
  /** The signal family, as the server publishes it: `plugin:variant`. */
  source: string
  /** The family's params, in its registry row's declared order: they are part of what the
   * server is asked and therefore of the store's identity. */
  params?: Record<string, number>
}

/** arev21's published signal: `|p - 0.5| >= 0.075` on a sample bar. The original overlay; its
 * id, template name and store key are what they always were, so saved walls keep it. */
export const AREV21_MTF: MtfOverlay = {
  id: 'mtf',
  templateName: `MTF:${MTF_GENERATION}`,
  title: 'AREV21 MTF',
  groupLabel: 'AREV21 multi-timeframe · price pane',
  description:
    'arev21 signals from several timeframes at once, each drawn one bar of its own timeframe forward. Timeframes, colours and sizes are on the gear.',
  // arev21's published label, which the server reads from the AREV plugin.
  feature: 'arev',
  liveEntry: MTF_GENERATION,
  source: `arev:${MTF_GENERATION}`
}

/** The server's arev21_outlier plugin and its rank variant (wdashboard-server
 * services/arev21outlier.py): the lines are the `q` / `1 - q` percentiles of arev21's `p` over
 * its last `bars` readings, and an arrow fires when `p` ENTERS the zone beyond one. */
const OUTLIER_PLUGIN = 'arev21_outlier'
const OUTLIER_RANK = 'arev21_outlier_rank'

/**
 * The rank rule at a fixed upper percentile, as an overlay.
 *
 * The params are sent in full and in the registry row's declared order (`bars`, `q`,
 * `samples_only` -- wtradingindicators tsregistry `_OUTLIER_PARAMS`), with the row's defaults
 * for the two this overlay does not vary, so the answer does not move if the server's defaults
 * ever do.
 */
export function outlierRankMtf(
  percent: number,
  placement: MtfOverlay['placement'] = 'direction',
  graph = false
): MtfOverlay {
  const params = { bars: 200, q: percent / 100, samples_only: 0 }
  const name = `arev21_outlier_rank_${percent}`
  return {
    id: `mtf_${name}`,
    templateName: `MTF:${name}`,
    title: `AREV21 OUTLIER RANK ${percent} MTF`,
    groupLabel: `AREV21 outlier rank ${percent} multi-timeframe · price pane`,
    description: `arev21's p entering the top or bottom ${100 - percent}% of its last 200 bars, from several timeframes at once, each drawn one bar of its own timeframe forward. Timeframes, colours and sizes are on the gear.`,
    feature: 'arev21_outlier',
    // Computed per read from arev21's rows, so it learns of a new bar from arev21's wire.
    liveEntry: OUTLIER_RANK,
    placement,
    graph,
    source: `${OUTLIER_PLUGIN}:${OUTLIER_RANK}`,
    params
  }
}

export const AREV21_OUTLIER_RANK_90_MTF = outlierRankMtf(90)
/** Top-zone signals over the price, bottom-zone ones under it (user, 2026-09-19), and the
 * signal graph between them (user, 2026-09-21). */
export const AREV21_OUTLIER_RANK_85_MTF = outlierRankMtf(85, 'zone', true)

/** Every overlay, in picker order. The first is the original, whose settings keep their own
 * `mtf` field in the wall document; the rest are filed under `mx` by id (layout.ts). */
export const MTF_OVERLAYS: readonly MtfOverlay[] = [AREV21_MTF, AREV21_OUTLIER_RANK_90_MTF, AREV21_OUTLIER_RANK_85_MTF]
