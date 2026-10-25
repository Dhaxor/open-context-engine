# Open Context Engine — interface design system

Surfaces sharing one direction: the marketing site (`web/`) and **Trace**, the
agent workspace — which renders as a browser app (`src/trace/studio/`), a
terminal app (`src/trace/tui/`), and a desktop shell (`desktop/`). Same world,
different jobs; the site argues, the workspace works.

**One view model, three renderers.** `src/trace/view-model.ts` folds the
TraceEvent stream into state; Studio and the TUI both reduce with it. Turn
grouping, streamed-text coalescing, the approval lifecycle, and reconnect
behaviour are decided once. A discrepancy between surfaces has to be a
rendering bug, never a logic one — and the whole fold is testable in Node.

## Direction
"The instrument, not the brochure." An editor at night: the product inherits the
CLI's own world — terminal session as hero, chunk labels on sections, evidence
over adjectives. Dark-only, committed.

## Tokens
**Trace is the source of truth: `src/trace/tokens.ts`.** It generates the
`:root` block that `build-studio.js` inlines into the Studio shell, and it maps
the same values to 24-bit ANSI for the TUI. One file, two renderers — there is
no second copy of a colour anywhere. `web/oce.css` predates it and holds the
same values by hand; keep them in step.

- Surfaces (one hue, lightness steps only): `--void #0a0d12` page · `--panel #10151c` · `--lift #161c25` · `--overlay #1b222d`
- Edges: `--edge rgba(219,230,242,.08)` · `--edge-hi .16` · `--edge-faint .05`
- Ink (4 tiers): `--ink #e8edf4` · `--ink-2 #a8b3c0` · `--ink-3 #6e7a88` · `--ink-4 #48525e`
- The one accent: `--prompt #45c4e9` (+ `--prompt-dim` 12% fill). ~10% of any view.
- Semantic only: `--ok #3fb950` · `--warn #e3b341` · `--del #f47067`
- **Score ramp** (`--score-0…4`): `#45c4e9 · #3fa9cc · #358ead · #2c748f · #245a70`.
  One hue, falling luminance. A rainbow would read as five categories; this
  reads as one scale. `scoreColor(n)` is the only way to pick a step.
- **Context buckets**: retrieval takes the live accent because it is the bucket
  a user can act on; files/history/system/tools recede into surface tones.

`src/trace/tokens.test.ts` enforces the rules mechanically — one hue across
surfaces, monotonic ramps, hairline-only borders, every `var()` in the
stylesheet declared, and no hex literal in the CSS.

## Type
IBM Plex Sans (body) + IBM Plex Mono (labels, metrics, paths, terminal).
- Site: 1.25 from 15.5px.
- **Trace: 1.25 from 13px** — 11 / 12 / 13 / 14 / 16 / 18 / 22 / 28. A workbench
  is denser than a page. Weight + colour carry hierarchy at equal sizes.
- Headings tracked −0.016…−0.022em. Every dynamic number is `tabular-nums`.

## Depth strategy
Borders-only (hairline `--edge`), elevation by surface lightness. Two exceptions,
both earned: the site's hero terminal gets one soft drop, and Trace's command
palette gets `0 24px 48px -24px` because it genuinely floats.
Radius scale 6 / 10 / 14. Spacing on an 8px grid. Site width 1104px.

## Trace layout — proportions are the argument
`44px | minmax(0,1fr) | 320px`, with the status bar spanning `1 / -1`.
- **44px spine**: a gutter, subordinate — a margin note about time.
- **320px rail**: near-peer with the transcript, because the claim of this
  product is that the evidence matters as much as the answer.
- Both the grid row and the transcript column are `minmax(0, …)`. Grid tracks
  default to min-content, so one long code line will otherwise widen the whole
  shell instead of scrolling inside its own `<pre>`.

## Signature elements (reuse these)
**Trace**
- **Evidence rail** (`.rail`): segmented budget meter + legend, then ranked
  `.chunk` rows — score (tabular, ramp-coloured) · 22px meter · path:lines ·
  pin/evict on hover. `.edge-chip` under a row names the graph edge that pulled
  it in, with direction preserved ("called by" ≠ "calls").
- **Spine** (`.spine`): hash-chain shas as a vertical timeline. 7px dot, 44px
  hit target, `data-current` / `data-restorable`.
- **Retrieval readout** (`.readout`): replaces the spinner —
  `⟐ retrieved 5 · top 0.94 · graph +2 · 251ms`, plus a `keyword-only` warning
  when ranking is degraded and `−n dropped` when the packer cut results.
- **Patch card** (`.patch`): head with risk score + caller count, diff body
  (`+++`/`---` are `meta`, never add/rem), y/always/n footer with the primary
  focused on mount.
- **Status bar**: model · tokens · chunks/mode · branch · spacer · context · ⌘K · audit ✓ sha · live.
- **Session switcher** (`.sessions`): parallel sessions stack at the TOP of the
  spine, separated from the timeline by a rule. Two different axes — which
  conversation, and when within it — sharing a gutter but not a run of dots.
  Each chip carries the branch initial, a dot while running, and a count of
  files changed: the questions you actually have about a session you are not
  watching. 26px chip, 44px target. The highlighted chip is what THIS window
  shows, not what the server calls active.
- **Sub-agent block** (`.subagent`): a delegation, indented behind a rule,
  quieter than the main thread. Open while it runs — silence is the complaint —
  and collapsed on completion, when the report matters more than the search.
  Nested answers step down one type tier so the main thread stays dominant.

**TUI** (`src/trace/tui/`) — the same five zones, at a terminal's proportions
- Layout `[5 gutter][transcript][34 rail]`, header above, composer + status below.
  The rail appears at ≥100 columns and is togglable with ctrl+r down to 60.
- The spine compresses to a 5-column gutter: the checkpoint sha printed beside
  the prompt that opened its turn, accent-coloured on the current turn.
- Score ramp and budget meter carry over exactly — the meter is drawn with `█`
  runs in bucket colours, the scores use the same five cyan steps.
- Truecolor when `COLORTERM` says so, the 16-colour palette otherwise, nothing
  under `NO_COLOR` / a pipe / `TERM=dumb`.

**Site**
- Terminal window (`.term`), chunk label (`.chunk`), ranked results (`.result`),
  hash-chain divider (`.hashchain`), plan spec-sheet (`.plan`), wordmark `oce`.

## Component measurements
- `.btn` — 32px min-height · 6/12 padding · 6px radius · 11px · `scale(.97)` active
- `.icon-btn` — 20px glyph, hit area extended to 40px with `::after { inset:-10px }`
- `.chunk` — 5px vertical padding · 27px score column · 22px meter · faint rule
- `.chunk-score` / any score — always `toFixed(2)`, so the column never reflows
- Token counts — one rule everywhere (`format.ts: tokens()`), rounded *before*
  the unit is chosen so 9,950 and 10,000 do not render at different widths

## Motion
Trace: 180ms popovers, 220ms panels, ease `cubic-bezier(.23,1,.32,1)`, 40ms
stagger. The transcript stream itself does not animate — it is watched a hundred
times a day. Site: 420ms reveal, 60ms stagger, progressive enhancement so no-JS
always sees content. Press feedback `scale(.97)`. `prefers-reduced-motion` kills
movement and carets everywhere.

## Content voice
Evidence-dense, no adjectives-as-claims: real metrics (recall@10 0.977, 251ms,
450 tests), real commands, real session output. Sentence case. Empty states say
what the panel is *for*, not that it is empty.

## Hard-won details
- Serve Studio assets with `no-cache` + ETag **and** stamp the bundle URLs with a
  content hash. Stable filenames plus any positive `max-age` means an upgraded
  `oce` can serve a new API to a cached Studio — which presents as mysteriously
  missing data, not as an error.
- A fresh subscriber must receive session state **and** the whole retained
  buffer. Anything less shows an empty transcript beside a "live" badge.
- Flex children in a status bar need `min-width: 0`; otherwise the bar is what
  scrolls the page.
- Every TUI frame line is padded to exactly the terminal width. That single
  invariant is what makes row-diffed redraw safe: a shorter line can never leave
  the tail of a longer one behind, which is the usual cause of a terminal UI
  that slowly fills with debris. Resize discards the frame cache and repaints,
  so "resize the window to fix the rendering" is the repair path rather than a
  workaround for one.
- Style helpers are bound arrow properties, not prototype methods. Renderers
  naturally write `const c = warn ? theme.warn : theme.ink3`, and an unbound
  method throws at call time.
- Never restore a desktop window onto a display that is no longer attached —
  opening off-screen is indistinguishable from failing to start.
- Notify on exactly three things: an approval is waiting, a turn finished while
  the window was in the background, or an error. Notifying on progress teaches
  people to ignore the app.
- Switching session clears the view model completely. Everything is
  per-session, the cursor included; carrying any of it across splices two
  conversations into one transcript.
- A sub-agent's work never touches the context ledger. The child works in its
  own window, and counting it would make the rail lie about the main thread's.
