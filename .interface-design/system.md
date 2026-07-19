# Open Context Engine — interface design system

## Direction
"The instrument, not the brochure." An editor at night: the site inherits the
CLI's own world — terminal session as hero, chunk labels on sections, evidence
over adjectives. Dark-only, committed.

## Tokens (web/oce.css)
- Surfaces (one hue, lightness steps only): `--void #0a0d12` page · `--panel #10151c` · `--lift #161c25` · `--overlay #1b222d`
- Edges: `--edge rgba(219,230,242,.08)` · `--edge-hi .16`
- Ink (4 tiers): `--ink #e8edf4` · `--ink-2 #a8b3c0` · `--ink-3 #6e7a88` · `--ink-4 #48525e`
- The one accent: `--prompt #45c4e9` (+ `--prompt-dim` 12% fill). ~10% of any view.
- Semantic only: `--ok #3fb950` · `--warn #e3b341` · `--del #f47067`

## Type
IBM Plex Sans (body/headings) + IBM Plex Mono (labels, metrics, terminal).
Scale 1.25 from 15.5px: 12 / 13.5 / 15.5 / 18 / 22 / 28 / 40 / display clamp(38–56).
Headings tracked −0.016…−0.022em. Dynamic numbers always `tabular-nums`.
Weight+color do hierarchy at equal sizes (mono labels: 11px ink-3 tracked).

## Depth strategy
Borders-only (hairline `--edge`), elevation by surface lightness. The single
exception: the hero terminal gets one soft drop (`0 24px 48px -24px`).
Radius scale: 6 / 10 / 14. Spacing: 8px grid (`--s1…--s16`), site width 1104px.

## Signature elements (reuse these)
- Terminal window (`.term`): titlebar `--lift`, body 13px mono 1.85, colors t-p/t-ok/t-dim/t-faint, blinking `.t-caret`.
- Chunk label (`.chunk`): `// path:line` + cyan `.score` badge — every section header.
- Ranked results list (`.result`): rank number · title · desc · score column.
- Hash-chain divider (`.hashchain`): mono shas joined by hairlines.
- Plan spec-sheet (`.plan`): mono uppercase tier, 34px mono price + sans `em`
  annotation, `→` spec lists (`.hl` = cyan arrow), mono fineprint.
- Wordmark `oce` + blinking block caret.

## Motion
420ms reveal (opacity + 10px rise), ease `cubic-bezier(.23,1,.32,1)`, 60ms
stagger. Progressive enhancement: hidden state exists only under
`html.js-reveal` (JS adds it) — no-JS/crawlers always see content.
Press feedback `scale(.97)`. `prefers-reduced-motion` kills movement + carets.

## Content voice
Evidence-dense, no adjectives-as-claims: real metrics (recall@10 0.977, 251ms,
450 tests), real commands, real session output. Sentence case. The dim third
headline line ("Nothing leaves the machine.") is the brand move — restraint
as confidence.
