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
test('the klinecharts the chart loads carries the stable-legend and contained-drawing patch', async () => {
  const entry = Bun.resolveSync('klinecharts', import.meta.dir)
  const pkg = await Bun.file(join(dirname(entry), '..', 'package.json')).json()
  expect(pkg.version).toBe('10.0.3')
  const source = await Bun.file(entry).text()
  for (const marker of ['_legendSlotWidth', '_figureLegendReserves', '_candleLegendReserves', '_fitTooltipName', 'drawContained', 'trackSaveDepth']) {
    expect(source).toContain(marker)
  }
})
