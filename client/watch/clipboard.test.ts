import { describe, expect, test } from 'bun:test'

import { type ClipboardEnv, copyPendingText, copyText } from './clipboard'

// A ClipboardItem stand-in that keeps what it was given, so a test can resolve the content.
class FakeItem {
  constructor(readonly items: Record<string, Promise<Blob> | Blob | string>) {}
}

function env(overrides: Partial<ClipboardEnv> = {}): ClipboardEnv & { written: string[] } {
  const written: string[] = []
  return {
    written,
    fallback: (text) => {
      written.push(`fallback:${text}`)
      return true
    },
    ...overrides
  }
}

describe('copyText', () => {
  test('writes through the Clipboard API when there is one', async () => {
    const e = env()
    e.clipboard = { writeText: async (text) => void e.written.push(text) }
    expect(await copyText('1.15467', e)).toBe(true)
    expect(e.written).toEqual(['1.15467'])
  })

  test('falls back when the API refuses', async () => {
    const e = env({ clipboard: { writeText: () => Promise.reject(new Error('denied')) } })
    expect(await copyText('1.15467', e)).toBe(true)
    expect(e.written).toEqual(['fallback:1.15467'])
  })

  test('falls back when there is no API at all (plain http)', async () => {
    const e = env()
    expect(await copyText('1.15467', e)).toBe(true)
    expect(e.written).toEqual(['fallback:1.15467'])
  })
})

describe('copyPendingText', () => {
  test('starts the write before the text exists, with the text as a promise', async () => {
    let resolve: (text: string) => void = () => {}
    const pending = new Promise<string>((r) => {
      resolve = r
    })
    const calls: FakeItem[] = []
    const e = env({
      ClipboardItem: FakeItem as unknown as typeof ClipboardItem,
      clipboard: {
        write: async (items) => {
          calls.push(items[0] as unknown as FakeItem)
          const blob = await (items[0] as unknown as FakeItem).items['text/plain']
          e.written.push(await (blob as Blob).text())
        }
      }
    })
    const done = copyPendingText(pending, e)
    // The write was called synchronously -- this is what keeps Safari's tap activation.
    expect(calls).toHaveLength(1)
    resolve('1.15482')
    expect(await done).toBe(true)
    expect(e.written).toEqual(['1.15482'])
  })

  test('rejects when the text never comes, without writing anything', async () => {
    const e = env({
      ClipboardItem: FakeItem as unknown as typeof ClipboardItem,
      clipboard: {
        write: async (items) => {
          await (items[0] as unknown as FakeItem).items['text/plain']
        }
      }
    })
    await expect(copyPendingText(Promise.reject(new Error('no quote')), e)).rejects.toThrow('no quote')
    expect(e.written).toEqual([])
  })

  test('writes the text once it arrives where ClipboardItem is missing', async () => {
    const e = env()
    e.clipboard = { writeText: async (text) => void e.written.push(text) }
    expect(await copyPendingText(Promise.resolve('1.15482'), e)).toBe(true)
    expect(e.written).toEqual(['1.15482'])
  })

  test('writes the text once it arrives where ClipboardItem takes no promise', async () => {
    const e = env({
      ClipboardItem: FakeItem as unknown as typeof ClipboardItem,
      clipboard: {
        write: () => Promise.reject(new TypeError('promises not supported')),
        writeText: async (text) => void e.written.push(text)
      }
    })
    expect(await copyPendingText(Promise.resolve('1.15482'), e)).toBe(true)
    expect(e.written).toEqual(['1.15482'])
  })
})
