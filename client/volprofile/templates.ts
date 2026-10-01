import { type Indicator, type IndicatorTemplate, type KLineData, registerIndicator } from 'klinecharts'
import type { IndicatorGroup } from '../../src'
import { peekStore } from '../plugins/store'
import { nominalMs, scheduleIntervalEnd, sessionDated } from '../replay/timeframes'
import { periodKey, type SessionClock, sessionDay } from '../tradetalk/calendar'
import { AtomIndex, type Atoms, quantumFor, type SourceBar } from './atoms'
import { VP_DEFAULTS, type VpConfig } from './config'
import { type Profile, sumAtoms, toProfile } from './profile'
import type { BarStore, Schedule } from './source'

// The volume profile's one klinecharts template, on the price pane.
//
// `calc` turns the source bars into one histogram per chart bar (atoms.ts) and files each bar
// under its session; `draw` sums whichever bars the mode asks for -- the ones on screen, or
// each session's -- into rows (profile.ts) and paints them. The template declares no figures
// and `draw` returns true, so klinecharts draws nothing of its own and nothing here can enter
// -- and flatten -- the candles' price axis.

export const TEMPLATE_NAME = 'VP:volume'

export function isVolumeProfileIndicator(name: string): boolean {
  return name === TEMPLATE_NAME
}

export interface ExtendData {
  seriesKey: string
  rev: number
  config: VpConfig
  /** Identifies this indicator on this pane: what the per-pane index is cached under. */
  cacheKey: string
  chart: string
  /** The source interval, or null when the chart's own bars are the source. */
  source: string | null
  /** Wire date -> open instant. Null for a session-dated chart without a schedule, which
   * this cannot map a source bar into. */
  chartShift: number | null
  sourceShift: number
  schedule: Schedule | null
  /** The session clock `session` mode groups bars on; null without a schedule. */
  clock: SessionClock | null
  tick: number
  /** Under which key the atom height is frozen: the source store's, so every pane profiling
   * the same source sums onto the same grid. */
  quantumKey: string
}

/** One chart bar: its histogram, and the session it belongs to (NaN when none can be said). */
export interface VpValue {
  atoms: Atoms | null
  session: number
}

interface PaneCache {
  index: AtomIndex
  storeKey: string | null
  storeRev: number
  q: number
}

/** Per indicator instance; bounded, since a removed indicator never says so. */
const caches = new Map<string, PaneCache>()
const MAX_CACHES = 32

function cacheFor(key: string): PaneCache {
  let cache = caches.get(key)
  if (cache) {
    caches.delete(key)
  } else {
    cache = { index: new AtomIndex(), storeKey: null, storeRev: -1, q: 0 }
    if (caches.size >= MAX_CACHES) caches.delete(caches.keys().next().value as string)
  }
  caches.set(key, cache)
  return cache
}

/** Atom heights, frozen per source once there are enough bars to judge a typical range. */
const quanta = new Map<string, number>()
const QUANTUM_SAMPLE = 2000
const QUANTUM_MIN_BARS = 50

function quantumOf(e: ExtendData, store: BarStore | undefined, dataList: readonly KLineData[]): number {
  const frozen = quanta.get(e.quantumKey)
  if (frozen !== undefined) return frozen
  if (store && store.bars.length >= QUANTUM_MIN_BARS) {
    const q = quantumFor(
      store.bars.slice(-QUANTUM_SAMPLE).map((b) => b.high - b.low),
      e.tick
    )
    quanta.set(e.quantumKey, q)
    return q
  }
  // Until the source arrives: the chart's bars, scaled down to the source's by the square root
  // of the ratio (source.ts explains the rule). Provisional -- the index rebuilds once when
  // the frozen value replaces it.
  const scale = e.source ? Math.sqrt(nominalMs(e.source) / nominalMs(e.chart)) : 1
  const q = quantumFor(
    dataList.slice(-QUANTUM_SAMPLE).map((b) => (b.high - b.low) * scale),
    e.tick
  )
  if (!e.source && dataList.length >= QUANTUM_MIN_BARS) quanta.set(e.quantumKey, q)
  return q
}

/** Where the last chart bar ends, as an instant. */
function lastEnd(e: ExtendData, lastStart: number): number {
  if (sessionDated(e.chart) && e.schedule) {
    return scheduleIntervalEnd(e.chart, lastStart, e.schedule.timezone, e.schedule.day)
  }
  return lastStart + nominalMs(e.chart)
}

/** Bars -> values. Exported for the tests. */
export function computeValues(dataList: readonly KLineData[], e: ExtendData, store: BarStore | undefined): VpValue[] {
  const n = dataList.length
  const chartShift = e.chartShift
  if (n === 0 || chartShift === null) return dataList.map(() => ({ atoms: null, session: Number.NaN }))

  const cache = cacheFor(e.cacheKey)
  const storeKey = store?.key ?? null
  let dirty: number | null = null
  if (storeKey !== cache.storeKey) {
    dirty = Number.NEGATIVE_INFINITY
    cache.storeKey = storeKey
    cache.storeRev = -1
  }
  if (store) {
    const changed = store.changedSince(cache.storeRev)
    if (changed !== null) dirty = Math.min(dirty ?? Number.POSITIVE_INFINITY, changed - e.sourceShift)
    cache.storeRev = store.rev
  }
  const q = quantumOf(e, store, dataList)
  cache.q = q

  const starts = dataList.map((bar) => bar.timestamp - chartShift)
  const atoms = cache.index.update(
    { starts, bars: dataList, lastEnd: lastEnd(e, starts[n - 1]) },
    store ? { bars: store.bars as readonly SourceBar[], shift: e.sourceShift } : null,
    q,
    dirty
  )

  const out = new Array<VpValue>(n)
  const clock = e.config.mode === 'session' ? e.clock : null
  for (let i = 0; i < n; i++) {
    const session = clock ? periodKey(sessionDay(dataList[i].timestamp, clock), e.config.session) : Number.NaN
    out[i] = { atoms: atoms[i], session }
  }
  return out
}

function configOf(indicator: { extendData?: Partial<ExtendData> }): VpConfig {
  return indicator.extendData?.config ?? VP_DEFAULTS
}

/** Profiles already summed for one `calc` result, by range and shape. A scroll re-sums; a
 * crosshair move (which redraws every frame) does not. */
const profiles = new WeakMap<VpValue[], Map<string, Profile | null>>()

function profileOf(result: VpValue[], from: number, to: number, q: number, config: VpConfig): Profile | null {
  let memo = profiles.get(result)
  if (!memo) {
    memo = new Map()
    profiles.set(result, memo)
  }
  const key = `${from}|${to}|${config.rows}|${config.valueArea}`
  let profile = memo.get(key)
  if (profile === undefined) {
    const slots = result.map((v) => v?.atoms ?? null)
    profile = toProfile(sumAtoms(slots, from, to), q, config.rows, config.valueArea / 100)
    if (memo.size > 64) memo.clear()
    memo.set(key, profile)
  }
  return profile
}

type Axis = { convertToPixel: (value: number) => number }

/** Paint a profile's rows from `anchor`, leftwards (`direction` -1) or rightwards (+1), the
 * longest `maxLen` px. Up volume is the part nearer the anchor's far side, down the rest. */
function drawRows(ctx: CanvasRenderingContext2D, p: Profile, yAxis: Axis, anchor: number, direction: 1 | -1, maxLen: number, config: VpConfig): void {
  let max = 0
  for (let r = 0; r < p.up.length; r++) max = Math.max(max, p.up[r] + p.down[r])
  if (!(max > 0) || !(maxLen > 0)) return
  const { opacity, showValueArea, upColor, downColor } = config.draw
  for (let r = 0; r < p.up.length; r++) {
    const v = p.up[r] + p.down[r]
    if (!(v > 0)) continue
    const y1 = yAxis.convertToPixel(p.lo + (r + 1) * p.rowHeight)
    const y2 = yAxis.convertToPixel(p.lo + r * p.rowHeight)
    let top = Math.min(y1, y2)
    let height = Math.abs(y2 - y1)
    if (height > 3) {
      top += 0.5
      height -= 1
    }
    const len = (v / max) * maxLen
    const upLen = (len * p.up[r]) / v
    const inside = r >= p.vaLow && r <= p.vaHigh
    ctx.globalAlpha = opacity * (showValueArea && !inside ? 0.45 : 1)
    const start = direction < 0 ? anchor - len : anchor
    ctx.fillStyle = upColor
    ctx.fillRect(start, top, upLen, Math.max(1, height))
    ctx.fillStyle = downColor
    ctx.fillRect(start + upLen, top, len - upLen, Math.max(1, height))
  }
  ctx.globalAlpha = 1
}

function drawPoc(ctx: CanvasRenderingContext2D, p: Profile, yAxis: Axis, x0: number, x1: number, color: string): void {
  const y = Math.round(yAxis.convertToPixel(p.lo + (p.poc + 0.5) * p.rowHeight)) + 0.5
  ctx.save()
  // The context carries whatever dash klinecharts last stroked with.
  ctx.setLineDash([])
  ctx.strokeStyle = color
  ctx.lineWidth = 1
  ctx.globalAlpha = 0.9
  ctx.beginPath()
  ctx.moveTo(x0, y)
  ctx.lineTo(x1, y)
  ctx.stroke()
  ctx.restore()
}

const draw: NonNullable<IndicatorTemplate<VpValue, number, ExtendData>['draw']> = ({ ctx, chart, indicator, bounding, xAxis, yAxis }) => {
  const result = indicator.result
  const e = indicator.extendData
  if (!e || result.length === 0) return true
  const q = caches.get(e.cacheKey)?.q ?? 0
  if (!(q > 0)) return true
  const config = configOf(indicator)
  const range = chart.getVisibleRange()
  const from = Math.max(0, range.realFrom)
  const to = Math.min(result.length - 1, range.realTo)
  if (to < from) return true

  if (config.mode === 'visible') {
    const profile = profileOf(result, from, to, q, config)
    if (!profile) return true
    drawRows(ctx, profile, yAxis, bounding.width, -1, (bounding.width * config.draw.width) / 100, config)
    if (config.draw.showPoc) drawPoc(ctx, profile, yAxis, 0, bounding.width, config.draw.pocColor)
    return true
  }

  // One profile per session, each over the WHOLE session -- a session half off screen is still
  // profiled from all of its bars -- drawn from the session's left edge within its own width.
  const barSpace = chart.getBarSpace().bar
  const same = (a: number, b: number) => a === b && !Number.isNaN(a)
  let i = from
  while (i > 0 && same(result[i - 1]?.session, result[from]?.session)) i--
  while (i <= to) {
    const key = result[i]?.session
    let j = i
    while (j + 1 < result.length && same(result[j + 1]?.session, key)) j++
    if (!Number.isNaN(key)) {
      const profile = profileOf(result, i, j, q, config)
      if (profile) {
        const left = xAxis.convertToPixel(i) - barSpace / 2
        const right = xAxis.convertToPixel(j) + barSpace / 2
        drawRows(ctx, profile, yAxis, left, 1, ((right - left) * config.draw.width) / 100, config)
        if (config.draw.showPoc) drawPoc(ctx, profile, yAxis, left, right, config.draw.pocColor)
      }
    }
    i = j + 1
  }
  return true
}

function shouldUpdate(prev: Indicator<VpValue, number, ExtendData>, cur: Indicator<VpValue, number, ExtendData>) {
  const a = prev.extendData
  const b = cur.extendData
  const calc =
    a?.seriesKey !== b?.seriesKey ||
    a?.rev !== b?.rev ||
    a?.config?.mode !== b?.config?.mode ||
    a?.config?.session !== b?.config?.session
  return { calc, draw: true }
}

/** The klinecharts template. Exported for the tests. */
export function buildTemplate(): IndicatorTemplate<VpValue, number, ExtendData> {
  return {
    name: TEMPLATE_NAME,
    shortName: 'VP',
    // Never TIGHTENS the price axis (klinecharts takes the minimum precision of the pane's
    // indicators); the instrument's own is applied as an override when bound.
    precision: 5,
    // Must stay empty: klinecharts prints calcParams into the legend, and the settings are the
    // pane's VpConfig, edited on the gear (plugin.ts).
    calcParams: [],
    shouldOhlc: false,
    shouldFormatBigNumber: false,
    visible: true,
    zLevel: 0,
    extendData: {
      seriesKey: '',
      rev: 0,
      config: VP_DEFAULTS,
      cacheKey: '',
      chart: '1h',
      source: null,
      chartShift: null,
      sourceShift: 0,
      schedule: null,
      clock: null,
      tick: 0,
      quantumKey: ''
    },
    series: 'price',
    figures: [],
    minValue: null,
    maxValue: null,
    styles: null,
    shouldUpdate,
    calc: (dataList, indicator) => {
      const e = indicator.extendData
      if (!e?.cacheKey) return dataList.map(() => ({ atoms: null, session: Number.NaN }))
      const store = e.source ? peekStore<BarStore>(e.seriesKey) : undefined
      return computeValues(dataList, e, store)
    },
    regenerateFigures: null,
    createTooltipDataSource: null,
    draw
  }
}

let registered = false

export function registerVolumeProfileIndicator(): IndicatorGroup[] {
  if (!registered) {
    registerIndicator(buildTemplate())
    registered = true
  }
  return [
    {
      label: 'Volume profile',
      main: true,
      items: [
        {
          name: TEMPLATE_NAME,
          label: 'VOLUME PROFILE',
          description:
            'Volume at each price, over the bars on screen or one profile per session, built from a lower timeframe than the chart (the legend names it) so each bar is small against a row. Point of control and value area shaded; mode, rows and colours on the gear. OANDA volume is a count of price updates, not traded volume.'
        }
      ]
    }
  ]
}
