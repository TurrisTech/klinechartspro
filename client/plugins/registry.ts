import { createArev21DivergencePlugin } from '../arev21div/plugin'
import { createArevLabPlugin } from '../arevlab/plugin'
import { createBidAskPlugin } from '../bidask/plugin'
import { DEV_BOOKS } from '../books/api'
import { createBooksPlugin } from '../books/plugin'
import { createMtf01Plugin } from '../mtf01/plugin'
import { createMtfPlugin } from '../mtf/plugin'
import { MTF_OVERLAYS } from '../mtf/overlays'
import { createRegistryPlugin } from '../tsregistry/plugin'
import { createTradeTalkPlugin } from '../tradetalk/plugin'
import { createVolumeProfilePlugin } from '../volprofile/plugin'
import type { IndicatorPlugin } from './types'

// The built-in indicator plugins, in the order their picker groups appear. Built per mount
// (each holds per-pane state), which is why this is a factory and not a constant.
//
// There used to be one plugin per family here -- indicators, arev, krev -- each with its own
// templates. All three are now rows in the server's timeseries indicator registry and are
// mounted by the single `registry` plugin, which reads `GET /indicators/registry` and builds
// a template per row: adding an indicator is a row, not a module. What is left beside it is
// what the registry deliberately does not cover: the multi-timeframe overlays, whose sources
// read timeframes that are not the chart's; the book profiles, which are not a
// scalar-per-bar series at all; the AREV lab, which reads several registry rows into one
// pane and computes its own signal rules over them; the arev21 divergence, which compares
// arev21's p with the pane's own price swings and draws in both panes; bid/ask, which is not
// an indicator the server computes but the quote half of the bars themselves; TradeTalk,
// which is a trading method computed here from daily bars and the bars the pane already holds;
// and the volume profile, computed here from bars of a lower timeframe than the pane's.
//
// Levels and Zones (`levels`) are the picker's first group -- they were two buttons on the
// toolbar until 2026-10-03 -- and are built by the caller, which also hands
// their controllers the wall's panes and the replay (client/levels/indicator.ts).

export function builtinPlugins(levels: IndicatorPlugin): IndicatorPlugin[] {
  return [
    levels,
    createRegistryPlugin(),
    createArevLabPlugin(),
    createArev21DivergencePlugin(),
    // One per overlay: AREV21 MTF and the arev21_outlier rank overlays (mtf/overlays.ts).
    ...MTF_OVERLAYS.map((overlay) => createMtfPlugin(overlay)),
    createMtf01Plugin(),
    createBooksPlugin(),
    createBooksPlugin(DEV_BOOKS),
    createBidAskPlugin(),
    createTradeTalkPlugin(),
    createVolumeProfilePlugin()
  ]
}
