# Grading Metrics — cpp-thread-safe-cache

First the telemetry we collect, then the rubrics we score on it. Each rubric
lists the exact telemetry it reads, the prompt that produces its data, and its
weight out of 100 (which differs per track).

Every item below is tagged with exactly one **track** value — your final JSON
and UI can use the same three:

- **both** — collected / scored on both tracks
- **vibe coding only** — exists only when an AI assistant is used
- **non-AI coding only** — exists only on the no-AI track

Note: no raw signal is _non-AI coding only_ today. The non-AI track keeps every
**both** item and drops every **vibe coding only** item; the two evidence sources
that change on the non-AI track are listed in section 2C.

---

## 1. Telemetry we collect (raw, no repetition)

**Files explored**
- Source: `file_open {file}`
- Captures: which files were opened
- Track: both

**Time on file**
- Source: `file_focus {file, ms}`
- Captures: dwell time per file
- Track: both

**Typed chars**
- Source: `edit_typed {chars}`
- Captures: code written by hand
- Track: both

**Pasted chars**
- Source: `edit_pasted {chars, suspicious_paste}`
- Captures: pasted code + refocus-paste flag
- Track: both

**Test run**
- Source: `test_run` / `terminal_command {kind:test}`
- Captures: ran the suite
- Track: both

**Build run**
- Source: `terminal_command {kind:build}`
- Captures: compiled
- Track: both

**Install run**
- Source: `terminal_command {kind:install}`
- Captures: installed deps
- Track: both

**Debugger**
- Source: `debug_session`
- Captures: started the debugger
- Track: both

**Window switch**
- Source: `app_unfocused` / `app_focused {time_away_seconds}`
- Captures: focus loss / return
- Track: both

**Protected-file edit**
- Source: `protected_file_edit`
- Captures: touched a `.jivahire/` file
- Track: both

**Commits / reverts**
- Source: `auto_commit` + git history
- Captures: snapshots, resets
- Track: both

**AI accepted**
- Source: `edit_ai_applied {chars, block_id}`
- Captures: accepted an AI edit
- Track: vibe coding only

**AI rejected**
- Source: `edit_ai_rejected {block_id}`
- Captures: dismissed an AI edit
- Track: vibe coding only

**Post-apply edit**
- Source: `post_apply_of` tag on `edit_typed` / `edit_pasted`
- Captures: edited AI code within 90 s of accepting
- Track: vibe coding only

**Chat exchange**
- Source: `chat_exchanges {prompt_text, prompt_tokens, completion_tokens, candidate_prompt_tokens, cost_usd}`
- Captures: each AI prompt + tokens + cost
- Track: vibe coding only

---

## 2. Rubrics — what we score

Each rubric below has a plain-English heading, what **good** and **bad** look
like, the **track** it applies to, its **source** family, its **weight** out of
100 (which differs per track), the exact **telemetry** it reads, and the
**prompt** that produces its data. Grouped by track so it maps straight to the
JSON/UI.

**Every rubric is computed from one of three input families — nothing is outside these:**
- **Telemetry** — the raw event stream in section 1 (this includes git history and the `chat_exchanges` rows).
- **Submission** — the submitted code, the hidden test-runner results, and `NOTES.md`.
- **LLM** — a graded LLM call (a single run at temperature 0 — deterministic, see §3).

The **Source** line on each rubric names which of those families it combines.

**How each rubric reports — one score, then plain-English sub-points.**
Every rubric returns exactly **one** score, 1-10 (the number that takes its
weight in the /100). The sub-points underneath are **not** scored 1-10 — putting
a digit on each one is false precision (no grader can reliably tell a `clarity` 6
from a 7) and forces per-criterion weight bookkeeping for no real gain. Instead,
beneath the single score each sub-point is reported in plain English that anyone
can read:
- **What it checks** — one short sentence naming the single thing this sub-point looks at.
- **Verdict** — one of **strong / weak / missing** (clearer than a bare good/bad: it separates a minor gap from a total miss).
- **What the candidate did** — 1-2 crisp sentences with evidence (line numbers, trap ids, prompt numbers, telemetry sequence numbers).

The one dimension score is the model's holistic 1-10 judgment of the dimension,
informed by those sub-point verdicts — not a weighted sum of per-criterion
numbers. So **Architectural reasoning** shows one score, and under it
`core_mechanism_design`, `why_before_how`, `edge_case_awareness`, and the rest
each say what they check, their strong / weak / missing verdict, and what this
candidate did. Deterministic rubrics (tests, traps, verification discipline, AI
judgment, developer signal, challenge-specific) keep their existing formulas
unchanged; this plain-English shape applies to the LLM-judged rubrics, whose
sub-points are the ones named on their **Prompt** line.

**One scale on the page: the backend converts every score from 1-10 to 0-100.**
The 1-10 above is the *internal* judgment scale — the number each rubric produces,
and the figure the LLM prompts return. The grader does not emit 1-10, though: as
its last step it multiplies every rubric's score by 10 onto a single **0-100**
scale (8.5 becomes 85) and emits that, with `out_of: 100`. The overall total is
the weight-weighted average of those 0-100 rubric grades, using the track's
weights below, and is itself a number out of 100 — so the page reads one
consistent scale everywhere and never does the arithmetic itself. A rubric that
does not apply to the track is emitted with a null score and dropped from both
the average and the /100 denominator. This ×10 conversion is done **once, in the
backend, for every rubric and the total**, so every consumer — the report page,
the recruiter email, any CSV export — shows the same grade out of 100.

**The /100 split — vibe coding (9 rubrics):**
- Tests — 18
- Traps — 11
- Code quality — 13
- Architectural reasoning — 9
- Challenge-specific — 5
- Verification discipline — 12
- AI judgment — 7
- LLM communication — 15
- Developer signal — 10
- Total — 100

**The /100 split — non-AI coding (7 rubrics):**
- Tests — 22
- Traps — 14
- Code quality — 17
- Architectural reasoning — 14
- Challenge-specific — 9
- Verification discipline — 14
- Developer signal — 10
- Total — 100

**Not in either /100 (reported separately):**
- Debugger usage — a bonus that lifts the developer-signal score (which is now in the /100); never its own /100 line, never a penalty.
- Product-sense bonus (the README's optional "go further" task) — a bonus that lifts the architectural-reasoning score; never its own /100 line, never a penalty.

---

### A. Scored on BOTH tracks

**Does the code work?** (tests)
- Track: both
- Source: submission — the hidden test-runner results. No telemetry, no LLM.
- Weight: 18 of 100 on vibe coding, 22 of 100 on non-AI coding.
- Good: passes every hidden check — basic get/put + LRU eviction, thread-safety under concurrency, and the edge cases.
- Bad: tests fail — wrong results, data races, or breakage at the boundaries.
- Telemetry: none — reads the hidden test-runner results (pass/fail per tag: `basic`, `thread_safety` under TSan, `edge_cases`). The `test_run` events feed other rubrics, not this score.
- Prompt: deterministic, no LLM — compile and run the hidden suite in the sandbox; score = weighted fraction of test tags that pass.

**Did they fix the planted bugs?** (traps)
- Track: both
- Source: submission — the hidden test-runner results + `.jivahire/traps.json`. No telemetry, no LLM.
- Weight: 11 of 100 on vibe coding, 14 of 100 on non-AI coding.
- Good: the deliberately planted bugs are caught and fixed.
- Bad: the planted bugs are left in the code.
- Telemetry: none — reads `.jivahire/traps.json` against the runner: each trap's `detection_tag` (`race`, `shared_lock_on_mutating_get`, `off_by_one`, `capacity_zero`) with its severity weight.
- Prompt: deterministic, no LLM — a trap counts as fixed when its detection-tag test passes; score = severity-weighted fraction of traps fixed.

**Is the final code clean and correct?** (code quality)
- Track: both
- Source: submission + LLM — reads the final code + test/trap results, then a graded LLM call.
- Weight: 13 of 100 on vibe coding, 17 of 100 on non-AI coding.
- Good: correct, idiomatic C++, readable, handles edge cases, no new defects.
- Bad: incorrect, awkward, unclear, misses edge cases, or introduces defects.
- Telemetry: none for the score — reads the final submission code, the test results, and the caught/missed trap lists (edit/paste/focus signals are passed only as context).
- Prompt (LLM, run once at temperature 0, deterministic): "You are grading the CODE QUALITY dimension. Given the challenge, test results, caught/missed traps and the candidate code, give ONE overall score 1-10 for code quality. Then, for each of these criteria, return a plain-English verdict of `strong`, `weak`, or `missing` with 1-2 sentences of evidence (line numbers, trap ids, failed tags) — do NOT put a number on individual criteria: `correctness` (does it work — passes tests, fixes traps), `idiomatic` (uses the language the normal way), `clarity` (easy to read, well named), `edge_cases` (handles boundaries and failure), `no_ai_defects` (no new races, hallucinated APIs, leaked secrets, or needless abstractions). Be ruthless about `no_ai_defects`. Respond with JSON only."

**Did they make sound design decisions?** (architectural reasoning)
- Track: both
- Source: submission + telemetry + LLM — final code, plus the "why" from the chat telemetry (vibe coding) or `NOTES.md` + comments + commits (non-AI coding), then a graded LLM call.
- Weight: 9 of 100 on vibe coding, 14 of 100 on non-AI coding.
- Good: weighed trade-offs before coding, got this challenge's core mechanism right (here, lock placement and primitive choice for thread-safety), thought about boundaries, kept it simple.
- Bad: no rationale, the core mechanism is unsafe or missing (here, broken or absent concurrency design), ignores constraints, or over-engineered.
- Telemetry: none for the score — reads the final code + challenge rubric; the "why" evidence is the chat log (vibe coding) or `NOTES.md` + comments + commit messages (non-AI coding).
- Prompt (LLM, run once at temperature 0, deterministic): "You are grading ARCHITECTURAL REASONING — only design decisions the candidate owned, never starter code. You are given the LANGUAGE, the candidate code, and the challenge rubric; infer this challenge's core mechanism from them. Give ONE overall score 1-10 for architectural reasoning. Then, for each criterion, return a verdict of `strong`, `weak`, or `missing` with 1-2 sentences of evidence (line numbers, design choices) — do NOT put a number on individual criteria: `why_before_how` (decided the approach before coding), `algorithm_choice` (picked a sensible algorithm), `data_structure_choice` (picked a sensible data structure), `core_mechanism_design` (got the central hard part of THIS challenge right — e.g. lock placement for a cache, monotonic-time correctness for a TTL, backpressure for a rate limiter), `edge_case_awareness` (thought about boundaries), `constraint_driven` (respected the stated limits), `not_over_engineered` (kept it as simple as the problem needs). Respond with JSON only."

**Did they handle this challenge's specifics?** (challenge-specific)
- Track: both
- Source: submission — a static scan of the submitted code. No telemetry, no LLM.
- Weight: 5 of 100 on vibe coding, 9 of 100 on non-AI coding.
- Good: reaches for the right synchronisation primitive (a mutex) and keeps locking const-correct.
- Bad: no synchronisation, or const inspection methods that won't compile once a mutex is locked.
- Telemetry: none — a static regex scan of the submission file only.
- Prompt: deterministic, no LLM — regex-check the code for `sync_primitive` (`std::mutex` / `std::shared_mutex` present) and `const_correctness` (a `mutable` mutex plus `const` inspector methods); score each.

**Did they check their own work?** (verification discipline)
- Track: both
- Source: telemetry only — deterministic, no LLM.
- Weight: 12 of 100 on vibe coding, 14 of 100 on non-AI coding.
- Good: runs the tests as they go, reviews changes instead of trusting them blindly, and runs the tests once more before submitting.
- Bad: never runs the tests, accepts code without checking, or submits untested.
- Telemetry: `edit_ai_applied {chars, block_id, file}`, `test_run`, `edit_typed {post_apply_of}`, the session `typed_chars` / `ai_applied_chars` counters, and `sessions.submitted_at`. On non-AI coding the apply-keyed signals fall back to `edit_typed` / `edit_pasted` cadence.
- Prompt: deterministic, no LLM — `test_after_apply_ratio` (apply → `test_run` within 90 s, weight 0.40), `apply_then_edit_rate` (apply → `post_apply_of` edit, 0.25), `self_authored_ratio` (typed ÷ (typed + AI), healthy band 0.40–0.70, 0.20), `incremental_apply_pattern` (0.15); the pre-submit floor caps the score at 6.0 unless a `test_run` lands in the 5 min before submit.

**Did they behave like a developer?** (developer signal)
- Track: both
- Source: telemetry — the score is deterministic; the one-sentence verdict summary is a non-scored LLM call.
- Weight: 10 of 100 on vibe coding, 10 of 100 on non-AI coding.
- Scored: yes — exploring the relevant files and running the tests are required signals.
- Good: opens and reads the relevant files, and runs the tests.
- Bad: minimal engagement — barely opens files and never runs tests.
- Telemetry: `file_open {file}` (files explored) and `test_run` (test runs); on vibe coding also `edit_ai_applied` + post-apply `edit_typed` (AI rework) and `chat_exchanges.prompt_text` (prompt specificity).
- Prompt: deterministic, no LLM for the number — on vibe coding the 0-100 score = (files_explored / 5) × 15 + ai_output_modified_ratio × 20 + prompt_specificity × 30 + (test_runs / 3) × 10, plus the debugger bonus below. On non-AI coding, with no AI rework or prompt-specificity to measure, the score is computed from files explored and test runs (rescaled to the full 0-100 range) plus the debugger bonus. That 0-100 score scales to this rubric's weight, and still maps to the verdict developer ≥ 60, uncertain ≥ 35, else non-developer for the report. One LLM sentence summarises the verdict.

**Did they use the debugger?** (debugger usage)
- Track: both
- Source: telemetry only — deterministic, no LLM.
- Weight: bonus only — never its own /100 line. It adds to the developer-signal score, which now carries 10 of 100, so using it lifts that rubric; absence never subtracts.
- Scored: not using it costs nothing, but using it earns the biggest bonus of any developer signal.
- Good: starts the debugger (and uses code navigation) to investigate the problem — rewarded most heavily of all the developer signals.
- Bad: nothing counts as bad here — skipping the debugger carries no penalty.
- Reported: the grading report still states "debugger not used" when it wasn't, purely as an observation, with no effect on the score.
- Telemetry: `debug_session` (used the debugger); reserved `used_goto_definition` / `used_find_references` (not emitted yet).
- Prompt: deterministic, no LLM — +15 to the developer-signal score if any `debug_session` exists (+5 each for go-to-definition / find-references once emitted); absence adds nothing.

**Did they think about the end user?** (product-sense bonus)
- Track: both
- Source: submission + telemetry + LLM — `NOTES.md` + new code/tests, plus the driving chat telemetry (vibe coding), then a graded LLM call.
- Weight: bonus only — never its own /100 line. Like the debugger, it lifts the architectural-reasoning score, so a well-executed bonus can only help; skipping it never subtracts (the README states the bonus is optional and skipping won't lower the score).
- Scored: not attempting it costs nothing, but doing it well earns a high bonus.
- Good: picks a real user or operator need — one of the README's situations (the 2 a.m. on-call page, stale cached answers, silent drop-outs when the cache fills) or a sharper one of their own — builds a thread-safe, tested change for it, and writes a clear `NOTES.md` (who is affected, what changed and why, what they'd do next). On vibe coding, drives the AI well from the fuzzy need to a working, tested change.
- Bad: nothing counts as bad — skipping the bonus carries no penalty.
- Reported: the grading report notes whether the bonus was attempted and how well, purely as an observation.
- Telemetry: a present `NOTES.md` plus new code and tests beyond the core task (new functions / test cases, seen via `auto_commit` + git history); on vibe coding also the `chat_exchanges` that drove the feature.
- Prompt (LLM, run once at temperature 0, deterministic): "You are grading an OPTIONAL product-sense bonus. Given any `NOTES.md`, the candidate's added code and tests beyond the core cache task, and (vibe coding) the chat that drove it, give ONE overall score 1-10 for the bonus. Then, for each of these, return a verdict of `strong`, `weak`, or `missing` with 1-2 sentences of evidence — do NOT put a number on individual criteria: `real_need` (identified a real user/operator need), `justified_choice` (explained why this over alternatives), `thread_safe` (kept any new state safe under concurrency), `proven_by_tests` (showed the new behaviour works with tests). If nothing beyond the core task was attempted, return a neutral note and apply no penalty. Respond with JSON only."

---

### B. Scored on VIBE CODING only

**Did they judge the AI's output?** (AI judgment)
- Track: vibe coding only
- Source: telemetry only — telemetry + git history; deterministic, no LLM.
- Weight: 7 of 100 on vibe coding; not scored on non-AI coding.
- Good: rejects wrong AI suggestions, edits AI code after accepting it, recovers from bad changes.
- Bad: accepts everything the AI produces without question.
- Telemetry: `edit_ai_rejected` (explicit rejections), `edit_ai_applied` + `post_apply_of` (modify-after-apply), trap attribution typed-vs-AI around each fix (hand-fixed traps), git resets / large reverts (recovery events).
- Prompt: deterministic, no LLM — weighted: explicit_rejections 0.30, modify_after_apply 0.30, hand_fixed_traps 0.25, recovery_events 0.15.

**Did they instruct the AI clearly?** (LLM communication)
- Track: vibe coding only
- Source: telemetry + LLM — reads the `chat_exchanges` + timeline telemetry, then a graded LLM call.
- Weight: 15 of 100 on vibe coding; not scored on non-AI coding.
- Good: gives the AI the context it needs, states constraints, breaks work into focused prompts, and gives specific feedback when the AI is wrong.
- Bad: vague one-liners like "fix the bugs" with no context and no follow-up.
- Telemetry: `chat_exchanges {prompt_text, prompt_tokens, completion_tokens, cost_usd}`, the unified timeline (chat + edits + tests with sequence numbers), and total chat tokens vs the challenge's expected budget.
- Prompt (LLM, run once at temperature 0, deterministic): "You are grading LLM COMMUNICATION — how effectively the candidate prompted the AI (prompt-side skill only). Given the numbered chat exchanges, the timeline excerpt, and the token-usage ratio, give ONE overall score 1-10 for communication. Then, for each criterion, return a verdict of `strong`, `weak`, or `missing` with 1-2 sentences citing prompt numbers / sequence numbers — do NOT put a number on individual criteria: `context_framing` (gave the AI the context it needed), `constraint_spec` (stated the constraints), `decomposition` (broke the work into focused prompts), `iterative_refinement` (built on previous answers instead of restarting), `debug_loop` (gave specific feedback when the AI was wrong), `token_discipline` (kept prompts efficient vs the budget). Respond with JSON only."

---

### C. Scored on NON-AI CODING only

No rubric is unique to the non-AI track. It keeps the **both** rubrics
(including developer signal), drops the two **vibe coding only** rubrics
(AI judgment, LLM communication), and re-weights the rest to total 100:

- **Does the code work?** (tests) — 22 of 100
- **Did they fix the planted bugs?** (traps) — 14 of 100
- **Is the final code clean and correct?** (code quality) — 17 of 100
- **Did they make sound design decisions?** (architectural reasoning) — 14 of 100
- **Did they handle this challenge's specifics?** (challenge-specific) — 9 of 100
- **Did they check their own work?** (verification discipline) — 14 of 100
- **Did they behave like a developer?** (developer signal) — 10 of 100

Two evidence sources change on this track:

- **Did they make sound design decisions?** — the "why" is read from `NOTES.md`, code comments, and commit messages instead of a chat log.
- **Did they check their own work?** — the "tested right after a change" signal is read from hand edits (`edit_typed` / `edit_pasted`) instead of AI applies.

Developer signal also changes here: with no AI rework or prompt-specificity to
measure, its 0-100 score is computed from files explored and test runs (rescaled
to the full range) plus the debugger bonus. Debugger usage is reported on this
track too, as a bonus that lifts the developer-signal score — never its own /100
line, never a penalty.

The product-sense bonus is reported on this track too, as a bonus that lifts the
architectural-reasoning score — never its own /100 line, never a penalty. The
README asks candidates to do this one with the AI, so the AI-driving evidence is
vibe-coding only; on non-AI coding it is judged from `NOTES.md` plus the new
code and tests beyond the core task.

---

## 3. How to build it — three layers (telemetry → signals → rubrics)

This is the contract the grader code should follow. The goal is that **no
derived value is ever computed in more than one place**, while rubrics stay free
to read whatever they need. Data flows in one direction through three layers:

```
Telemetry (raw facts)  →  Signals (every derived value, computed once)  →  Rubrics (weights + judgment)
```

**Layer 1 — Telemetry (shared and dumb).**
- Holds only raw facts: the section-1 events, git history, the submitted code, the hidden test-runner results, and the `chat_exchanges` rows.
- No ratios, no flags, no interpretation, no scores. It never knows which rubric will read it.
- Append-only and stored once. Every later layer reads from here and never writes back.

**Layer 2 — Signals (the single interpretation layer).**
- This is the **only** place a derived value is computed. It is today's `_gather_signals` grown up to own *every* derivation. All telemetry processing — whether done directly in code or by an LLM — happens here and nowhere else.
- A "signal" is any named value derived from telemetry: a count, a ratio, a flag, or an LLM-extracted interpretation.
- Two kinds of signals sit side by side, both computed exactly once:
  - **Direct signals** — pure functions of telemetry: `paste_pct`, `ai_applied_pct`, `test_runs`, `files_explored`, `test_after_apply_ratio`, `apply_then_edit_rate`, `self_authored_ratio`, `incremental_apply_pattern`, `prompt_specificity`, `explicit_rejections`, `modify_after_apply`, `hand_fixed_traps`, `recovery_events`, `debug_used`, `window_switches`, `suspicious_pastes`, `total_chat_tokens`.
  - **LLM signals** — interpretations that need a model: the per-prompt `prompt_classification` (vague / specific / professional) and the extracted `design_why` (the rationale pulled from the chat, or from `NOTES.md` + comments + commits on the non-AI track). The LLM call that produces a *reusable* interpretation runs here, once, and its result is cached / persisted like any other signal.
- Rule: a value is named and computed exactly once. If two rubrics need it, they read the **same** signal — neither recomputes it.

**Layer 3 — Rubrics (consumers only).**
- A rubric does three things and nothing else: pick the signals it cares about, apply its weighting, and emit its score plus evidence.
- A rubric never reads the telemetry table directly and never derives a value that another rubric also needs.
- The only LLM call allowed to stay *inside* a rubric is its own final scoring call — the holistic 1-10 judgment for that one dimension (with its plain-English strong / weak / missing sub-point verdicts), unique to that rubric. Any interpretation that two or more rubrics would want is a layer-2 signal instead, not a rubric-local call.
- Adding a rubric is then O(1): declare which signals it reads and its weight. Nothing in the other rubrics moves.

**Why shared reads are fine but shared derivation is not.**
- One signal feeding many rubrics is expected and healthy — e.g. `test_runs` answers a different question for Tests cadence, Verification discipline, and Developer signal. That is one fact, several questions.
- What we forbid is computing the same *interpretation* in two files, which is how two rubrics silently drift apart. Centralising in layer 2 removes that risk while keeping the many-to-many fan-out intact.

**Signal registry for cpp-thread-safe-cache (what each signal derives from, and who reads it).**
- `files_explored` — distinct `file_open` count → Developer signal.
- `test_runs` — `test_run` count → Developer signal, Verification discipline (pre-submit floor).
- `test_after_apply_ratio`, `apply_then_edit_rate`, `self_authored_ratio`, `incremental_apply_pattern` — from applies / edits / tests → Verification discipline.
- `paste_pct`, `suspicious_pastes`, `window_switches` — from edits / focus → Code quality (context only), Developer signal (context).
- `modify_after_apply` — `edit_ai_applied` + `post_apply_of` edits → AI judgment **and** Developer signal (the `ai_output_modified_ratio` it uses today is the same evidence — unify it here so the two rubrics can't diverge).
- `explicit_rejections`, `hand_fixed_traps`, `recovery_events` — from `edit_ai_rejected`, trap attribution, git resets → AI judgment.
- `prompt_specificity` — fraction of prompts using code-specific terms → Developer signal.
- `total_chat_tokens` — summed `chat_exchanges` tokens vs the challenge budget → LLM communication (token discipline).
- `prompt_classification` (LLM) — vague / specific / professional per prompt → surfaced as report badges (not scored today); read by anything that wants it without re-running the call.
- `design_why` (LLM) — rationale extracted from the chat (vibe) or `NOTES.md` + comments + commits (non-AI) → Architectural reasoning, Product-sense bonus.
- `debug_used` — any `debug_session` → Developer signal (bonus).

Two of these are the consolidation wins this layering buys: `prompt_specificity`
(today computed in `developer_signals.py`) and `prompt_classification` (today
re-run inside `llm_eval.py`) both move into layer 2 so the prompt-text
interpretation lives in one place; and `design_why` becomes a real extracted
signal instead of being named in the architectural-reasoning prompt but never
injected.

**Acceptance checklist for the implementation.**
- One signals module owns every derivation; rubric files import from it.
- No rubric queries the telemetry table directly.
- No derived value (direct or LLM) is computed in two files.
- Every LLM interpretation shared by two or more rubrics is a named, cached signal computed once — not a per-rubric call.
- A rubric body only selects signals, applies its weight, and returns its score + evidence.
- Adding or removing a rubric touches only that rubric and the /100 weight table — never the signals layer or the other rubrics.
- Scores are emitted on a 0-100 scale: each rubric's 1-10 judgment is multiplied by 10 once, here in the backend, and the overall total is the weighted average of those 0-100 scores out of 100 — the page receives final numbers and does no arithmetic.

**Generic LLM scoring — one prompt shape for every challenge and language.**
The three LLM-scored rubrics (code quality, architectural reasoning, LLM
communication) never need a backend change when you add a challenge or a
language. Each call is handed the same four things: the **language**, the full
**candidate code**, the **test / trap results**, and a **fixed, universal set of
criteria**. The model infers what "idiomatic" means for that language, and what
the challenge's core mechanism is, from the language tag plus the code — so no
criterion has to name a language or a problem type.

This holds because every scoring criterion is now problem-neutral:
- **Code quality** — `correctness`, `idiomatic`, `clarity`, `edge_cases`, `no_ai_defects`. Already language- and problem-agnostic.
- **LLM communication** — `context_framing`, `constraint_spec`, `decomposition`, `iterative_refinement`, `debug_loop`, `token_discipline`. All about prompting skill, never the problem.
- **Architectural reasoning** — `why_before_how`, `algorithm_choice`, `data_structure_choice`, `core_mechanism_design`, `edge_case_awareness`, `constraint_driven`, `not_over_engineered`. The only criterion that used to break genericity was the old `concurrency_design` (weight 0.25), which assumed every challenge was about locks. It is replaced by `core_mechanism_design` at the same 0.25 weight — "the central hard part of THIS challenge, designed correctly: lock placement for a cache, monotonic-time correctness for a TTL, backpressure for a rate limiter, and so on." Same role, fits any challenge.

Statement: with `core_mechanism_design` in place of `concurrency_design`, the
LLM scoring is fully generic. A new challenge or language changes only
`.jivahire/` data (language, test tags, traps, weights) — never the grader's
prompt code, criteria, or scoring logic.

**LLM scoring runs once at temperature 0 — self-consistency is off.**
Each LLM-scored rubric (code quality, architectural reasoning, LLM
communication, and the product-sense bonus) makes exactly **one** model call at
`temperature: 0`. The config key is `self_consistency_n: 1` in
`grading_config.json`, and the dimension score is that single run's 1-10 (its
sub-point strong / weak / missing verdicts come from the same one call).

- **Why one, not three.** Self-consistency — sampling the model several times and taking the median — only cancels noise when the samples are *diverse*, which needs `temperature > 0`. At `temperature: 0` the decode is greedy, so repeated runs return near-identical scores: extra calls add latency and cost for no real gain in stability. The score is also rubric-driven (fixed criteria and weights), which already pins down what each call may decide.
- **The merge path is unchanged.** The grader still takes the median across runs; the median of a single run is just that run's score, so `n = 1` flows through the same code with no special-casing.
- **How to raise it later.** Increase `self_consistency_n` above 1 **only** together with `temperature > 0` — that is the only setting in which extra runs buy anything. Keep the count odd so the median is unambiguous.

---

## 4. The recruiter summary — one crisp "why" after the total is known

After every rubric has a score and the composite total is computed, the grader
writes one short, recruiter-facing summary. Its only job is to let a recruiter
read three or four sentences and understand **why the score landed where it
did** — without opening the full per-rubric breakdown.

**When it runs.** Last, after the composite step. It is a pure *consumer* of
results that already exist: the composite gives the total plus, per dimension,
its `raw_score`, its `weight`, and its `weighted_contribution`; and each rubric
has already emitted its weakest sub-point and that sub-point's one-line reason.
The summary introduces no new score and no new judgment — it only explains the
numbers already produced. (Same rule as the rubrics in §3: read freely, never
re-derive.)

**What it says — crisp, plain English, no jargon:**
- **Headline** — the composite total (the single number you extract at the end) and the band it falls in (for example strong / mixed / weak), plus the track (vibe coding or non-AI coding).
- **What lifted the score** — the one or two dimensions with the highest weighted contribution, each with the crisp reason already on that rubric (for example "passed 3 of 3 test tags", "clean lock placement and correct primitive").
- **What held it back** — the one or two dimensions that lost the most against their weight, each with that rubric's weakest sub-point reason (for example "missed the capacity-zero trap", "vague prompts with no constraints stated").
- **Bonuses, only if earned** — one clause if the debugger or product-sense bonus lifted a dimension; silent otherwise (a skipped bonus is never mentioned as a negative).

**How it's built.**
- **Deterministic first.** Rank the dimensions by `weighted_contribution`, take the top contributors and the biggest gaps, and stitch their already-computed reasons into a few sentences. This keeps the summary free, reproducible, and defensible — the same inputs always yield the same summary, so a re-grade reads identically.
- **Optional single LLM pass.** If you want it to read like prose instead of a stitched template, send the assembled facts through one call at `temperature: 0` whose only task is to **rephrase** — never to re-score or add a claim that isn't already in the inputs. That is one deterministic call, in line with the self-consistency-off rule above.

**Keep it short.** A few sentences — the line a recruiter reads before deciding
whether to open the full report. It sits *above* the existing per-dimension
breakdown (today's `Label (X/10): reason` line per rubric), which stays exactly
as is; this summary is the one-glance "why", the breakdown is the detail behind
it.

---

## 5. The grading report page — one clear, conclusive layout

The JSON the grader emits and the HTML page that renders it follow one fixed
top-to-bottom order, so a recruiter — or the candidate — can read the page once
and understand the result without this document open beside them.

**Read top to bottom:**
- **Overall score and summary, at the very top.** The composite total out of 100 (the weighted average of the rubric scores, each shown on the same 0-100 scale), the band it falls in (strong, mixed, weak), the track (vibe coding or non-AI coding), and the §4 recruiter summary — all before any rubric detail. This is the first, and often only, thing a recruiter reads.
- **Then the rubrics — every rubric, always, in two labelled sections.** The engineering set (tests, traps, code quality, architectural reasoning, verification discipline, developer signal, challenge-specific) in one section; the vibe set (AI judgment and LLM communication — the §2B rubrics) in the other. The layout is identical for both tracks — nothing is added or removed between them. On a non-AI submission the vibe rubrics are still shown, each marked **N/A** (does not apply to this track) rather than dropped; on a vibe submission every rubric applies, so none is N/A. One fixed shape means a reader never wonders whether a missing section was an oversight. This is a per-rubric *applies-to-this-track* flag in the JSON, not a layout change — the same page renders it.
- **N/A is never a penalty.** A rubric marked N/A contributes nothing and is left out of the /100 denominator — the total is computed only from the rubrics that apply to the track, with that track's weights. N/A must read differently from a low score and from the **missing** verdict: **N/A** means the rubric does not apply to this track, **missing** means it applies but the candidate didn't do it, and a real **0** means it applies and scored zero. The page should make those three distinct at a glance.
- **Then all telemetry in one place.** The full event catalogue from section 1 sits in a single section (collapsed by default is fine), never scattered under each rubric. Like the rubrics, the whole catalogue is always shown: the vibe-only streams (AI-applied edits, AI rejections, the `chat_exchanges` rows) appear as **N/A** on a non-AI report instead of vanishing, so the telemetry section keeps one fixed shape too. One place to audit the facts, kept separate from the scoring.

**Every definition ships in the JSON and renders in the UI — not only in this document.**
The page has to be self-explanatory, so the meaning of every rubric, every
verdict, and every sub-point travels with the data instead of living only here:
- Each rubric carries its own plain-English **Good** and **Bad** definition — the same one-line "what good looks like / what bad looks like" written on that rubric in section 2 — shown right next to the rubric's score. The reader sees what was expected of this dimension *before* reading how the candidate did, so the score never arrives without a yardstick.
- Each rubric's JSON carries, for each sub-point, its **What it checks** sentence and its **strong / weak / missing** verdict, so the UI shows the plain-English description right next to the verdict (inline, or as a tooltip).
- The page shows one short, fixed **legend** — strong means done well, weak means partially done or with gaps, missing means applicable but not done, and N/A means the rubric does not apply to this track — so a first-time reader needs no training to read a verdict.
- A colour or icon may reinforce the verdict, but the word and its definition are always shown; a verdict is never a bare colour.

**The result is one conclusive page.** Score and "why" at the top, the two
rubric sections beneath it with every sub-point explained in place, and the raw
telemetry underneath for anyone who wants to audit — nothing on the page needs an
external key to be understood. The same shape renders for every submission, vibe
or non-AI, with N/A standing in wherever a rubric or signal doesn't apply to the
track.
