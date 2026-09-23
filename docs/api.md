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

    // 应用自定义指标，见下方"应用自定义指标"一节。
    indicatorGroups?: IndicatorGroup[];
    indicatorParamsValidator?: IndicatorParamsValidator | null;
    indicatorSettingsHandler?: IndicatorSettingsHandler | null;
    indicatorSettingsOwned?: ((indicatorName: string) => boolean) | null;

    // 多图布局（1-12 个子图），见下方"多图布局"一节。
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

## 应用自定义指标
应用若注册了自己的指标模板（klinecharts 的 `registerIndicator`），可以把它们列入指标选择对话框、用只有应用自己掌握的信息校验其参数，或完全接管其设置界面。以下三个选项均可省略；省略时指标选择对话框与指标设置对话框的行为与原来完全一致。相关类型均由本包导出。

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

+ `indicatorGroups` 指标选择对话框中额外的指标分组，默认 `[]`。每个分组按数组顺序各占一栏，排在内置的主图指标与副图指标之后，栏目标题即 `label` 原文（不是 i18n 键）。`main: true` 表示该组指标添加到主图（K线图所在面板），`false` 表示每个指标各占一个副图。每一项是一个复选框，在**激活子图**上添加或移除指标模板 `name`（必须是已注册的模板名）；`label` 为复选框文字，`description` 为鼠标悬停提示。同一个 `label` 也用作指标管理器中该指标所在行的标题。分组的 `label` 之间不可重复，同一分组内的 `name` 也不可重复（对话框以它们作为列表的键）。仅在构造时读取一次，没有对应的 setter
+ `indicatorParamsValidator` 校验内置指标设置对话框中的参数；该对话框的输入项来自 `registerIndicatorSettings(name, settings)`（与 `KLineChartPro` 一同导出；未注册输入项的模板打开的对话框中没有输入项）。默认 `null`：不做任何校验，任何参数组合都可以确认。在该对话框中仅在其打开期间调用——打开时调用一次，此后每次修改后再调用，去抖 300 ms——且只采用最新一次的结果：针对用户随后又改动过的参数的结果，以及在对话框关闭后才返回的结果，都会被丢弃。`calcParams` 为对话框中的当前值：数字，或用户清空的输入项对应的 `''`（确认时该项会被替换为参数默认值，但校验函数收到的是 `''`）。`symbol` 与 `period` 取自该指标所在的子图，不一定是激活子图。返回结果对对话框的影响：
  - 校验进行期间（从对话框打开或某次修改起，直到这次结果返回）确认按钮不可用；
  - `ok: false` 时确认按钮保持不可用，若提供了 `reason` 则作为错误信息显示；
  - 未显示 `reason` 时（`ok: true`，或 `ok: false` 且无 `reason`），`hint` 作为提示显示；
  - Promise 被拒绝视同没有结果：不显示任何信息，确认按钮可用——服务端不可达时也不会锁死对话框

  指标管理器中展开的参数行也会调用它：每提交一个输入项（回车、离开输入框或点击步进按钮）就以该子图的 `symbol` 与 `period` 调用一次，不去抖；`All` 列的输入项对每个持有该指标的子图各调用一次。此时 `calcParams` 为将要应用的完整参数（空输入项已替换为默认值），`ok: false` 时该子图不应用，并在该行下显示 `reason`；`ok: true` 时 `hint` 作为该输入项的提示文字（`title`）；Promise 被拒绝同样视同没有结果，照常应用
+ `indicatorSettingsHandler` 由应用接管指标的设置界面。默认 `null`：所有指标都使用内置设置对话框。用户在任一子图中点击指标提示栏上的设置按钮时、内置对话框打开之前同步调用。`paneId` 为多图布局中的子图（`'p1'`..`'pN'`），`chartPaneId` 为该子图内部的 klinecharts 面板（主图指标为 `'candle_pane'`），`calcParams` 为该指标当前参数的副本。应用已为该指标打开自己的界面时返回 `true`：内置对话框不会打开（因此也不会调用 `indicatorParamsValidator`），库也不再做任何处理——应用自己的界面所做的修改由应用负责应用与持久化。返回 `false` 则照常打开内置对话框。返回值会被立即按真假判断，因此必须返回布尔值而不是 Promise：Promise 会被视为 `true`
+ `indicatorSettingsOwned` 告诉指标管理器哪些指标的设置界面由 `indicatorSettingsHandler` 打开。默认 `null`：没有。指标管理器展开一行时调用；返回 `true` 的指标不显示参数输入项——那样会绕过应用自己的界面——而是在每个持有它的子图下显示一个设置按钮，点击后先关闭指标管理器，再以该子图调用 `indicatorSettingsHandler`，与点击指标提示栏上的设置按钮相同。只应对 `indicatorSettingsHandler` 会返回 `true` 的模板返回 `true`，且本身不得打开任何界面

## 多图布局
1 到 12 个子图（"pane"）组成可配置的网格，共用一套工具栏，作用于当前**激活**的子图（带彩色边框），支持十字光标联动和点击跳转日期。完全向后兼容：不传入以下任何选项时，行为与单图表完全一致。

+ `paneLayout` 布局预设 id，默认 `'1'`（单图表）。完整预设列表见 `getPaneLayouts()`（`'1'`、`'2h'`、`'2v'`、`'3h'`、`'3v'`、`'3-left'`、`'3-top'`、`'4'`、`'4h'`、`'4v'`、`'6'`、`'6v'`、`'8'`、`'9'`、`'12'`），也可打开工具栏的布局选择器查看
+ `panes` 各子图的初始配置（`{ symbol, period?, mainIndicators?, subIndicators? }[]`）。缺省时，`paneLayout` 隐含的每个子图都会克隆顶层的 `symbol`/`period`/`mainIndicators`/`subIndicators`，之后可分别改标
+ `maxPanes` 子图数量上限，默认 `12`
+ `activePane` 初始激活的子图（`'p1'`..`'pN'`），默认 `'p1'`
+ `syncCrosshair` / `syncTime` 两个联动开关（工具栏的 Sync 弹出面板）的初始状态，均默认 `true`
+ `syncAuto` 弹出面板旁的自动时间联动按钮的初始状态，默认 `false`。开启时每个子图都跟随正在被平移/缩放的那一个，点击滚动（`syncTime`）随之失效
+ `syncSymbol` / `syncPeriod` 工具栏中标的联动与周期联动按钮的初始状态，均默认 `false`。开启时每个可见子图都显示**激活子图**的标的/周期：开启的瞬间即对齐整面墙，布局增加的新子图同样对齐，被改动的每个子图都会通过 `onSymbolChange`/`onPeriodChange` 上报；关闭后子图停留在原处，不会恢复此前显示的内容
+ `onPaneLayoutChange` 布局预设改变时触发，携带当前可见的每个子图的标的/周期/指标——如需让多图布局在刷新后保留，持久化的就是这份数据
+ `onActivePaneChange` 激活子图改变时触发
+ `onPaneStateChange` 其它回调都不覆盖的子图变化时触发：指标的增加、删除或参数修改，以及（在手势结束后去抖触发的）平移、缩放和手动缩放价格轴。参数只有子图 id，请重新读取 `getPaneSnapshots()`——其中的 `indicatorParams`（指标模板名 -> `calcParams`）与 `view`（`barSpace`、是否跟随最新K线、定位用的时间锚点与屏幕比例、y 轴类型/反转及手动价格区间）足以完整还原一个子图，回填到 `panes[].indicatorParams` / `panes[].view` 即可
+ `onPanesChange` 当前存活的子图集合发生变化时触发——某个子图的图表刚创建或刚销毁（包括每一次布局的增减）。任何依赖单个子图的外部逻辑（如价格关键位叠加层）都应完全依据此回调的参数重新绑定
+ `onSymbolChange` / `onPeriodChange` 某个具体子图的标的/周期改变时触发，不一定是当前激活的子图（例如通过 `ChartProPane.setSymbol` 触发）
+ `onSyncChange` 任一联动开关改变时触发，参数是五个开关的完整状态（`{ crosshair, time, auto, symbol, period }`）

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
