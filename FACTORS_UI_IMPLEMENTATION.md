# Overall Factors UI Implementation Guide

The grading API now ships a single, recruiter-facing list of **factors** under
`overall.factors`. Each factor is a plain-language card with a **green/red flag**,
a short headline, and a one-line explanation. A non-technical recruiter should be
able to skim these top-to-bottom and decide whether to move a candidate forward —
no scores to interpret, no jargon.

Everything is computed server-side in
[`server/vibe/grader/report.py`](server/vibe/grader/report.py) (`_factors`). **The
UI does no logic** — it reads `status`, `label`, `summary`, `description` and
renders them. The old `overall.summary_points` array has been **removed**; its
content is now the first factor (`key: "overall"`).

## What the API returns

`GET /api/v1/sessions/{id}` → `report.overall.factors`:

```jsonc
{
  "overall": {
    "score": 58,
    "out_of": 100,
    "band": "acceptable",
    "factors": [
      {
        "key": "overall",
        "label": "Overall result",
        "status": "good",                       // green
        "summary": "58/100 — Acceptable",
        "description": "Strong enough to move forward. Strongest on tests; weakest on code quality."
      },
      {
        "key": "tests",
        "label": "Tests",
        "status": "bad",                         // red
        "summary": "3/4 tests passed",
        "description": "1 of 4 tests failed."
      },
      {
        "key": "code_quality",
        "label": "Does the code work",
        "status": "good",
        "summary": "Code quality 64/100",
        "description": "The code works and is cleanly written."
      },
      {
        "key": "readme_time",
        "label": "Read the instructions",
        "status": "bad",
        "summary": "README not opened",
        "description": "Never opened the README — may not have read the task."
      },
      {
        "key": "review_alerts",
        "label": "Review alerts",
        "status": "bad",
        "summary": "2 things to check",
        "items": [                               // <- only this factor has `items`
          "Telemetry tampering detected — the session record was altered, so the signals below may not be trustworthy.",
          "Did not behave like a developer — did not build the project or run the tests as a real developer would."
        ],
        "description": "Things a reviewer should look at before deciding."
      },
      {
        "key": "compiled",
        "label": "Code compiled",
        "status": "good",
        "summary": "Compiled successfully",
        "description": "The submitted code built without errors."
      },
      {
        "key": "ai_collaboration",
        "label": "AI collaboration",
        "status": "bad",
        "summary": "AI teamwork 40/100",
        "description": "Worked with the AI but the collaboration was weak."
      }
    ]
  }
}
```

## Factor schema (the contract)

Every factor has the same four fields; `review_alerts` and `tests` add one more.

| field         | type              | meaning |
|---------------|-------------------|---------|
| `key`         | string            | Stable id. Use to pick an icon; never display raw. |
| `label`       | string            | Card title, plain words. Render as-is. |
| `status`      | `"good"`\|`"bad"` | The flag. `good` → green, `bad` → red. Drives all coloring. |
| `summary`     | string            | Bold one-line headline (the "value"). |
| `description` | string            | Sub-line, one sentence. May be `""`. |
| `items`       | `string[]`        | **`review_alerts` and `tests` only.** One bullet per alert (review_alerts) or per hidden test (tests). Empty `[]` when none. |

### The factors and their order

The array is **already in display order** — render it in sequence, do not sort.

| # | `key`              | `label`                | Green (`good`) when… | Always present? |
|---|--------------------|------------------------|----------------------|-----------------|
| 1 | `overall`          | Overall result         | score ≥ 50 (Acceptable+) | yes |
| 2 | `tests`            | Tests                  | every test passed | yes |
| 3 | `code_quality`     | Does the code work     | code quality ≥ 50/100 | yes |
| 4 | `readme_time`      | Read the instructions  | spent ≥ 60s in the README | yes |
| 5 | `review_alerts`    | Review alerts          | no alerts (`items` empty) | yes |
| 6 | `compiled`         | Code compiled          | the code built | yes |
| 7 | `ai_collaboration` | AI collaboration       | AI teamwork ≥ 50/100 | **vibe track only** |

> **Don't hard-code the list.** Iterate over whatever `overall.factors` contains.
> `ai_collaboration` is omitted on the non-AI track, and more factors may be added
> later. Keying off `status` + the four common fields makes the UI forward-compatible.

## Rendering rules

1. **`status` is the only thing that decides color.** Map `good → green`,
   `bad → red`. Never re-derive a flag from `summary`/`score` on the client.
2. **Factors with `items` (`review_alerts`, `tests`) render them as a bullet
   list** under the `summary`. For every other factor, show `summary` (bold) +
   `description` (muted). When `items` is empty
   the card is green ("No red flags") — still render it so a clean session reads
   as reassuringly green rather than absent.
3. **`description` can be empty** — guard with `factor.description && (...)`.
4. **No client math.** All counts ("3/4 tests passed"), scores, and times are
   pre-formatted in `summary`/`description`.

## Drop-in React component

Matches the existing dashboard styling (Tailwind, `text-size-*`, slate/red
palette). Replaces both the old `RedFlagsStrip` *and* the "Why this score"
`summary_points` block — `review_alerts` covers the alerts, `overall` covers the
verdict.

```jsx
const TONE = {
  good: {
    card: "border-emerald-200 bg-emerald-50",
    dot:  "bg-emerald-500",
    title: "text-emerald-900",
    text: "text-emerald-800",
  },
  bad: {
    card: "border-red-200 bg-red-50",
    dot:  "bg-red-500",
    title: "text-red-900",
    text: "text-red-800",
  },
};

const FactorCard = ({ factor }) => {
  const t = TONE[factor.status] ?? TONE.bad;
  return (
    <div className={`rounded-xl border p-4 ${t.card}`}>
      <div className="flex items-center gap-2">
        <span className={`h-2.5 w-2.5 rounded-full ${t.dot}`} aria-hidden />
        <p className={`text-size-sm font-bold ${t.title}`}>{factor.label}</p>
        <span className={`ml-auto text-size-xs font-semibold ${t.text}`}>
          {factor.summary}
        </span>
      </div>

      {/* review_alerts: one bullet per alert; everything else: a single sub-line */}
      {factor.items ? (
        factor.items.length ? (
          <ul className={`mt-2 text-size-xs list-disc pl-4 space-y-0.5 ${t.text}`}>
            {factor.items.map((it, i) => <li key={i}>{it}</li>)}
          </ul>
        ) : (
          <p className={`mt-2 text-size-xs ${t.text}`}>{factor.description}</p>
        )
      ) : factor.description ? (
        <p className={`mt-2 text-size-xs ${t.text}`}>{factor.description}</p>
      ) : null}
    </div>
  );
};

const OverallFactors = ({ overall }) => {
  const factors = overall?.factors ?? [];
  if (!factors.length) return null;
  return (
    <section className="space-y-2">
      <h2 className="text-size-sm font-bold text-slate-900 mb-2">At a glance</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {factors.map((f) => <FactorCard key={f.key} factor={f} />)}
      </div>
    </section>
  );
};
```

Usage:

```jsx
<OverallFactors overall={report.overall} />
```

## Accessibility

- Color is not the only signal — each card carries a `label`, `summary`, and the
  green/red text already differs in wording, so screen-reader users get the
  verdict without relying on the dot. Keep the colored dot `aria-hidden`.
- For an explicit cue you can prefix the title with `✓` / `!` based on `status`.

## Migration notes

- **`overall.summary_points` is removed.** Any "Why this score" block that read it
  should render the `overall` factor (`factors[0]`) instead — same information,
  plain language.
- **`RedFlagsStrip` is superseded** by the `review_alerts` factor. Its three old
  inputs map directly: `meta.telemetry_tampered`, `meta.no_show`, and the
  non-developer developer-signal verdict are now pre-merged into
  `review_alerts.items` server-side, so the client no longer needs
  `getTelemetryRedFlags` / `getDeveloperSignalVerdict`.
- Already-graded sessions only gain `factors` after they are re-graded (or rebanded
  via [`scripts/reband_grades.py`](scripts/reband_grades.py), which now regenerates
  the `overall` factor in place).
- The legacy [`BAND_UI_IMPLEMENTATION.md`](BAND_UI_IMPLEMENTATION.md) still shows
  `summary_points` in its example JSON — that field is gone; the band legend
  (`report.legend.bands`) it documents is unchanged and still valid.
