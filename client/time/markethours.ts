// The schedule's wire shape: when an instrument's market is open, as wdashboard-server sends it on
// the instrument's configuration (wmarkettypes `MarketHours`). Types only -- what is read from it
// is daygeometry.ts (the candle grid) and timeframes.ts (the boundaries). Here rather than in
// symbols.ts so the time leaf imports nothing from the client above it.

// One half-open [open, close) span of the trading week, in the schedule's timezone.
// Days are 'mon'..'sun'; times are 'HH:MM' (or 'HH:MM:SS'). A close earlier in the week
// than the open wraps the weekend — that is how forex's Sunday-to-Friday span is written.
export interface MarketSession {
  openDay: string
  openTime: string
  closeDay: string
  closeTime: string
}

// When the instrument's market is open, as a repeating weekly schedule. A list of
// sessions rather than an open/close pair because forex is one span across the week,
// US equity is five daily ones, and crypto is a single span covering all of it.
// Always the EFFECTIVE schedule: the server has already resolved any per-instrument
// override against the vendor's default.
//
// `trading`, when present, is when the instrument actually TRADES where that is not its grid
// (wmarkettypes `MarketHours.trading`): the lira crosses keep Istanbul hours on New York's FX
// grid, the metals stop for an hour at 17:00. The top level stays the grid every candle
// boundary is read from (`dayGeometryOf`); rows are filtered on `trading ?? the top level`
// (`tradingWeekOf`). Exactly one level deep; null or absent where the two coincide.
export interface MarketHours {
  timezone: string
  sessions: MarketSession[]
  trading?: MarketHours | null
}
