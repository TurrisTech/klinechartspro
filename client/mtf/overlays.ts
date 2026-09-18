import type { Feature } from '../capabilities'
import type { PluginFacilities } from '../plugins/types'
import { registrySourceKey } from '../tsregistry/store'
import { MTF_GENERATION, type ArevPoint, fetchMtfPoints, type MtfInterval } from './api'

// WHICH votes a multi-timeframe overlay draws. Everything else the overlay does -- the bar
// grid, the one-source-bar shift (shift.ts), the per-timeframe lanes and styles, the per-pane
// settings -- is the same whichever signal it is placing, so that machinery takes one of these
// and the overlays differ only here.
//
// Every overlay reads a series of `ArevPoint`-shaped rows whose `signal` is the server's
// published label; `shiftSignals` reads `date`, `p` and `signal` and nothing else. The
// arev21_outlier rows carry those three (plus their own `centre`/`hi`/`lo`/`side`), so they
// place exactly as arev21's do.

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
  /** The server capability this overlay's votes need. */
  feature: Feature
  /** The series' identity for one source timeframe -- the key the registry sub-pane for the
   * same series uses. The overlay's store is this plus `|mtf` (plugin.ts says why it must not
   * be the sub-pane's own). */
  sourceKey(vendor: string, ticker: string, interval: MtfInterval): string
  /** The votes for one source timeframe over `[from, to)`, in that timeframe's wire dates.
   * `nextFrom` is set when the answer was capped short of `to`. */
  fetchPoints(
    f: PluginFacilities,
    vendorSymbol: string,
    interval: MtfInterval,
    from: number,
    to: number,
    limit: number
  ): Promise<{ points: ArevPoint[]; nextFrom: number | null }>
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
  // Reads the same `/arev/values` the AREV panes do, which is why it gates on 'arev'.
  feature: 'arev',
  sourceKey: (vendor, ticker, interval) => registrySourceKey(MTF_GENERATION, vendor, ticker, interval),
  fetchPoints: async (_f, vendorSymbol, interval, from, to, limit) => ({
    points: await fetchMtfPoints(vendorSymbol, interval, from, to, limit),
    // The legacy path reports no cursor; a chunk is sized well under the server's cap.
    nextFrom: null
  })
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
 * ever do. `sourceKey` is then the series identity `storedSource` gives a
 * `TS:arev21_outlier_rank` sub-pane set to the same numbers; the overlay's store is kept apart
 * from that sub-pane's all the same (plugin.ts).
 */
export function outlierRankMtf(percent: number): MtfOverlay {
  const params = { bars: 200, q: percent / 100, samples_only: 0 }
  const tuned = `|${JSON.stringify(params)}`
  const name = `arev21_outlier_rank_${percent}`
  return {
    id: `mtf_${name}`,
    templateName: `MTF:${name}`,
    title: `AREV21 OUTLIER RANK ${percent} MTF`,
    groupLabel: `AREV21 outlier rank ${percent} multi-timeframe · price pane`,
    description: `arev21's p entering the top or bottom ${100 - percent}% of its last 200 bars, from several timeframes at once, each drawn one bar of its own timeframe forward. Timeframes, colours and sizes are on the gear.`,
    feature: 'arev21_outlier',
    sourceKey: (vendor, ticker, interval) => `${registrySourceKey(OUTLIER_RANK, vendor, ticker, interval)}${tuned}`,
    fetchPoints: async (f, vendorSymbol, interval, from, to, limit) => {
      const page = await f.points<ArevPoint>({
        pluginId: OUTLIER_PLUGIN,
        vendorSymbol,
        resolution: interval,
        from,
        to,
        limit,
        variant: OUTLIER_RANK,
        params
      })
      return { points: page.points, nextFrom: page.nextFrom }
    }
  }
}

export const AREV21_OUTLIER_RANK_90_MTF = outlierRankMtf(90)
export const AREV21_OUTLIER_RANK_85_MTF = outlierRankMtf(85)

/** Every overlay, in picker order. The first is the original, whose settings keep their own
 * `mtf` field in the wall document; the rest are filed under `mx` by id (layout.ts). */
export const MTF_OVERLAYS: readonly MtfOverlay[] = [AREV21_MTF, AREV21_OUTLIER_RANK_90_MTF, AREV21_OUTLIER_RANK_85_MTF]
