# API

## Creating chart
```typescript
new KLineChartPro(
  options: {
    container: string | HTMLElement;
    styles?: DeepPartial<Styles>;
    watermark?: string | Node;
    theme?: string;
    locale?: string;
    drawingBarVisible?: boolean;
    symbol: SymbolInfo;
    period: Period;
    periods?: Period[];
    starredPeriods?: string[];
    onStarredPeriodsChange?: (starredPeriods: string[]) => void;
    timezone?: string;
    mainIndicators?: string[];
    subIndicators?: string[];
    datafeed: Datafeed | ((paneId: string) => Datafeed);

    // App-registered indicators -- see "App indicators" below.
    indicatorGroups?: IndicatorGroup[];
    indicatorParamsValidator?: IndicatorParamsValidator | null;
    indicatorSettingsHandler?: IndicatorSettingsHandler | null;

    // Chart wall (1-12 panes) -- see "Chart wall" below.
    paneLayout?: string;
    panes?: PaneOptions[];
    maxPanes?: number;
    activePane?: string;
    syncCrosshair?: boolean;
    syncTime?: boolean;
    syncAuto?: boolean;
    syncSymbol?: boolean;
    syncPeriod?: boolean;
    onPaneLayoutChange?: (layoutId: string, panes: PaneSnapshot[]) => void;
    onActivePaneChange?: (paneId: string) => void;
    onPaneStateChange?: (paneId: string) => void;
    onPanesChange?: (panes: ChartProPane[]) => void;
    onSymbolChange?: (paneId: string, symbol: SymbolInfo) => void;
    onPeriodChange?: (paneId: string, period: Period) => void;
    onSyncChange?: (options: SyncOptions) => void;
  }
) => KLineChartPro
```
+ `container` Container id or container
+ `styles` Core chart styles -- applies to every pane
+ `watermark` Watermark -- applies to every pane (a Node is cloned per pane, never shared)
+ `theme` Theme -- applies to every pane
+ `locale` Language
+ `drawingBarVisible` Whether to display the drawing toolbar
+ `symbol` Symbol for the first pane. Ignored (but still required) when `panes` is given.
+ `period` Period for the first pane. Ignored (but still required) when `panes` is given.
+ `periods` All periods, shared by every pane
+ `starredPeriods` `Period.text` values shown as chips on the top-rail timeframe rail; the rest live behind the dropdown
+ `onStarredPeriodsChange` Fired on every star/unstar so the caller can persist the new set
+ `timezone` Timezone
+ `mainIndicators` Main indicators for the first pane (or every pane implied by `paneLayout` when `panes` is omitted)
+ `subIndicators` Sub indicators, same seeding rule as `mainIndicators`
+ `datafeed` Data access API implementation. Pass a factory `(paneId) => Datafeed` when a wall
  has more than one pane and the datafeed keeps any per-subscription state (most real
  implementations do) -- a single shared instance is only safe for a genuinely stateless
  datafeed, and the library warns once at construction if it looks unsafe.

## App indicators
An app that registers its own indicator templates (klinecharts' `registerIndicator`) can list
them in the indicator picker, check their parameters against what only it knows, and take
over their settings entirely. All three options are optional; omitting them leaves the
picker and the settings dialog exactly as they are. The types are exported from the package.

```typescript
interface IndicatorGroup {
  label: string;
  main: boolean;
  items: Array<{ name: string; label: string; description?: string }>;
}

type IndicatorParamsValidator = (request: {
  indicatorName: string;
  calcParams: unknown[];
  symbol: SymbolInfo;
  period: Period;
}) => Promise<IndicatorParamsCheck>;

interface IndicatorParamsCheck {
  ok: boolean;
  reason?: string | null;
  hint?: string | null;
}

type IndicatorSettingsHandler = (request: {
  indicatorName: string;
  paneId: string;
  chartPaneId: string;
  calcParams: unknown[];
}) => boolean;
```

+ `indicatorGroups` Extra groups for the indicator picker dialog, default `[]`. Each group is
  drawn as its own section after the built-in main and sub indicators, in array order, headed
  by `label` as given (it is not an i18n key). `main: true` puts the group's items on the
  candle pane; `false` gives each its own sub-pane. Every item is a checkbox that adds or
  removes the template `name` -- which must be a registered template name -- on the
  **active** pane; `label` is the checkbox text and `description` its hover tooltip. The
  same `label` also heads that indicator's row in the indicator manager. Group labels must be
  unique, and so must item names within a group (the dialog keys its lists by them). Read
  once at construction; there is no setter.
+ `indicatorParamsValidator` Checks the numbers in the built-in indicator settings dialog,
  whose fields come from `registerIndicatorSettings(name, settings)` (exported alongside
  `KLineChartPro`; a template with none registered opens a dialog with no fields). Default
  `null`: nothing is checked, and every combination can be confirmed. It is called only while
  that dialog is open -- once when it opens, and again after every edit, debounced 300 ms --
  and only the latest answer counts: one for values the user has since changed, or one that
  arrives after the dialog closed, is dropped. `calcParams` holds the dialog's current
  values: numbers, and `''` for a field the user cleared (Confirm substitutes the parameter's
  default for it, but the validator sees the `''`). `symbol` and `period` are those of the
  pane the indicator is on, which need not be the active pane. The answer drives the dialog:
  - Confirm is disabled while a check is pending -- from the dialog opening, or an edit,
    until that answer settles;
  - `ok: false` keeps Confirm disabled, and `reason`, if given, is shown as an error;
  - `hint` is shown as a note whenever no `reason` is shown -- with `ok: true`, or with
    `ok: false` and no `reason`;
  - a rejected promise counts as no answer: no message, and Confirm is enabled, so an
    unreachable server never locks the dialog.
+ `indicatorSettingsHandler` Lets the app own an indicator's settings. Default `null`: every
  indicator gets the built-in dialog. Called synchronously each time the user clicks the
  settings button in an indicator's tooltip, on any pane, before the built-in dialog would
  open. `paneId` is the wall pane (`'p1'`..`'pN'`), `chartPaneId` the klinecharts pane within
  it (`'candle_pane'` for a main indicator), and `calcParams` a copy of the indicator's
  current parameters. Return `true` once the app has opened its own UI for that indicator:
  the built-in dialog stays shut (so `indicatorParamsValidator` is not called either) and the
  library does nothing further -- applying and persisting whatever that UI changes is the
  app's job. Return `false` to let the built-in dialog open as usual. The return value is
  tested for truthiness at once, so it must be a boolean, not a promise: a promise counts as
  `true`.

## Chart wall
1-12 charts ("panes") in a configurable grid, one shared toolbar acting on an **active**
pane, crosshair sync, and click-to-scroll-to-date across the wall. Fully backward
compatible: omitting every option below still yields the original single chart.

+ `paneLayout` Layout preset id. Defaults to `'1'` (a single chart). See
  `getPaneLayouts()`/`KLineChartPro.getPaneLayouts()` for the full preset list (`'1'`, `'2h'`,
  `'2v'`, `'3h'`, `'3v'`, `'3-left'`, `'3-top'`, `'4'`, `'4h'`, `'4v'`, `'6'`, `'6v'`, `'8'`,
  `'9'`, `'12'`), or open the toolbar's layout picker.
+ `panes` Per-pane seeds (`{ symbol, period?, mainIndicators?, subIndicators? }[]`). When
  omitted, every pane implied by `paneLayout` is cloned from the top-level `symbol`/`period`/
  `mainIndicators`/`subIndicators`, ready to be retargeted individually.
+ `maxPanes` Upper bound on wall size. Default `12`.
+ `activePane` Which pane (`'p1'`..`'pN'`) starts active. Defaults to `'p1'`.
+ `syncCrosshair` / `syncTime` Initial state of the two sync toggles (toolbar's Sync popover).
  Both default `true`.
+ `syncAuto` Initial state of the auto-time-sync button beside that popover, default `false`.
  While it is on every pane follows whichever one is being panned or zoomed, and
  click-to-scroll (`syncTime`) is inert.
+ `syncSymbol` / `syncPeriod` Initial state of the wall-wide symbol and timeframe buttons,
  both `false`. While one is on, every visible pane shows the ACTIVE pane's symbol / period:
  turning it on aligns the wall at that moment, a pane added by a layout grow arrives aligned
  too, and each pane it moves is reported through `onSymbolChange`/`onPeriodChange`. Turning
  it off leaves the panes where it put them -- what a pane showed beforehand is not restored.
+ `onPaneLayoutChange` Fired when the layout preset changes, with every currently-visible
  pane's symbol/period/indicators -- the payload to persist if you want the wall to survive a
  reload.
+ `onActivePaneChange` Fired when the active pane changes.
+ `onPaneStateChange` Fired when a pane changes in a way none of the other callbacks report:
  an indicator added, removed or re-parameterised, and -- debounced to the end of the gesture
  -- a pan, a zoom or a hand-scaled price axis. Carries only the pane id; re-read
  `getPaneSnapshots()`, which carries everything a wall needs to be restored exactly:
  each pane's `indicatorParams` (template name -> `calcParams`) and its `view`
  (`barSpace`, whether it was following the live candle, the anchor timestamp and fraction it
  was positioned at, and the y-axis type/reverse plus any manual price range). Hand those
  back as `panes[].indicatorParams` / `panes[].view` and the wall comes back as it was.
+ `onPanesChange` Fired whenever the LIVE pane set changes -- a pane's chart was just created
  or just destroyed (including every layout grow/shrink). Resync any per-pane external
  behaviour (e.g. price-level overlays) entirely from this callback's argument.
+ `onSymbolChange` / `onPeriodChange` Fired when a specific pane's symbol/period changes,
  whichever pane it was (not necessarily the active one, e.g. via `ChartProPane.setSymbol`).
+ `onSyncChange` Fired when any sync switch changes, with all five as one record (`{ crosshair, time, auto, symbol, period }`).

Symbol search, interval selection, indicator selection and the drawing tools in the shared
toolbar always act on the **active** pane -- there is no cross-pane symbol/interval sync by
design.

## Chart API
Unless noted, every method below acts on the **active pane** -- the one with the coloured
border, which is what "the toolbar acts on" means in a wall.

### getChart()
```typescript
() => Chart | null
```
Get the underlying KLineChart instance for the active pane, or `null` before mount. For a
specific pane regardless of which is active, use `getPane(id)?.getChart()`.

### setTheme(theme)
```typescript
(theme: string) => void
```
Set theme (every pane).

### getTheme()
```typescript
() => string
```
Get theme.

### setStyles(styles)
```typescript
(styles: DeepPartial<Styles>) => void
```
Set core chart styles (every pane -- this is the construction-time-option setter).

### getStyles()
```typescript
() => Styles
```
Get the active pane's core chart styles.

### setLocale(locale)
```typescript
(locale: string) => void
```
Set language.

### getLocale()
```typescript
() => string
```
Get language.

### setTimezone(timezone)
```typescript
(timezone: string) => void
```
Set timezone.

### getTimezone()
```typescript
() => string
```
Get timezone.

### setSymbol(symbol)
```typescript
(symbol: SymbolInfo) => void
```
Set the active pane's symbol.

### getSymbol()
```typescript
() => SymbolInfo
```
Get the active pane's symbol.

### setPeriod(period)
```typescript
(period: Period) => void
```
Set the active pane's period.

### getPeriod()
```typescript
() => Period
```
Get the active pane's period.

### getSlot(name)
```typescript
(name: 'toolbar' | 'rail-footer') => HTMLElement | null
```
An empty anchor element inside the chart shell that a consuming app can mount its own controls
into -- the top-rail toolbar (after the timeframe rail) or the bottom of the left drawing
rail. `null` before mount, and `null` for `'rail-footer'` whenever the drawing rail is hidden
(`drawingBarVisible: false`), since that footer lives inside it. One of each per wall, not per
pane.

### getPanes()
```typescript
() => ChartProPane[]
```
Every currently-live pane (i.e. shown by the active layout preset), in pane order.

### getPane(id)
```typescript
(id: string) => ChartProPane | null
```
A specific pane by id (`'p1'`..`'pN'`), or `null` if it isn't currently live.

### getPaneSnapshots()
```typescript
() => PaneSnapshot[]
```
Plain-data snapshot of every currently-live pane -- symbol, period AND indicators
(`ChartProPane` deliberately omits the latter). Use this when persisting the whole wall.

### getActivePaneId()
```typescript
() => string
```
The active pane's id.

### setActivePane(id)
```typescript
(id: string) => void
```
Activate a specific pane.

### getPaneLayout() / setPaneLayout(id)
```typescript
() => string
(id: string) => void
```
Get/set the current layout preset id.

### getPaneLayouts()
```typescript
() => LayoutPreset[]
```
Every available layout preset, in the order shown by the toolbar's picker.

### remove()
```typescript
() => void
```
Tears down every pane and unmounts the chart.
