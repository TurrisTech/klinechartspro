import type { KLineData } from 'klinecharts'

import {
  KLineChartPro,
  type Datafeed,
  type DatafeedSubscribeCallback,
  type Period,
  type SymbolInfo
} from '../src'

import './style.css'

const symbols: SymbolInfo[] = [
  {
    ticker: 'AAPL',
    name: 'Apple Inc.',
    shortName: 'Apple',
    exchange: 'NASDAQ',
    market: 'stocks',
    pricePrecision: 2,
    volumePrecision: 0,
    priceCurrency: 'USD',
    type: 'Stock'
  },
  {
    ticker: 'MSFT',
    name: 'Microsoft Corporation',
    shortName: 'Microsoft',
    exchange: 'NASDAQ',
    market: 'stocks',
    pricePrecision: 2,
    volumePrecision: 0,
    priceCurrency: 'USD',
    type: 'Stock'
  },
  {
    ticker: 'BTCUSD',
    name: 'Bitcoin / U.S. Dollar',
    shortName: 'Bitcoin',
    exchange: 'CRYPTO',
    market: 'crypto',
    pricePrecision: 2,
    volumePrecision: 3,
    priceCurrency: 'USD',
    type: 'Crypto'
  }
]

const periodMilliseconds = (period: Period): number => {
  const unit: Record<string, number> = {
    second: 1_000,
    minute: 60_000,
    hour: 3_600_000,
    day: 86_400_000,
    week: 604_800_000,
    month: 2_592_000_000,
    year: 31_536_000_000
  }
  return (unit[period.timespan] ?? unit.day) * period.multiplier
}

const symbolSeed = (ticker: string): number =>
  [...ticker].reduce((total, character) => total + character.charCodeAt(0), 0)

const createBar = (symbol: SymbolInfo, timestamp: number, interval: number): KLineData => {
  const seed = symbolSeed(symbol.ticker)
  const index = Math.floor(timestamp / interval)
  const base = symbol.ticker === 'BTCUSD' ? 64_000 : 80 + (seed % 280)
  const scale = symbol.ticker === 'BTCUSD' ? 1_100 : 3.5
  const trend = ((index % 300) - 150) * scale * 0.015
  const wave = Math.sin(index * 0.19 + seed) * scale + Math.cos(index * 0.071) * scale * 0.55
  const open = base + trend + wave
  const close = open + Math.sin(index * 0.53 + seed) * scale * 0.62
  const spread = scale * (0.35 + Math.abs(Math.cos(index * 0.31)))

  return {
    timestamp,
    open,
    high: Math.max(open, close) + spread,
    low: Math.min(open, close) - spread,
    close,
    volume: Math.round(35_000 + Math.abs(Math.sin(index * 0.23 + seed)) * 180_000),
    turnover: close * 100_000
  }
}

class DemoDatafeed implements Datafeed {
  private timer?: ReturnType<typeof setInterval>

  async searchSymbols(search = ''): Promise<SymbolInfo[]> {
    const query = search.trim().toLowerCase()
    return symbols.filter((symbol) =>
      `${symbol.ticker} ${symbol.name ?? ''}`.toLowerCase().includes(query)
    )
  }

  async getHistoryKLineData(
    symbol: SymbolInfo,
    period: Period,
    from: number,
    to: number
  ): Promise<KLineData[]> {
    const interval = periodMilliseconds(period)
    const end = Math.floor(to / interval) * interval
    const available = Math.max(1, Math.floor((end - from) / interval) + 1)
    const count = Math.min(available, 500)
    const start = end - (count - 1) * interval
    return Array.from({ length: count }, (_, index) =>
      createBar(symbol, start + index * interval, interval)
    )
  }

  subscribe(symbol: SymbolInfo, period: Period, callback: DatafeedSubscribeCallback): void {
    this.unsubscribe(symbol, period)
    const interval = periodMilliseconds(period)
    this.timer = setInterval(() => {
      const timestamp = Math.floor(Date.now() / interval) * interval
      callback(createBar(symbol, timestamp, interval))
    }, 2_000)
  }

  unsubscribe(_symbol: SymbolInfo, _period: Period): void {
    if (this.timer) clearInterval(this.timer)
    this.timer = undefined
  }
}

new KLineChartPro({
  container: 'app',
  locale: 'zh-CN',
  theme: new URLSearchParams(window.location.search).get('theme') ?? 'light',
  symbol: symbols[0],
  period: { multiplier: 1, timespan: 'day', text: 'D' },
  // A factory, not a shared instance: DemoDatafeed's `timer` field is exactly the hazard a
  // multi-pane wall exposes -- one shared instance would mean every pane's subscription
  // clobbers the last one's interval. See src/types.ts DatafeedFactory.
  datafeed: () => new DemoDatafeed()
})
