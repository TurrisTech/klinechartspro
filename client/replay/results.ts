import type { SimSnapshot } from '../trading/api'
import { formatDuration, formatMoney, formatPercent } from '../trading/format'
import type { StatRow, StatTone } from '../trading/stats'

// PURE. How a replay session has gone, worked out from its snapshot: the closed trades' realised
// P&L, the open ones' marked-to-market, and the curve the closes draw. The replay is practice,
// and practice needs a score -- the account window lists every trade, this says what they add up
// to. Drawn by the controls' Results panel (controls.ts) through the trading kit's FigureList.
//
// Every figure is in the account's own currency, as the engine keeps balance and realised P&L.

export interface ReplayResults {
  currency: string
  initialBalance: number
  equity: number
  /** Equity against the starting balance: realised plus what is still open. */
  net: number
  netPct: number | null
  realised: number
  unrealised: number
  /** Closed trades, and how they split. A trade closed at exactly zero is neither. */
  closed: number
  wins: number
  losses: number
  winRate: number | null
  avgWin: number | null
  avgLoss: number | null
  /** Gross profit over gross loss: Infinity with wins and no loss, null with no closed trade. */
  profitFactor: number | null
  /** Realised P&L per closed trade. */
  expectancy: number | null
  best: number | null
  worst: number | null
  /** The deepest fall of the balance from a previous high, over the closes in order -- the
   * realised curve, so a drawdown is one the account actually took. */
  maxDrawdown: { amount: number; pct: number } | null
  open: number
  /** How much market time the session has replayed. */
  span: number
}

export function replayResults(snapshot: SimSnapshot, startedAt: number, cursor: number): ReplayResults {
  const { account } = snapshot
  const closed = snapshot.trades.filter((t) => t.closedAt !== null).sort((a, b) => (a.closedAt ?? 0) - (b.closedAt ?? 0))
  const pnls = closed.map((t) => t.realizedPnl ?? 0)
  const wins = pnls.filter((p) => p > 0)
  const losses = pnls.filter((p) => p < 0)
  const grossWin = sum(wins)
  const grossLoss = -sum(losses)
  const realised = sum(pnls)

  let balance = account.initialBalance
  let peak = balance
  let drawdown: { amount: number; pct: number } | null = null
  for (const p of pnls) {
    balance += p
    if (balance > peak) peak = balance
    const fall = peak - balance
    if (fall > 0 && (drawdown === null || fall > drawdown.amount)) drawdown = { amount: fall, pct: peak > 0 ? (fall / peak) * 100 : 0 }
  }

  const net = account.equity - account.initialBalance
  return {
    currency: account.currency,
    initialBalance: account.initialBalance,
    equity: account.equity,
    net,
    netPct: account.initialBalance > 0 ? (net / account.initialBalance) * 100 : null,
    realised,
    unrealised: account.unrealizedPnl,
    closed: closed.length,
    wins: wins.length,
    losses: losses.length,
    winRate: closed.length > 0 ? (wins.length / closed.length) * 100 : null,
    avgWin: wins.length > 0 ? grossWin / wins.length : null,
    avgLoss: losses.length > 0 ? -grossLoss / losses.length : null,
    profitFactor: closed.length === 0 ? null : grossLoss > 0 ? grossWin / grossLoss : wins.length > 0 ? Number.POSITIVE_INFINITY : null,
    expectancy: closed.length > 0 ? realised / closed.length : null,
    best: pnls.length > 0 ? Math.max(...pnls) : null,
    worst: pnls.length > 0 ? Math.min(...pnls) : null,
    maxDrawdown: closed.length > 0 ? (drawdown ?? { amount: 0, pct: 0 }) : null,
    open: snapshot.trades.length - closed.length,
    span: Math.max(0, cursor - startedAt)
  }
}

/** The figure under the panel's title: net P&L, in the account's currency and as a return. */
export function resultHeadline(r: ReplayResults): { text: string; tone: StatTone } {
  return { text: `${formatMoney(r.net, r.currency)} · ${formatPercent(r.netPct)}`, tone: tone(r.net) }
}

/** The rows, in pairs that read across the two columns. Money without the currency -- the
 * headline carries it -- so a value fits its half of a narrow card. Before the first close only
 * what exists is shown: ten dashes for figures no trade has produced yet are noise. */
export function resultRows(r: ReplayResults): StatRow[] {
  const money = (v: number | null): string => formatMoney(v)
  const open: StatRow = { label: 'Open', value: r.open === 0 ? '0' : `${r.open} · ${money(r.unrealised)}`, tone: r.open === 0 ? '' : tone(r.unrealised) }
  const replayed: StatRow = { label: 'Replayed', value: formatDuration(r.span) }
  if (r.closed === 0) return [open, replayed]
  return [
    { label: 'Closed', value: String(r.closed) },
    { label: 'Win rate', value: r.winRate === null ? '—' : `${r.winRate.toFixed(0)}% · ${r.wins}W ${r.losses}L` },
    { label: 'Profit factor', value: profitFactorText(r.profitFactor), tone: r.profitFactor === null ? '' : r.profitFactor >= 1 ? 'up' : 'down' },
    { label: 'Expectancy', value: money(r.expectancy), tone: tone(r.expectancy) },
    { label: 'Avg win', value: money(r.avgWin), tone: tone(r.avgWin) },
    { label: 'Avg loss', value: money(r.avgLoss), tone: tone(r.avgLoss) },
    { label: 'Best', value: money(r.best), tone: tone(r.best) },
    { label: 'Worst', value: money(r.worst), tone: tone(r.worst) },
    {
      label: 'Max drawdown',
      value: r.maxDrawdown === null ? '—' : r.maxDrawdown.amount === 0 ? '0' : `${money(-r.maxDrawdown.amount)} · ${r.maxDrawdown.pct.toFixed(2)}%`,
      tone: r.maxDrawdown && r.maxDrawdown.amount > 0 ? 'down' : ''
    },
    open,
    { label: 'Realised', value: money(r.realised), tone: tone(r.realised) },
    replayed
  ]
}

function profitFactorText(pf: number | null): string {
  if (pf === null) return '—'
  return Number.isFinite(pf) ? pf.toFixed(2) : '∞'
}

function tone(value: number | null): StatTone {
  if (value === null || !Number.isFinite(value) || value === 0) return ''
  return value > 0 ? 'up' : 'down'
}

function sum(values: number[]): number {
  return values.reduce((s, v) => s + v, 0)
}
