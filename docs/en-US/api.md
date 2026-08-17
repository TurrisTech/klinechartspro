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

    // Chart wall (1-12 panes) -- see "Chart wall" below.
    paneLayout?: string;
    panes?: PaneOptions[];
    maxPanes?: number;
    activePane?: string;
    syncCrosshair?: boolean;
    syncTime?: boolean;
    onPaneLayoutChange?: (layoutId: string, panes: PaneSnapshot[]) => void;
    onActivePaneChange?: (paneId: string) => void;
    onPanesChange?: (panes: ChartProPane[]) => void;
    onSymbolChange?: (paneId: string, symbol: SymbolInfo) => void;
    onPeriodChange?: (paneId: string, period: Period) => void;
    onSyncChange?: (options: { crosshair: boolean; time: boolean }) => void;
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
+ `onPaneLayoutChange` Fired when the layout preset changes, with every currently-visible
  pane's symbol/period/indicators -- the payload to persist if you want the wall to survive a
  reload.
+ `onActivePaneChange` Fired when the active pane changes.
+ `onPanesChange` Fired whenever the LIVE pane set changes -- a pane's chart was just created
  or just destroyed (including every layout grow/shrink). Resync any per-pane external
  behaviour (e.g. price-level overlays) entirely from this callback's argument.
+ `onSymbolChange` / `onPeriodChange` Fired when a specific pane's symbol/period changes,
  whichever pane it was (not necessarily the active one, e.g. via `ChartProPane.setSymbol`).
+ `onSyncChange` Fired when either sync toggle changes.

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
