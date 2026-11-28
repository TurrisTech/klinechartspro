// The chart's theme, for chrome the app mounts outside the chart's root. The `kc-*` design tokens
// are defined under `.klinecharts-pro.dark` (src/KLineChartPro.ts puts the class on), so a dialog,
// a dockable window or a hint appended to <body> resolves them only if it carries the class
// itself. Each caller reads it as it builds its chrome.

/** The mounted chart's theme class: 'dark', or '' for the light theme. */
export function chartTheme(): string {
  return document.querySelector('.klinecharts-pro.dark') ? 'dark' : ''
}
