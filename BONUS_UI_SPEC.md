# Bonus (Optional Extension) — Recruiter UI Specification

How `recruiter.jivahire.com` should render the optional real-world extension
("bonus") that a candidate may complete on top of the core challenge.

Status: proposed. Owner: grading/dashboard. Backend support: **shipped** — see
the `bonus` object on the session-details payload (`_extract_bonus` in
[server/vibe/sessions.py](server/vibe/sessions.py)).

---

## 1. Goal

A recruiter must be able to tell, at a glance and **on every graded session**,
whether the candidate attempted the optional extension and how well they did it —
without opening the raw grade JSON. The card is **always rendered** (it never
silently disappears), because "did not attempt" is itself a signal worth showing.

The bonus is **additive and never penalising** (per the challenge README): a blank
bonus must never read as a negative. The UI must reflect that tone.

---

## 2. Data source

`GET /api/v1/interviews/sessions/{id}` now returns a top-level `bonus` object.
It is **always present**, regardless of grading state.

```jsonc
"bonus": {
  "status": "completed",        // "completed" | "not_attempted" | "not_offered" | "pending"
  "boost": 1.0,                 // points added to the challenge-specific dimension (0..1.5)
  "max_boost": 1.5,
  "reason": "NOTES.md write-up present; evidence of a new feature (counter/callback/TTL)",
  "signals": [
    { "key": "notes",        "label": "NOTES.md write-up explaining who/what/why",                 "met": true,  "points": 0.5 },
    { "key": "new_feature",  "label": "New feature beyond the starter (metrics / eviction callback / TTL)", "met": true,  "points": 0.5 },
    { "key": "synchronized", "label": "New shared state is synchronised (thread-safe)",             "met": false, "points": 0.5 }
  ],
  "evidence": {               // raw heuristic flags, for the "details" disclosure
    "has_notes": true,
    "new_feature": true,
    "has_atomic": false,
    "has_callback": true
  }
}
```

**Field contract**

| field | type | UI use |
|---|---|---|
| `status` | enum | Selects which of the four card states to render (§4). The **only** field the top-level layout switches on. |
| `boost` | number | The headline number: "+1.0 / 1.5 pts". |
| `max_boost` | number | Denominator for the headline + progress meter. |
| `reason` | string | One-line plain-English summary under the header. May be empty. |
| `signals[]` | array | The checklist (§5). Render in array order; do **not** sort. |
| `signals[].met` | bool | Check vs. empty-circle icon. |
| `signals[].points` | number | Shown as a muted "+0.5" suffix per row. |
| `evidence` | object | Behind a collapsed "Detection details" disclosure; for technical reviewers only. |

The frontend must treat unknown `status` values as `pending` (forward-compatible),
and tolerate a missing `bonus` key (older payloads) by rendering the `pending`
state. Never throw on a malformed bonus object.

---

## 3. Placement

- **Candidate / session detail page**, in the score breakdown column.
- Render the bonus card **directly beneath the "Challenge-specific" dimension row**,
  since the boost is applied to that dimension (weight 5%). Visually nest/indent it
  so the causal link reads ("this bonus fed that score").
- In the **session list / table** view, add a compact pill in the row (§6) so a
  recruiter scanning many candidates can spot extension-completers without
  drilling in.

Do **not** put it among the core dimensions as if it were a separate graded axis —
it is a modifier on Challenge-specific, not a ninth dimension.

---

## 4. Card states

One card, four mutually-exclusive states keyed off `status`. All states share the
header `Optional extension` with a small "bonus" tag and an info tooltip:

> "An optional, real-world feature the candidate could add on top of the core task.
> It only ever adds points — skipping it never lowers a score."

### 4a. `completed`
The headline state.

```
┌─ Optional extension  ⓘ ───────────────── +1.0 / 1.5 pts ─┐
│  ▰▰▰▰▰▰▰▱▱▱  (meter: boost / max_boost)                  │
│  NOTES.md write-up present; evidence of a new feature.   │  ← reason
│                                                          │
│  ✓ NOTES.md write-up explaining who/what/why      +0.5   │
│  ✓ New feature beyond the starter (metrics/…)     +0.5   │
│  ○ New shared state is synchronised (thread-safe) +0.5   │  ← unmet shown muted
│                                                          │
│  ▸ Detection details                                     │  ← collapsed disclosure
└──────────────────────────────────────────────────────────┘
```

- Accent colour: **positive / green**. Headline `+{boost} / {max_boost} pts`.
- Progress meter fills `boost / max_boost`.
- Met signals: filled check, full-opacity text. Unmet: empty circle, muted text
  (NOT red — an unmet bonus sub-criterion is "not earned", never "wrong").

### 4b. `not_attempted`
Offered, candidate didn't take it.

- Neutral/grey accent, **not** red or warning.
- Headline: `Not attempted` (no number, or `+0 / 1.5`).
- Body copy: "This candidate focused on the core task. The optional extension was
  available and skipping it did not affect the score."
- Signals list collapsed by default (all empty circles); expandable.

### 4c. `not_offered`
This challenge defines no optional extension.

- Render a minimal, muted card: "No optional extension for this challenge."
- Rationale for still rendering (vs. hiding): a recruiter comparing candidates
  across challenges should see *why* a bonus is absent rather than wonder if it
  failed to load. If product prefers a denser dashboard, this is the one state
  permitted to collapse to a single muted line.

### 4d. `pending`
Not graded yet (grading in progress, or grade row absent).

- Skeleton/loading treatment with copy "Bonus evaluated after grading completes."
- If the surrounding grade panel already shows a global "grading in progress"
  state, the bonus card should match it (shared skeleton), not show its own spinner.

---

## 5. Signals checklist

- Render every entry in `signals[]`, **in order**, one row each:
  `«icon»  «label» ……… «+points»`
- `met: true` → filled check icon, default text colour.
- `met: false` → outline circle, muted text. Never red.
- The `+points` suffix is muted and right-aligned.
- The checklist is the primary explanation; `reason` is the one-line summary above
  it. They are intentionally redundant — keep both.

`evidence` is for the **"Detection details"** disclosure only (collapsed by
default). Render it as a small key/value list of the raw flags
(`has_notes`, `new_feature`, `has_atomic`, `has_callback`) with ✓ / ✗. Label it
"Heuristic flags (automated detection)" so reviewers know these are mechanical,
not the LLM's judgement.

---

## 6. Session-list pill (compact)

In the sessions table, derive a one-glance pill from `status`:

| status | pill | colour |
|---|---|---|
| `completed` | `Bonus +{boost}` | green |
| `not_attempted` | `No bonus` | grey/muted |
| `not_offered` | *(no pill)* | — |
| `pending` | `Bonus …` | skeleton |

The pill is sortable/filterable: recruiters should be able to filter the list to
"completed the extension".

---

## 7. Behaviour & accessibility

- **Tone guard:** nothing in the bonus card may use error/danger styling. The
  strongest negative permitted is neutral-muted. This is a hard rule — the bonus
  is explicitly non-penalising and mis-styling it as a failure would mislead.
- **Loading:** while the session payload is in flight, show the `pending` skeleton.
- **Number formatting:** `boost`/`max_boost` shown to one decimal (`+1.0 / 1.5`).
  If `boost` is an integer-valued float, still show one decimal for consistency.
- **a11y:** the meter needs `role="meter"` with `aria-valuenow={boost}` /
  `aria-valuemax={max_boost}`. Each signal row announces met/unmet via text, not
  colour alone (the icon + visually-hidden "met"/"not met" label).
- **Tooltip parity:** reuse the existing dimension-tooltip component used for the
  "Challenge-specific" row so the bonus info icon matches house style.

---

## 8. Known limitation to surface (product decision)

The `synchronized` signal and its `+0.5` are gated on the automated detector
finding `std::atomic` (see `_thread_safe_cache_bonus` in
[server/vibe/grader/challenge_specific.py](server/vibe/grader/challenge_specific.py)).
A submission that synchronises new shared state with a **mutex** instead of
`std::atomic` is equally correct but currently scores `synchronized: false` and
loses that 0.5. The reference solution in
[challenges/cpp-thread-safe-cache](challenges/cpp-thread-safe-cache) does exactly
this (mutex-guarded counters).

Until the heuristic is broadened, the UI should:
- Keep the "Heuristic flags (automated detection)" framing on `evidence`, and
- Lean on `reason` + the LLM-graded dimensions as the authoritative read of
  extension quality, treating the boost as a coarse indicator only.

(Recommended backend follow-up: also credit a `mutable std::mutex` guarding the new
counters as "synchronised". Tracked separately from this UI work.)

---

## 9. Acceptance criteria

1. Bonus card renders for **every** graded session and never throws on a missing
   or malformed `bonus` object.
2. Each of the four `status` values renders its specified state; unknown status →
   `pending`.
3. No part of the card uses error/danger styling.
4. Headline matches `boost`/`max_boost`; meter fill matches the ratio.
5. Signals render in payload order with correct met/unmet icons and `+points`.
6. `evidence` is hidden behind a collapsed disclosure, labelled as automated.
7. Session-list pill matches the §6 table and is filterable.
8. Meter and signal rows meet the a11y requirements in §7.
