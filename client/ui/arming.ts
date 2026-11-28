// TWO PRESSES, for anything that cannot be taken back: the first press arms the button -- the
// surface redraws it relabelled ("Confirm delete", "Press again to remove") -- and a second press
// of the same button within the window goes ahead. No modal: the question is asked by the button
// itself, where the pointer already is. The window passes by itself and the button reads as it
// did, so a press long forgotten never turns into a delete.
//
// One pending press per surface, under a key the surface chooses ('delete:<id>', the trading kit's
// `armKey`): arming another button disarms the first. The window is each surface's own, passed
// in, and they are not all the same length.

export class Arming {
  private armed: string | null = null
  private timer: ReturnType<typeof setTimeout> | null = null

  /** `onChange` redraws the surface: it runs whenever the armed key changes, the window lapsing
   * included. */
  constructor(
    private readonly onChange: () => void,
    private readonly ms: number
  ) {}

  /** The key waiting for its second press, or null. */
  get key(): string | null {
    return this.armed
  }

  /** True when the action should happen now: the second press of `key` inside the window, or the
   * first when `now` says no confirmation is wanted (one-click trading). */
  press(key: string, now = false): boolean {
    if (now || this.armed === key) {
      this.disarm()
      return true
    }
    this.armed = key
    if (this.timer) clearTimeout(this.timer)
    this.timer = setTimeout(() => this.disarm(), this.ms)
    this.onChange()
    return false
  }

  /** Back to unarmed, redrawing only when something was armed. */
  disarm(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
    if (this.armed === null) return
    this.armed = null
    this.onChange()
  }

  /** Stops the window without a redraw, for a surface being torn down. */
  dispose(): void {
    if (this.timer) clearTimeout(this.timer)
    this.timer = null
  }
}
