import { expect, test } from 'bun:test'
import { dirname, join } from 'node:path'

// patches/klinecharts@10.0.3.patch is what keeps the tooltip legends -- the OHLCV row, every
// indicator row and its buttons -- in one place while the crosshair moves (see its header,
// above createLegendValueStats). bun applies a patch to exactly the version it names, so an
// upgrade needs the patch regenerated against the new release; without it the legends go back
// to re-wrapping on every bar and nothing else fails.
//
// Read as text rather than imported: klinecharts touches `window` at import.
// It also carries "contained drawing" (klinechartsContain.test.ts): without it one throw while a
// chart draws blanks that whole canvas, silently, on every frame it throws.
//
// And "touch": a finger can drag a separator (24px band), a tap away from the crosshair moves it
// rather than only dismissing it, a second tap or click too far from the first to be a double is
// a tap of its own instead of being dropped, and lines/arcs/handles/thin rects are hit within
// 10px of a finger (2px of a mouse, unchanged). Without it a tablet could not resize an indicator
// pane, every other tap on a chart did nothing, and drawings could barely be selected.
test('the klinecharts the chart loads carries the stable-legend, contained-drawing and touch patch', async () => {
  const entry = Bun.resolveSync('klinecharts', import.meta.dir)
  const pkg = await Bun.file(join(dirname(entry), '..', 'package.json')).json()
  expect(pkg.version).toBe('10.0.3')
  const source = await Bun.file(entry).text()
  for (const marker of [
    '_legendSlotWidth',
    '_figureLegendReserves',
    '_candleLegendReserves',
    '_fitTooltipName',
    'drawContained',
    'trackSaveDepth',
    'TOUCH_SEPARATOR_HEIGHT',
    '_touchSeparatorWidget',
    'TOUCH_DEVIATION',
    'isDoubleTap',
    'isDoubleClick'
  ]) {
    expect(source).toContain(marker)
  }
})
