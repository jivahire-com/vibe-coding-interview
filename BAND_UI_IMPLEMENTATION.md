# Band UI Implementation Guide

The grading API now ships a **5-band overall-verdict scale**, replacing the old
3-band `strong`/`mixed`/`weak`. All band data is computed server-side and carried
in the report JSON — **the UI does no arithmetic**; it reads keys, labels, and
ranges and renders them. This doc is the contract for building the "Score Ranges"
panel and the "OVERALL VERDICT — WHERE THIS SCORE LANDS" row.

## The bands (single source of truth)

Defined once in [`server/vibe/grader/report.py`](server/vibe/grader/report.py) (`_BANDS`):

| key           | label         | score range   |
|---------------|---------------|---------------|
| `reject`      | Reject        | 0 – 29.99     |
| `weak`        | Weak          | 30 – 49.99    |
| `acceptable`  | Acceptable    | 50 – 69.99    |
| `good`        | Good          | 70 – 89.99    |
| `outstanding` | Outstanding   | 90 – 100      |

The backend resolves a score to a band with `_band(total)`. The UI must **never**
hard-code these thresholds — read them from `report.legend.bands` so the two can
never drift.

## What the API returns

`GET /api/v1/sessions/{id}` → `report` object. The two relevant pieces:

```jsonc
{
  "overall": {
    "score": 72,            // 0–100 integer (already weighted)
    "out_of": 100,
    "band": "good",         // one of the 5 keys above — THE band this score lands in
    "summary_points": [     // "Why this score" bullets, first line names the band
      "72 / 100 overall — a Good result on the vibe coding track.",
      "What lifted it: ...",
      "What held it back: ..."
    ]
  },
  "legend": {
    "verdicts": [ /* per-criterion strong/weak/missing/na — unchanged */ ],
    "bands": [    // ASCENDING order, ready to render top-to-bottom or left-to-right
      { "key": "reject",      "label": "Reject",      "min": 0,  "max": 29.99, "range": "0 – 29.99",  "definition": "Overall score 0 – 29.99." },
      { "key": "weak",        "label": "Weak",        "min": 30, "max": 49.99, "range": "30 – 49.99", "definition": "Overall score 30 – 49.99." },
      { "key": "acceptable",  "label": "Acceptable",  "min": 50, "max": 69.99, "range": "50 – 69.99", "definition": "Overall score 50 – 69.99." },
      { "key": "good",        "label": "Good",        "min": 70, "max": 89.99, "range": "70 – 89.99", "definition": "Overall score 70 – 89.99." },
      { "key": "outstanding", "label": "Outstanding", "min": 90, "max": 100,   "range": "90 – 100",   "definition": "Overall score 90 – 100." }
    ]
  }
}
```

`legend.bands` is already sorted ascending (Reject → Outstanding), matching the
target screenshot. Each entry is self-describing (`label` + `range`), so neither
panel needs a lookup table.

## Component 1 — "Score Ranges" legend panel

A static reference list (right-hand card in the screenshot). Render one row per
`legend.bands` entry: a color dot/swatch keyed by `band.key`, the `band.label`,
and the `band.range` (e.g. `(0 – 29.99)`).

```js
report.legend.bands.map(b => `
  <li class="score-range">
    <span class="band-dot band-${b.key}"></span>
    <span class="band-name">${esc(b.label)}</span>
    <span class="band-range">(${esc(b.range)})</span>
  </li>`).join('')
```

## Component 2 — "OVERALL VERDICT — WHERE THIS SCORE LANDS" row

Same `legend.bands` list, rendered as a horizontal row of boxes (label + range).
Highlight the box whose `key === report.overall.band` and mark it "THIS SCORE".

```js
report.legend.bands.map(b => {
  const here = b.key === report.overall.band;
  return `
    <div class="band-box band-${b.key} ${here ? 'is-current' : ''}">
      <div class="band-box-label">${esc(b.label)}</div>
      <div class="band-box-range">${esc(b.range)}</div>
      ${here ? '<div class="band-box-marker">● THIS SCORE</div>' : ''}
    </div>`;
}).join('')
```

The big score chip (e.g. `72 / 100` + a `Good` pill) reads `overall.score` and
`overall.band`; the pill's color comes from `band-${overall.band}`.

## Suggested CSS (replace the old 3-band colors)

The old palette in [`server/static/style.css`](server/static/style.css) only
defines `--gr-band-strong/mixed/weak`. Replace with the 5 keys:

```css
--band-reject:      #b42318;  /* red    */
--band-weak:        #d97706;  /* orange */
--band-acceptable:  #b7791f;  /* amber  */
--band-good:        #1a7f4b;  /* green  */
--band-outstanding: #2563eb;  /* blue   */

.band-reject      { background: var(--band-reject); }
.band-weak        { background: var(--band-weak); }
.band-acceptable  { background: var(--band-acceptable); }
.band-good        { background: var(--band-good); }
.band-outstanding { background: var(--band-outstanding); }

.band-box.is-current { /* filled highlight, e.g. solid bg + white text */ }
```

## Migration checklist for the UI

- [ ] Build Component 1 (Score Ranges panel) from `report.legend.bands`.
- [ ] Build Component 2 (where-it-lands row) highlighting `report.overall.band`.
- [ ] Replace the old `gr-band` pill renderer in
      [`server/static/app.js`](server/static/app.js) `gradeReportHtml` — it still
      renders a single `strong`/`mixed`/`weak` pill via `.gr-band.${o.band}`,
      whose CSS classes no longer match the new keys.
- [ ] Swap the `--gr-band-*` CSS vars for the 5-key palette above.
- [ ] Update the static reference page
      [`dummy_grading_report.html`](dummy_grading_report.html) (still hard-codes
      `band-mixed`) so it stays an accurate sample.
- [ ] Drive everything off `legend.bands` / `overall.band` — do **not**
      re-derive thresholds in JS.

## Notes

- **Old reports already migrated.** The 5 most recent graded sessions were
  re-banded in place (band + summary + legend) by
  [`scripts/reband_grades.py`](scripts/reband_grades.py) — a no-LLM recompute
  from stored rubric scores. Any session graded from now on uses the new bands
  natively. Sessions older than those 5 still carry the legacy `mixed`/`strong`
  band keys in their stored `report_json`; re-run the script with a higher
  `--limit` (max 5 per run) if more need migrating.
- The **per-criterion verdicts** (`strong`/`weak`/`missing`/`na` in
  `legend.verdicts`) are a *different* scale and are unchanged — keep their
  existing rendering.
