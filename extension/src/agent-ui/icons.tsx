import * as React from "react";

/** Codicon-style 16px line icons, themed by currentColor. Constant markup only. */
const PATHS: Record<string, React.ReactNode> = {
  send: <path d="M8 13V3.5M8 3.5 4 7.5M8 3.5l4 4" />,
  stop: <rect x="4.5" y="4.5" width="7" height="7" rx="1.5" fill="currentColor" stroke="none" />,
  add: <path d="M8 3.25v9.5M3.25 8h9.5" />,
  close: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  chevron: <path d="M6 4l4 4-4 4" />,
  check: <path d="M3.5 8.5l3 3 6-7" />,
  search: <><circle cx="7" cy="7" r="3.75" /><path d="M10 10l3.25 3.25" /></>,
  file: <path d="M4 2.5h5l3 3v8H4zM9 2.5v3h3" />,
  folder: <path d="M2 4.5a1 1 0 0 1 1-1h3l1.5 1.5H13a1 1 0 0 1 1 1v5.5a1 1 0 0 1-1 1H3a1 1 0 0 1-1-1z" />,
  list: <path d="M5.5 4.5h8M5.5 8h8M5.5 11.5h8M2.5 4.5h.5M2.5 8h.5M2.5 11.5h.5" />,
  symbol: <path d="M5.5 3.5 2.5 8l3 4.5M10.5 3.5l3 4.5-3 4.5" />,
  terminal: <><rect x="2" y="3" width="12" height="10" rx="1.5" /><path d="M4.5 6.5 6.5 8l-2 1.5M8 10h3" /></>,
  globe: <><circle cx="8" cy="8" r="5.5" /><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.5 2.3 5.5S9.6 11.9 8 13.5C6.4 11.9 5.7 10 5.7 8S6.4 4.1 8 2.5z" /></>,
  edit: <path d="M10.5 3 13 5.5 6 12.5H3.5V10z" />,
  plus: <path d="M8 4v8M4 8h8" />,
  trash: <path d="M3 4.5h10M6 4.5V3h4v1.5M5 4.5l.5 8.5h5L11 4.5" />,
  robot: <><rect x="3" y="5" width="10" height="8" rx="2" /><path d="M8 2.5V5M6 8.5h.01M10 8.5h.01M6.5 11h3" /></>,
  history: <><circle cx="8" cy="8" r="5.5" /><path d="M8 5v3l2 1.5" /></>,
  rewind: <><path d="M3 4v3.5h3.5" /><path d="M3.4 7.2A5 5 0 1 1 4.5 11.5" /></>,
  undo: <><path d="M5 5L2.5 7.5 5 10" /><path d="M2.5 7.5H10a3.5 3.5 0 0 1 0 7H7" /></>,
  redo: <><path d="M11 5l2.5 2.5L11 10" /><path d="M13.5 7.5H6a3.5 3.5 0 0 0 0 7h3" /></>,
  diff: <><rect x="2.5" y="2.5" width="11" height="11" rx="1.5" /><path d="M8 2.5v11M4.25 7h2M5.25 6v2M9.75 7h2" /></>,
  open: <><path d="M9 3h4v4M13 3L7.5 8.5" /><path d="M12 9.5V12a1 1 0 0 1-1 1H4a1 1 0 0 1-1-1V5a1 1 0 0 1 1-1h2.5" /></>,
  branch: <><circle cx="4.5" cy="3.5" r="1.5" /><circle cx="4.5" cy="12.5" r="1.5" /><circle cx="11.5" cy="5" r="1.5" /><path d="M4.5 5v6M11.5 6.5c0 2.5-3 2.5-6.2 4.5" /></>,
  pin: <path d="M6 2.5h4l-.5 4 2 2v1H4.5v-1l2-2zM8 9.5v4" />,
  eject: <path d="M4.5 4.5l7 7M11.5 4.5l-7 7" />,
  restore: <><path d="M3 4v3.5h3.5" /><path d="M3.4 7.2A5 5 0 1 1 4.5 11.5" /></>,
  copy: <><rect x="5.5" y="5.5" width="7.5" height="7.5" rx="1.2" /><path d="M3 10.5V3.5a1 1 0 0 1 1-1h6" /></>,
  sparkle: <path d="M8 1.75l1.5 4.75L14 8l-4.5 1.5L8 14.25 6.5 9.5 2 8l4.5-1.5z" fill="currentColor" stroke="none" />,
  warning: <><path d="M8 2.5l6 10.5H2z" /><path d="M8 6.5v3M8 11.2v.1" /></>,
  key: <><circle cx="5.5" cy="10.5" r="3" /><path d="M7.7 8.3 13 3M11 5l1.5 1.5" /></>,
  layers: <path d="M8 2.5 14 6 8 9.5 2 6zM2 9l6 3.5L14 9" />,
  circle: <circle cx="8" cy="8" r="4.5" />,
  dot: <circle cx="8" cy="8" r="2.5" fill="currentColor" stroke="none" />,
  hand: <path d="M5.5 8V3.5a1 1 0 0 1 2 0V7M7.5 7V2.5a1 1 0 0 1 2 0V7M9.5 7V3.5a1 1 0 0 1 2 0V9c0 2.5-1.5 4.5-4 4.5-1.8 0-2.7-.8-3.5-2l-1.5-2.5a1 1 0 0 1 1.7-1L5.5 9" />,
  gear: <><circle cx="8" cy="8" r="2" /><path d="M8 1.75v2M8 12.25v2M1.75 8h2M12.25 8h2M3.6 3.6l1.4 1.4M11 11l1.4 1.4M3.6 12.4 5 11M11 5l1.4-1.4" /></>,
};

export type IconName = keyof typeof PATHS;

export function Icon({ name, className, title }: { name: IconName; className?: string; title?: string }) {
  return (
    <svg
      className={`ic${className ? ` ${className}` : ""}`}
      width="16" height="16" viewBox="0 0 16 16" fill="none"
      stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round"
      aria-hidden={title ? undefined : true}
      role={title ? "img" : undefined}
    >
      {title && <title>{title}</title>}
      {PATHS[name] ?? PATHS.dot}
    </svg>
  );
}

export function Spinner({ className }: { className?: string }) {
  return <span className={`spinner${className ? ` ${className}` : ""}`} aria-label="working" role="status" />;
}
