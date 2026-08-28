import { expect, test } from 'bun:test'
import { MAX_NOTIFICATIONS, NotificationCenter } from './center'
import { relativeTime } from './bell'

// The centre's model. No DOM anywhere here: `bell.ts` is the only part that needs one, and
// bun has no document -- which is exactly why the list, the seen-count and the cap live in
// their own file.

function fakeStorage(): Storage & { raw: Map<string, string> } {
  const raw = new Map<string, string>()
  return {
    raw,
    get length() {
      return raw.size
    },
    clear: () => raw.clear(),
    key: (index: number) => [...raw.keys()][index] ?? null,
    getItem: (key: string) => raw.get(key) ?? null,
    setItem: (key: string, value: string) => {
      raw.set(key, value)
    },
    removeItem: (key: string) => {
      raw.delete(key)
    }
  } as Storage & { raw: Map<string, string> }
}

test('a notification arrives unseen and is counted', () => {
  const center = new NotificationCenter(null)
  center.notify({ title: 'EURUSD reached 1.16500', source: 'alerts', level: 'alert' })
  expect(center.unseen()).toBe(1)
  expect(center.list()[0].title).toBe('EURUSD reached 1.16500')
  expect(center.list()[0].level).toBe('alert')
})

test('marking seen is what stops the blink, and clearing is separate', () => {
  const center = new NotificationCenter(null)
  center.notify({ title: 'one' })
  center.notify({ title: 'two' })
  center.markAllSeen()
  expect(center.unseen()).toBe(0)
  // Seen, but still listed -- "I know" and "I'm done with these" are different acts.
  expect(center.list()).toHaveLength(2)
  center.clear()
  expect(center.list()).toHaveLength(0)
})

test('the list is newest first', () => {
  const center = new NotificationCenter(null)
  center.notify({ title: 'first' })
  center.notify({ title: 'second' })
  expect(center.list().map((row) => row.title)).toEqual(['second', 'first'])
})

test('clear takes one producer at a time', () => {
  const center = new NotificationCenter(null)
  center.notify({ title: 'an alert', source: 'alerts' })
  center.notify({ title: 'a replay note', source: 'replay' })
  center.clear('alerts')
  expect(center.list().map((row) => row.source)).toEqual(['replay'])
})

test('subscribers hear the current list immediately, then every change', () => {
  const center = new NotificationCenter(null)
  center.notify({ title: 'before' })
  const seen: number[] = []
  const stop = center.subscribe((list) => seen.push(list.length))
  center.notify({ title: 'after' })
  center.remove(center.list()[0].id)
  stop()
  center.notify({ title: 'ignored' })
  expect(seen).toEqual([1, 2, 1])
})

test('the list is capped, dropping the oldest', () => {
  const center = new NotificationCenter(null)
  for (let i = 0; i < MAX_NOTIFICATIONS + 5; i += 1) center.notify({ title: `n${i}` })
  const list = center.list()
  expect(list).toHaveLength(MAX_NOTIFICATIONS)
  expect(list[0].title).toBe(`n${MAX_NOTIFICATIONS + 4}`)
  expect(list.at(-1)?.title).toBe('n5')
})

test('the list survives a reload through storage, and stale rows do not', () => {
  const storage = fakeStorage()
  const first = new NotificationCenter(storage)
  first.notify({ title: 'recent' })
  first.notify({ title: 'ancient', at: Date.now() - 30 * 86_400_000 })

  const second = new NotificationCenter(storage)
  expect(second.list().map((row) => row.title)).toEqual(['recent'])
  // Still unseen after the reload: an alert nobody has looked at is exactly the one the
  // bell should still be blinking for.
  expect(second.unseen()).toBe(1)
})

test('unreadable storage costs the history, not the page', () => {
  const storage = fakeStorage()
  storage.setItem('wd.notifications', '{ not json')
  const center = new NotificationCenter(storage)
  expect(center.list()).toEqual([])
  center.notify({ title: 'fine' })
  expect(center.list()).toHaveLength(1)
})

test('relative time is coarse and never negative', () => {
  const now = 1_700_000_000_000
  expect(relativeTime(now, now)).toBe('just now')
  expect(relativeTime(now - 30_000, now)).toBe('just now')
  expect(relativeTime(now - 6 * 60_000, now)).toBe('6m ago')
  expect(relativeTime(now - 3 * 3_600_000, now)).toBe('3h ago')
  expect(relativeTime(now - 2 * 86_400_000, now)).toBe('2d ago')
  // A clock that stepped backwards must not print "-1m ago".
  expect(relativeTime(now + 5_000, now)).toBe('just now')
})
