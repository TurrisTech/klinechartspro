# API

## 创建图表对象
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

    // 多图布局（1-12 个子图），见下方"多图布局"一节。
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
+ `container` 容器id或者容器
+ `styles` 核心图表样式（作用于所有子图）
+ `watermark` 水印（作用于所有子图；传入 Node 时每个子图各自克隆一份，不会共享同一节点）
+ `theme` 主题（作用于所有子图）
+ `locale` 语言类型
+ `drawingBarVisible` 是否显示画线工具栏
+ `symbol` 第一个子图的标的。当传入 `panes` 时此项仍为必填，但会被忽略
+ `period` 第一个子图的周期。当传入 `panes` 时此项仍为必填，但会被忽略
+ `periods` 所有周期，所有子图共用
+ `starredPeriods` 顶部周期条上常驻显示的 `Period.text` 集合，其余的收纳在下拉菜单中
+ `onStarredPeriodsChange` 每次收藏/取消收藏周期时触发，供调用方持久化
+ `timezone` 时区
+ `mainIndicators` 第一个子图（或 `panes` 缺省时 `paneLayout` 隐含的所有子图）的主图指标
+ `subIndicators` 副图指标，取值规则同 `mainIndicators`
+ `datafeed` 数据接入api实现。当多图布局中子图数大于一、且该实现保有任何按订阅维度的状态时（绝大多数真实实现都是如此），应传入工厂函数 `(paneId) => Datafeed`——共享同一实例仅在该实现完全无状态时才安全，库会在检测到潜在风险时于构造阶段打印一次警告

## 多图布局
1 到 12 个子图（"pane"）组成可配置的网格，共用一套工具栏，作用于当前**激活**的子图（带彩色边框），支持十字光标联动和点击跳转日期。完全向后兼容：不传入以下任何选项时，行为与单图表完全一致。

+ `paneLayout` 布局预设 id，默认 `'1'`（单图表）。完整预设列表见 `getPaneLayouts()`（`'1'`、`'2h'`、`'2v'`、`'3h'`、`'3v'`、`'3-left'`、`'3-top'`、`'4'`、`'4h'`、`'4v'`、`'6'`、`'6v'`、`'8'`、`'9'`、`'12'`），也可打开工具栏的布局选择器查看
+ `panes` 各子图的初始配置（`{ symbol, period?, mainIndicators?, subIndicators? }[]`）。缺省时，`paneLayout` 隐含的每个子图都会克隆顶层的 `symbol`/`period`/`mainIndicators`/`subIndicators`，之后可分别改标
+ `maxPanes` 子图数量上限，默认 `12`
+ `activePane` 初始激活的子图（`'p1'`..`'pN'`），默认 `'p1'`
+ `syncCrosshair` / `syncTime` 两个联动开关（工具栏的 Sync 弹出面板）的初始状态，均默认 `true`
+ `onPaneLayoutChange` 布局预设改变时触发，携带当前可见的每个子图的标的/周期/指标——如需让多图布局在刷新后保留，持久化的就是这份数据
+ `onActivePaneChange` 激活子图改变时触发
+ `onPanesChange` 当前存活的子图集合发生变化时触发——某个子图的图表刚创建或刚销毁（包括每一次布局的增减）。任何依赖单个子图的外部逻辑（如价格关键位叠加层）都应完全依据此回调的参数重新绑定
+ `onSymbolChange` / `onPeriodChange` 某个具体子图的标的/周期改变时触发，不一定是当前激活的子图（例如通过 `ChartProPane.setSymbol` 触发）
+ `onSyncChange` 任一联动开关改变时触发

工具栏中的标的搜索、周期选择、指标选择与画线工具，始终作用于**激活**的子图——按设计不提供跨子图的标的/周期联动。

## 图表API
除特别说明外，以下方法均作用于**激活的子图**——即带彩色边框的那一个，这也是"工具栏作用于当前子图"在多图布局下的含义。

### getChart()
```typescript
() => Chart | null
```
获取激活子图底层的 KLineChart 实例，挂载完成前为 `null`。若需获取指定子图（不论是否激活），使用 `getPane(id)?.getChart()`。

### setTheme(theme)
```typescript
(theme: string) => void
```
设置主题（所有子图）

### getTheme()
```typescript
() => string
```
获取主题

### setStyles(styles)
```typescript
(styles: DeepPartial<Styles>) => void
```
设置核心图表样式（所有子图——这是构造期 `styles` 选项对应的 setter）

### getStyles()
```typescript
() => Styles
```
获取激活子图的核心图表样式

### setLocale(locale)
```typescript
(locale: string) => void
```
设置语言

### getLocale()
```typescript
() => string
```
获取语言

### setTimezone(timezone)
```typescript
(timezone: string) => void
```
设置时区

### getTimezone()
```typescript
() => string
```
获取时区

### setSymbol(symbol)
```typescript
(symbol: SymbolInfo) => void
```
设置激活子图的标的

### getSymbol()
```typescript
() => SymbolInfo
```
获取激活子图的标的

### setPeriod(period)
```typescript
(period: Period) => void
```
设置激活子图的周期

### getPeriod()
```typescript
() => Period
```
获取激活子图的周期

### getSlot(name)
```typescript
(name: 'toolbar' | 'rail-footer') => HTMLElement | null
```
图表外壳中一个空的挂载点，供调用方挂载自定义控件——顶部工具栏（周期条之后）或左侧画线工具栏底部。挂载完成前为 `null`；画线工具栏隐藏时（`drawingBarVisible: false`）`'rail-footer'` 也为 `null`，因为该挂载点位于画线工具栏内部。每个多图布局仅有一份，不按子图区分。

### getPanes()
```typescript
() => ChartProPane[]
```
当前布局预设下所有存活的子图，按子图顺序排列

### getPane(id)
```typescript
(id: string) => ChartProPane | null
```
按 id（`'p1'`..`'pN'`）获取指定子图，若当前不存在则为 `null`

### getPaneSnapshots()
```typescript
() => PaneSnapshot[]
```
所有存活子图的纯数据快照——标的、周期以及指标（`ChartProPane` 特意不包含指标信息）。持久化整个多图布局时应使用此方法。

### getActivePaneId()
```typescript
() => string
```
当前激活子图的 id

### setActivePane(id)
```typescript
(id: string) => void
```
激活指定子图

### getPaneLayout() / setPaneLayout(id)
```typescript
() => string
(id: string) => void
```
获取/设置当前布局预设 id

### getPaneLayouts()
```typescript
() => LayoutPreset[]
```
所有可用的布局预设，顺序与工具栏选择器中一致

### remove()
```typescript
() => void
```
销毁所有子图并卸载图表
