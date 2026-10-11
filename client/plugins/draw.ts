// Drawing constants shared by the plugins' templates.

/** klinecharts pads an indicator pane's y-axis by 20% above and 10% below its data range,
 * which is sized for a candle pane (room for the legend, and for a price line to sit off the
 * top). A pane whose range is already bounded either side by flat threshold lines spends
 * most of that on empty pane; this gives it half -- enough that the top line clears the
 * legend row. Registry rows carry their own `axisGap`; this is the default the panes that
 * are not registry-driven use. */
export const AXIS_GAP = { top: 0.1, bottom: 0.05 }
