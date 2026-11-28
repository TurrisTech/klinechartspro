/**
 * Licensed under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License.
 * You may obtain a copy of the License at

 * http://www.apache.org/licenses/LICENSE-2.0

 * Unless required by applicable law or agreed to in writing, software
 * distributed under the License is distributed on an "AS IS" BASIS,
 * WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
 * See the License for the specific language governing permissions and
 * limitations under the License.
 */

// The one place a zone's wall clock is read through `Intl`. Two callers build on it, and keep
// different contracts on purpose:
//
//   * the SESSIONS indicator (../indicators/sessions.ts `zoneOffsetMinutes`) wants a zone's
//     offset in whole minutes for a few thousand bars a frame, so it resolves one per quarter
//     hour and caches it;
//   * the app's candle grid (client/time/timeframes.ts `toWall`) wants every instant's reading
//     exact to the millisecond, because each boundary it computes must be the one the server
//     labels a candle with.
//
// They agree wherever a zone's offset is a whole number of minutes and changes on a quarter hour
// -- New York, UTC and Istanbul at every instant since 1910 (client/time/wall.test.ts sweeps
// every transition) -- and differ by seconds before that, where a local mean time is rounded to
// the minute by the first and kept by the second.

const formatters = new Map<string, Intl.DateTimeFormat>()

function formatterFor(timezone: string): Intl.DateTimeFormat {
  let formatter = formatters.get(timezone)
  if (!formatter) {
    formatter = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit'
    })
    formatters.set(timezone, formatter)
  }
  return formatter
}

/** What a clock in `timezone` reads at `ms`, to the second, written as the UTC instant with the
 * same calendar fields (`Date.UTC(year, month - 1, day, hour, minute, second)`). The reading minus
 * the instant, both on a whole second, is the zone's offset; the sub-second part of `ms` is not
 * read. */
export function zoneReading(timezone: string, ms: number): number {
  let year = 0
  let month = 0
  let day = 0
  let hour = 0
  let minute = 0
  let second = 0
  for (const part of formatterFor(timezone).formatToParts(new Date(ms))) {
    switch (part.type) {
      case 'year':
        year = Number(part.value)
        break
      case 'month':
        month = Number(part.value)
        break
      case 'day':
        day = Number(part.value)
        break
      // `% 24` for an engine that writes midnight as 24 even under `h23`.
      case 'hour':
        hour = Number(part.value) % 24
        break
      case 'minute':
        minute = Number(part.value)
        break
      case 'second':
        second = Number(part.value)
        break
    }
  }
  return Date.UTC(year, month - 1, day, hour, minute, second)
}
