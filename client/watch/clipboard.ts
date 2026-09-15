// Copying a price to the clipboard, in the forms every browser the dashboard runs on accepts.
//
// The constraint that shapes all of it is Safari's: a clipboard write is allowed only while
// the tap that asked for it is still being handled. A write STARTED after an await -- the
// quote fetch behind "Fetch bid price into clipboard" -- is refused on iOS, silently. What
// Safari does accept is a write started inside the tap whose CONTENT is still a promise
// (`ClipboardItem` with a promised Blob): activation is checked at the call, not at
// resolution. So a copy whose text is not known yet goes through that form, and falls back
// to writing the text once it arrives only where that form is missing -- which is where the
// browser does not need the gesture anyway.

export interface ClipboardEnv {
  clipboard?: {
    writeText?(text: string): Promise<void>
    write?(items: ClipboardItem[]): Promise<void>
  }
  ClipboardItem?: typeof ClipboardItem
  /** The pre-Clipboard-API path, for a page served over plain http (no `navigator.clipboard`
   * outside a secure context). True if the browser says it copied. */
  fallback(text: string): boolean
}

export function browserClipboard(): ClipboardEnv {
  return {
    clipboard: typeof navigator === 'undefined' ? undefined : navigator.clipboard,
    ClipboardItem: typeof ClipboardItem === 'undefined' ? undefined : ClipboardItem,
    fallback: execCommandCopy
  }
}

/** Copy text already in hand. Call it synchronously from the tap or click. */
export async function copyText(text: string, env: ClipboardEnv = browserClipboard()): Promise<boolean> {
  if (env.clipboard?.writeText) {
    try {
      await env.clipboard.writeText(text)
      return true
    } catch {
      // A denied permission: try the old path.
    }
  }
  return env.fallback(text)
}

/** Copy text that is still being fetched. Call it synchronously from the tap or click; it
 * rejects if `pending` does, so the caller can say nothing was copied. */
export async function copyPendingText(
  pending: Promise<string>,
  env: ClipboardEnv = browserClipboard()
): Promise<boolean> {
  const Item = env.ClipboardItem
  if (env.clipboard?.write && Item) {
    try {
      const blob = pending.then((text) => new Blob([text], { type: 'text/plain' }))
      await env.clipboard.write([new Item({ 'text/plain': blob })])
      return true
    } catch {
      // Either the content never came (rethrown by the await below) or this browser's
      // ClipboardItem takes no promise -- one that also needs no gesture to write text later.
    }
  }
  return copyText(await pending, env)
}

function execCommandCopy(text: string): boolean {
  const area = document.createElement('textarea')
  area.value = text
  // iOS selects nothing in a read-only field, and zooms the page into any field under 16px
  // that takes focus -- so editable, 16px, and selected by range rather than select().
  area.contentEditable = 'true'
  area.readOnly = false
  area.style.cssText = 'position:fixed;top:0;left:0;opacity:0;font-size:16px;'
  const previous = document.activeElement as HTMLElement | null
  document.body.appendChild(area)
  area.focus()
  area.select()
  area.setSelectionRange(0, text.length)
  try {
    return document.execCommand('copy')
  } catch {
    return false
  } finally {
    area.remove()
    previous?.focus?.()
  }
}
