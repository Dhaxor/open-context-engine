// Crisp, dependency-free SVG icon set (codicon-style line icons, themed via currentColor).
// One source of truth shared by the static HTML and the dynamic client renderers.

const INNER: Record<string, string> = {
  send: '<path d="M8 13V3.5M8 3.5 4 7.5M8 3.5l4 4"/>',
  stop: '<rect x="4" y="4" width="8" height="8" rx="1.5" fill="currentColor" stroke="none"/>',
  add: '<path d="M8 3.25v9.5M3.25 8h9.5"/>',
  close: '<path d="M4 4l8 8M12 4l-8 8"/>',
  chevron: '<path d="M6 4l4 4-4 4"/>',
  chevronDown: '<path d="M4 6l4 4 4-4"/>',
  check: '<path d="M3.5 8.5l3 3 6-7"/>',
  search: '<circle cx="7" cy="7" r="3.75"/><path d="M10 10l3.25 3.25"/>',
  sparkle: '<path d="M8 1.75l1.5 4.75L14 8l-4.5 1.5L8 14.25 6.5 9.5 2 8l4.5-1.5z" fill="currentColor" stroke="none"/>',
  gear: '<path d="M6.7 7.5l-2.5 2.5M2 8h3M4.2 4.2l2 2.6"/><path d="M8 2v3M11.8 4.2l-2 2.6M14 8h-3M11.8 11.8l-2.5-2.8M8 14v-3M4.2 11.8l2.3-2.6"/><circle cx="8" cy="8" r="2"/>',
  history: '<circle cx="8" cy="8" r="5.5"/><path d="M8 5v3l2 1.5"/>',
  account: '<circle cx="8" cy="5.5" r="2.5"/><path d="M3.5 13.5a4.5 4.5 0 0 1 9 0"/>',
  repos: '<rect x="2.5" y="5.5" width="8" height="7" rx="1"/><path d="M5 5.5V4a1 1 0 0 1 1-1h6a1 1 0 0 1 1 1v6a1 1 0 0 1-1 1h-1.5"/>',
  folder: '<path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z"/>',
  copy: '<rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.2"/><path d="M3 10.5V3.5a1 1 0 0 1 1-1h6"/>',
  insert: '<path d="M8 2.5v7M5 6.5l3 3 3-3M3.5 13.5h9"/>',
  undo: '<path d="M5 5L2.5 7.5 5 10"/><path d="M2.5 7.5H10a3.5 3.5 0 0 1 0 7H7"/>',
  redo: '<path d="M11 5l2.5 2.5L11 10"/><path d="M13.5 7.5H6a3.5 3.5 0 0 0 0 7h3"/>',
  open: '<path d="M9 3h4v4M13 3L7.5 8.5"/><path d="M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5"/>',
  trash: '<path d="M3 4.5h10M6 4.5V3h4v1.5M5 4.5l.5 8.5h5L11 4.5"/>',
  lock: '<rect x="3.5" y="7" width="9" height="6" rx="1.2"/><path d="M5.5 7V5.2a2.5 2.5 0 0 1 5 0V7"/>',
  diff: '<path d="M4 2.5v6M4 11v2.5M4 8.5a1.5 1.5 0 1 0 0 1 1.5 1.5 0 0 0 0-1zM12 13.5v-6M12 5V2.5M12 7.5a1.5 1.5 0 1 0 0 1 1.5 1.5 0 0 0 0-1z"/>',
  dot: '<circle cx="8" cy="8" r="3" fill="currentColor" stroke="none"/>',
  warning: '<path d="M8 2.5l6 10.5H2z"/><path d="M8 6.5v3M8 11.2v.1"/>',
};

/** Return an inline SVG icon string. `cls` adds extra classes (e.g. accent colors). */
export function icon(name: keyof typeof INNER | string, cls = ""): string {
  const inner = INNER[name as string] || INNER.dot;
  return `<svg class="ic ${cls}" width="16" height="16" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${inner}</svg>`;
}

/** Icon set exposed to dynamic renderers. */
export const ICONS = INNER;
