// A window of time, and one page of a paged read over it: the shapes every paged fetch in the
// client speaks -- the plugin host's sources (client/plugins), the tile join (tiles/join.ts), the
// replay's feed and the stores beside them. Types only. Until 2026-11-28 they were in
// client/plugins/types.ts, which most of their users have no other reason to import.

/** A span of time in epoch ms, on whichever clock its reader keys its rows by. */
export interface Range {
  from: number
  to: number
}

/** One page of a fetch. `nextFrom` says where the next page starts, or `null` when the
 * requested range is covered -- so a capped answer (`points.length >= limit`) continues
 * from the last point, and a chunked fetch continues from the chunk's end, through one
 * host loop. `status` reports a server still building the series; the host records the
 * phase and retries after `retryAfterMs`. */
export interface Page<P> {
  points: P[]
  nextFrom: number | null
  status?: { phase: 'queued' | 'replaying'; progress: number | null; retryAfterMs: number }
  /** The auxiliary arrays named in the request, by name. Absent when none were asked for;
   * a name the server did not send reads as an empty array, so a plugin talking to an
   * older server sees "no trades" rather than a crash. Paging is driven by `points`
   * alone: an auxiliary array is a different kind of row and does not have its own
   * cursor. */
  arrays?: Record<string, { date: number }[]>
  /** Where a tiered series' closed partitions can be read straight from the bucket, when the
   * server says so: passed on as the server sent it, and read only by the tiered source, which
   * says whether it is one (`client/indicatortiles/`, `isTileHint`). Absent for everything
   * else. */
  tiles?: unknown
  /** Why this page holds less than was asked -- a timeframe of an MTF overlay the server could
   * not read. Its points are drawn, its range is read again until a page comes back without one
   * (plugins/host.ts `degraded`), and the legend's warning says this (`SourceStore.problem`). */
  problem?: string
}
