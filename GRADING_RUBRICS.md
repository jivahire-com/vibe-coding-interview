# Vibe Coding Interview — Grading Rubrics

> **Philosophy:** The best engineers in 2026 aren't those who refuse AI. They're the ones who use it strategically — knowing when to prompt, when to reject, when to refactor, and when to write from scratch. These rubrics evaluate *AI orchestration skill*, not just code output.
>
> **The core thesis of vibe coding:** A great vibe coder is not someone who prompts a lot. It's someone who (1) communicates precisely because they understand LLMs are stateless pattern matchers that need explicit context, (2) verifies ruthlessly because they know AI hallucinates and the only ground truth is running tests, (3) exercises judgment because they understand the problem well enough to know when AI is wrong, and (4) ships fast because all of the above means fewer iterations, fewer bugs, faster delivery.

---

## How Grading Works

Each session is graded in four stages:

1. **Automated** — hidden tests and planted trap detection run against the candidate's final commit
2. **Telemetry-derived** — verification cadence, judgment signals, and self-authored ratio are computed deterministically from the session event stream
3. **LLM Evaluation** — structured AI evaluations assess interpretive quality dimensions (code quality, communication, architecture)
4. **Understanding Verification** — post-submit video where the candidate answers code-specific questions auto-generated from their own submission. This is a **pass/fail gate**, not a weight.

The composite is computed from stages 1–3, then the Understanding Verification gate is applied as a multiplier.

---

## Composite Score Formula

| Dimension | Weight | Source |
|---|---|---|
| Hidden test pass rate | 20% | Automated |
| Trap detection (with attribution) | 12% | Automated + telemetry attribution |
| Verification Discipline | 13% | Telemetry-derived |
| AI Judgment & Rejection | 8% | Telemetry-derived + LLM |
| LLM Communication | 17% | LLM (structured sub-scores) |
| Code Quality | 15% | LLM |
| Architectural Reasoning | 10% | LLM |
| Challenge-specific bonus | 5% | Per-rubric |
| **Subtotal** | **100%** | |
| **Understanding Verification** | **Gate** | Video + LLM-graded — fail caps composite at 5.0 |

Net split: **~45% automated/telemetry** (ungameable by prompting) **+ ~50% LLM-evaluated** + **~5% challenge-specific**, with a hard pass/fail gate against ghost-candidate fraud.

**Formula:**

```
raw_score = (tests_passed / tests_total × 10) × 0.20
          + (traps_detected / traps_total × 10) × 0.12
          + verification_discipline_score      × 0.13
          + ai_judgment_score                  × 0.08
          + llm_communication_score            × 0.17
          + code_quality_score                 × 0.15
          + architectural_reasoning_score      × 0.10
          + challenge_specific_score           × 0.05

if understanding_verification_passed:
    total_score = raw_score
else:
    total_score = min(raw_score, 5.0)
```

All sub-scores are on a **1–10 scale**. The composite result is out of **10**.

---

## Reliability Requirements for LLM-Evaluated Dimensions

Every LLM-evaluated dimension must satisfy these constraints — otherwise the composite is not defensible to a hiring committee:

1. **Structured JSON output only.** Each evaluator returns per-criterion sub-scores plus reasoning. The dimension score is computed as a deterministic weighted sum of sub-scores, never a freeform 1–10.
2. **Median of 3 calls.** Every LLM dimension runs three times at temperature 0; the dimension score is the median. A single noisy call cannot decide a hire.
3. **No score without reasoning.** Each criterion must include a 1–2 sentence justification citing specific evidence (line numbers, prompt indices, telemetry events). Recruiters see this reasoning verbatim.
4. **Evaluator model pinned.** Use GPT-4o-mini or equivalent. Pin the exact model + version in `grading_config.json`. Re-grading must use the same version.

---

## Automated Grading (32% of composite)

### Hidden Test Suite (20%)

Candidates see and can run the *public* tests included in the repo. The grader re-runs a separate *hidden* test suite covering additional edge cases, concurrency correctness, and security scenarios. Each test is tagged; the grader records which tags pass.

### Trap Detection with Attribution (12%)

Every challenge repo has **planted bugs** — intentional defects in the starter code. `.jivahire/traps.json` defines each trap and the test tag that reveals whether it was fixed. Traps are unannounced to candidates; detecting and fixing them requires careful code review.

**Attribution.** For each fixed trap the grader classifies the fix as:

| Class | Detection | Signal |
|---|---|---|
| `hand-fixed` | Fix lines authored via direct typing (telemetry `typed` events) | Strongest positive — candidate read the code |
| `ai-fixed-reviewed` | Fix lines from AI apply, candidate then made semantic edits | Positive — candidate validated the fix |
| `ai-fixed-blind` | Fix lines from AI apply with no follow-up edits | Neutral — credit for outcome only |

Trap points are awarded fully regardless of attribution, but the attribution mix is surfaced in the recruiter UI and feeds the AI Judgment & Rejection dimension.

---

## Telemetry-Derived Grading (21% of composite)

These dimensions are computed deterministically from the session telemetry stream. They measure **behavior**, not output, and cannot be gamed by prompting.

### Verification Discipline (13%)

**What it proves:** The candidate treats AI output as untrusted input that must be verified. This is the single biggest differentiator between someone who ships bugs and someone who ships working code.

**Signals (all telemetry-derived):**

| Signal | Computation | Score Impact |
|---|---|---|
| Test-after-apply ratio | `(ai_apply followed by test run within 90s) / (total ai_apply)` | >0.80 → 9–10; 0.50–0.80 → 6–8; <0.30 → 1–3 |
| Apply-then-edit rate | Fraction of AI applies followed by candidate edits before commit | Strong positive contributor |
| Self-authored ratio | Typed lines / (typed + AI-applied) lines, after deletions | Healthy band: 0.40–0.70. Outside this band reduces score. |
| Pre-submit test run | At least one test run within 5 min before submission | Required floor for any score ≥7 |
| Time on broken tests | Fraction of active session with ≥1 failing test never re-run | High value reduces score |
| Incremental apply pattern | AI applies in small pieces with tests between | Better than one massive block |

**Scoring scale:**

| Score | Behavior |
|---|---|
| 9–10 | Every AI suggestion is tested before moving on. Manual edits after apply show review. Pre-submit run is green. Self-authored ratio in healthy band. |
| 7–8 | Tests most AI suggestions. Occasional skip on trivial changes. Pre-submit run present. |
| 5–6 | Tests some. Ships some untested AI code but catches issues later. |
| 3–4 | Rarely tests AI output. Long stretches with broken tests unrun. |
| 1–2 | Never runs tests between AI suggestions. Submits without a final test run. |

### AI Judgment & Rejection (8%)

**What it proves:** The candidate has enough understanding to recognize when AI gives incorrect, insecure, or suboptimal code — and can fix it themselves or guide the AI to fix it. This is the "can they disagree with the model" signal.

**Signals:**

| Signal | How Detected | Why It Matters |
|---|---|---|
| Explicit rejection | `ai_apply_rejected` telemetry event | They evaluated and decided "no" |
| Modify-after-apply (semantic) | Edit distance ≥ 30% of AI-applied block, whitespace-normalized | Cosmetic edits don't count — must be a real change |
| Correction prompts | Follow-up prompt cites a specific defect ("that's wrong because X; instead do Y") — detected by an LLM sub-evaluator | They diagnosed the error rather than re-asking the same question |
| Independent fix | Rejected suggestion → candidate writes correct code manually | They don't depend on AI when it fails |
| Hand-fixed traps | Trap fix attributed to `hand-fixed` (see Trap Attribution above) | Strongest signal of independent code comprehension |
| Recovery events | Large reverts or `git reset` after a bad AI direction | One or two = healthy course-correction; zero often = never noticed |

**Scoring scale:**

| Score | Behavior |
|---|---|
| 9–10 | At least one explicit rejection with a correction-prompt follow-up. ≥1 hand-fixed trap. Semantic modify-after-apply present. |
| 7–8 | At least one disagreement with AI documented in prompts. Some semantic edits to AI output. |
| 5–6 | Mostly accepts AI output. Catches issues via testing rather than review. |
| 3–4 | Accepts nearly everything. Rarely modifies AI output beyond cosmetic changes. |
| 1–2 | Zero evidence of critical thinking. Every AI response accepted verbatim. No reverts even after observable test failures. |

**Anti-gaming.** The semantic-edit threshold (≥30% of applied block, whitespace-normalized) prevents candidates from theatrically rejecting one suggestion or making cosmetic edits to capture the signal. Hand-fixed traps and correction prompts are weighted higher than raw rejection counts.

---

## LLM Evaluations (42% of composite)

### LLM Communication (17%)

**What it proves:** The candidate understands how LLMs work and communicates accordingly. This dimension **replaces the previous separate Prompt Quality and Token Efficiency dimensions** — they were double-counting prompt precision and the efficiency bands rewarded mediocrity.

**Input to the evaluator:**
- All prompts from `.jivahire_chat_log.json` (up to 20), each with token cost
- For each prompt: whether the AI response was applied, and whether the follow-up prompt cited the prior response's content
- Total tokens used (prompt + completion) across all chat exchanges
- Challenge baseline token expectation (set per rubric, default 30,000)
- Computed ratio: `actual / baseline`

**Per-criterion sub-scores** (1–10 each, weighted sum forms the dimension score):

| Criterion | Weight | What a 9–10 looks like | What a 1–3 looks like |
|---|---|---|---|
| Context framing | 25% | Provides file contents, error messages, constraints upfront. Knows the model needs context in-window. | Pastes "fix this" with no context. Expects the model to read their mind. |
| Constraint specification | 15% | Explicitly states "must be O(1)", "thread-safe", "no allocations in hot path". | Never states requirements. Gets generic code back. |
| Decomposition | 20% | Breaks complex tasks into 2–3 focused prompts. | One massive prompt dumping the entire problem, or 30 micro-prompts with no planning. |
| Iterative refinement | 15% | When output is wrong, provides specific feedback: "Line 12 has a race because X holds the lock while calling Y". | Re-asks the same question or says "that's wrong, try again". |
| Debug-loop quality | 15% | After a test failure, the next prompt includes the failing assertion, error, and relevant snippet. | Next prompt says "tests still failing" with no detail. |
| Token discipline | 10% | Token use proportionate to problem (0.5–2× baseline) with passing tests. | >5× baseline, or <0.3× with poor code. |

**Prompt classification ladder** (informs scoring, displayed in recruiter UI alongside each prompt):

| Level | Name | Definition |
|---|---|---|
| 5 | Model-native | Understands token windows, provides minimal-but-sufficient context, uses structured prompts, specifies output format. Gets correct code in 1–2 tries. |
| 4 | Professional | Cites exact errors, types, line numbers. Constraints stated. 2–3 iterations max per task. |
| 3 | Competent | Clear problem descriptions, some context. Occasional unnecessary back-and-forth. |
| 2 | Naive | Generic descriptions. Over-relies on model to figure out what they want. Many retries. |
| 1 | Counterproductive | Massive dumps, "fix this" prompts, no context. AI interaction wastes time vs. writing manually. |

### Code Quality (15%)

**What it proves:** The submitted code is correct, readable, handles edge cases gracefully, and introduces no new defects via AI.

**Input to the evaluator:**
- Challenge description and rubric tasks
- Known traps and whether they were fixed (with attribution)
- Hidden test results (passed/failed tags)
- Candidate's submitted source code
- Diff between starter code and submitted code, so the evaluator can isolate candidate-introduced changes

**Per-criterion sub-scores:**

| Criterion | Weight | Description |
|---|---|---|
| Correctness | 30% | Does it pass the tests and fix the planted traps? |
| Idiomatic language use | 20% | Proper language conventions, standard library use |
| Clarity and naming | 15% | Readable structure, well-named identifiers |
| Edge case handling | 15% | Robust failure modes, boundary conditions |
| No AI-introduced defects | 20% | New races, security holes, hallucinated APIs, or unnecessary abstractions not caught by hidden tests |

The "No AI-introduced defects" criterion is critical — hidden tests can miss subtle issues the AI adds (an unnecessary new lock that deadlocks, a logged secret, a hallucinated stdlib method, a thrown exception type the caller doesn't catch). The evaluator is explicitly prompted to scan for these.

### Architectural Reasoning (10%)

**What it proves:** The quality of design decisions the candidate was *responsible for* — not choices already made in the starter code. The candidate owns the design; AI is a tool, not the architect.

**Input to the evaluator:**
- Full challenge rubric (including `starter_code_note`)
- Candidate's full submitted source code
- Chat log (to assess whether the candidate asked "why" before "how")

**Important constraint:** The evaluator is explicitly instructed *not to credit* candidates for algorithms, data structures, or patterns already present in the starter code. Only decisions the candidate actually made are scored.

**Per-criterion sub-scores:**

| Criterion | Weight | Description |
|---|---|---|
| Why-before-how prompting | 15% | Did they ask "what are the tradeoffs of mutex vs shared_mutex here?" before "implement thread safety"? |
| Algorithm choice | 15% | Only if the candidate selected the algorithm (not inherited from starter) |
| Data structure choice | 15% | Only if the candidate selected the structure (not inherited from starter) |
| Concurrency/synchronisation design | 25% | Lock placement, primitive choice, deadlock avoidance |
| Edge-case awareness | 15% | Boundary handling, capacity constraints, unexpected inputs |
| Constraint-driven design | 10% | Solution respects stated constraints (O(1), thread-safe, no blocking) because candidate specified them |
| Not over-engineered | 5% | Didn't add AI-suggested abstractions the problem doesn't need |

---

## Understanding Verification (Pass/Fail Gate)

**What it proves:** The person who submitted the code is the person who understands it. Blocks the dominant 2026 failure mode: a third party drove the session and the named candidate merely accepted applies.

**Why a gate, not a weight:** A candidate who scores 9.5 across everything else but cannot explain their own code is a bad hire regardless. A 5% weight would not change the hire/no-hire recommendation; a cap does. The gate is the single most important defense in the rubric.

**Implementation:**

1. Immediately after submission, the candidate is prompted to record a 3–5 minute video.
2. A **question generator** LLM call reads the candidate's actual diff and generates 4 challenge-specific questions across these types:

| Question Type | Example |
|---|---|
| Explain your choice | "Why did you use `std::lock_guard` instead of `std::unique_lock` here?" |
| What happens if... | "What happens if two threads call `put()` with the same key simultaneously?" |
| Trace through | "Walk through what happens when the cache is full and a new key arrives." |
| Debug scenario | "If this test was failing, where would you look first and why?" |

Questions are generated **per-candidate from their actual code** — never pre-canned per challenge — so they cannot be leaked or rehearsed.

3. A **grading LLM** transcribes the video and scores each answer binary (coherent + correct vs not).
4. **Pass threshold:** ≥3 of 4 questions coherent and correct.
5. **Fail consequence:** `raw_score` is capped at 5.0. The recruiter UI displays the failure prominently along with the candidate's actual answers (transcript + grading reasoning).

**Edge cases:**

- **No-show on video:** treated as fail. Composite capped at 5.0.
- **Accessibility opt-out:** candidates may request a live recruiter-conducted version of the questions instead; same pass/fail bar applies.
- **Re-record:** candidate may re-record once within 24 hours; only the second attempt is graded.

---

## Velocity Metrics (Reported, Not Scored)

These are surfaced on the recruiter dashboard but **not included in the composite** — scoring velocity directly biases against careful candidates and rewards speed-over-quality.

| Metric | Definition |
|---|---|
| Time-to-first-green | Minutes from session start to first commit where all public tests pass |
| Time-to-all-green | Minutes from session start to all-hidden-tests-passing (computed post-grading) |
| Active vs idle time | Time with active edits vs idle (≥2 min no activity) |
| Self-authored ratio | Typed / (typed + AI-applied) lines, surfaced as a percentage |
| Recovery events | Count of large reverts or `git reset` operations |
| Total tokens used | Sum of prompt + completion tokens for the session |
| Total LLM cost (USD) | Per-session cost against the $2.00 budget |

Recruiters can sort/filter candidates by these metrics but they don't move the composite.

---

## Challenge Rubrics

### Shared Criteria (Apply to All Challenges)

The Architectural Reasoning and Code Quality criteria above apply to every challenge. Per-challenge sections below list only the **challenge-specific** task scoring, planted traps, and any unique evaluation criteria.

### Challenge: Thread-Safe TTL Cache (`python-ttl-cache`)

**Language:** Python | **Difficulty:** Mid | **Estimated time:** 45 min | **Time limit:** 90 min

**Task:** Make an existing TTL cache thread-safe, enforce TTL expiry on reads, and fix planted bugs in eviction and edge-case handling. Get/put must remain amortised O(1).

> **Note to graders:** The data structure (`collections.OrderedDict` with `move_to_end`-based promotion) is provided in the starter code. Do **not** credit the candidate for the algorithm or data-structure choice — only their additions and fixes.

**Task Scoring**

| Task | Points | Test Marker |
|---|---|---|
| Basic cache correctness | 25 | `basic` |
| Thread safety | 30 | `thread` |
| Edge cases | 20 | `edge` |
| TTL expiry enforcement | 25 | `ttl` |
| **Total** | **100** | |

**Planted Traps**

| Trap | Description | Points |
|---|---|---|
| Race condition | `get`/`put` mutate `OrderedDict` (`move_to_end`, `popitem`, `__setitem__`) without synchronisation. The GIL does **not** make compound operations atomic. | 20 |
| Off-by-one eviction | Eviction loop uses `> capacity` instead of `>= capacity`; cache grows one entry beyond limit before evicting. | 10 |
| Capacity-zero no-op | `capacity=0`: eviction check `(0 > 0)` is false, so the first `put` inserts an entry instead of being a no-op. | 10 |
| TTL not enforced on read | `get()` does not check TTL; expired entries are returned as if still valid. The starter stores `inserted_at` but never compares it to `time.monotonic() - ttl`. | 15 |

**Challenge-Specific Architectural Criteria** (in addition to the shared Architectural Reasoning criteria):

- Synchronisation primitive choice (`threading.Lock` vs `threading.RLock`)
- Monotonic time source (`time.monotonic` vs `time.time`)
- TTL-on-read enforcement strategy (lazy expiry vs background sweep)

---

### Challenge: Thread-Safe LRU Cache (`cpp-lru-cache`)

**Language:** C++ | **Difficulty:** Mid | **Estimated time:** 45 min | **Time limit:** 90 min

**Task:** Make an existing LRU cache thread-safe and fix planted bugs in eviction and edge-case handling. Get/put must remain O(1).

> **Note to graders:** The data structure (`std::list` + `std::unordered_map` with splice-based eviction) is provided in the starter code. Do **not** credit the candidate for the algorithm or data-structure choice — only their additions and fixes.

**Task Scoring**

| Task | Points | Test Tag |
|---|---|---|
| Basic cache correctness | 30 | `[basic]` |
| Thread safety | 35 | `[thread]` |
| Edge cases | 20 | `[edge]` |
| **Total** | **85** (normalised to 100) | |

**Planted Traps**

| Trap | Description | Points |
|---|---|---|
| Race condition | `get`/`put` mutate `std::list` and `std::unordered_map` without synchronisation. | 20 |
| Off-by-one eviction | Eviction loop uses `> capacity` instead of `>= capacity`; cache grows one entry beyond limit. | 10 |
| Capacity-zero no-op | `capacity=0`: eviction check `(0 > 0)` is false, so the first `put` inserts an entry instead of being a no-op. | 10 |

**Challenge-Specific Architectural Criteria** (in addition to the shared Architectural Reasoning criteria):

- Synchronisation primitive choice (`std::mutex` vs `std::shared_mutex`)
- Const-correctness of locking strategy (e.g. `size()` under shared lock)

---

## What Recruiters See

The recruiter dashboard surfaces all grading data in a **Session Detail View**. Each dimension is labeled by source — `automated`, `telemetry`, or `LLM` — so recruiters can see at a glance which numbers are deterministic and which are interpretive.

1. **Score card** — composite score + per-dimension breakdown with source labels
2. **Understanding Verification result** — pass/fail badge with the candidate's video questions, transcript, and grading reasoning. Failure is shown prominently with the composite cap notation.
3. **Trap detection panel** — each trap with attribution (`hand-fixed`, `ai-fixed-reviewed`, or `ai-fixed-blind`)
4. **Commit timeline** — each auto-snapshot with diff previews showing how the solution evolved
5. **Prompt history** — full chat log with topic tags, prompt classification level (1–5), and correction-loop indicators
6. **AI usage chart** — typed vs AI-applied lines over time, with apply-then-edit events highlighted
7. **Verification cadence chart** — test runs overlaid on AI apply events; the test-after-apply ratio is highlighted
8. **Velocity panel** — time-to-first-green, time-to-all-green, recovery events, self-authored ratio
9. **Grader summary** — LLM-generated narrative combining all evaluation results
10. **Test output** — raw test runner output
11. **Cost** — total tokens consumed and USD cost for the session

---

## What This Rubric Proves to Hiring Companies

| What the company needs to know | How the rubric answers it |
|---|---|
| Can they ship working code? | Hidden test pass rate (20%) + Trap detection (12%) |
| Is the code production-quality? | Code Quality (15%) + Architectural Reasoning (10%) |
| Do they know how to use AI effectively? | LLM Communication (17%) |
| Do they blindly trust AI output? | Verification Discipline (13%) — telemetry-derived, ungameable |
| Can they think independently of the model? | AI Judgment & Rejection (8%) + trap attribution |
| Did *they* actually do the work? | Understanding Verification pass/fail gate |

---

## Anti-Gaming Measures

| Measure | How it works |
|---|---|
| Private repos | Candidates never see the repo URL; the extension clones a one-time branch |
| Randomised challenge assignment | Random selection from a pool of challenges per language/difficulty |
| Branch isolation | Each candidate gets `interview/<session_id>` — read-only after submission |
| Traps stripped from candidate branch | `.jivahire/` directory (rubric, traps, hidden tests) removed before clone |
| Time limit | Enforced client-side (extension countdown) and server-side (API checks + Celery auto-submit) |
| Token budget | Per-session LLM budget ($2.00 default) enforced by sidecar |
| Semantic edit-distance check | Modify-after-apply requires ≥30% semantic change — cosmetic edits don't capture the AI Judgment signal |
| Per-candidate video questions | Auto-generated from each candidate's actual diff — cannot be leaked or rehearsed across sessions |
| Pinned evaluator model | Model + version pinned in `grading_config.json`; re-grading uses the same version |
| Median-of-3 LLM scoring | Each LLM dimension is the median of 3 calls at temp 0 — single noisy calls cannot decide a hire |
| Hand-fix attribution | Trap detection records whether the fix was hand-typed or AI-applied — recruiters see both signals |
| Understanding Verification gate | Caps composite at 5.0 if the candidate cannot explain their own code — defends against ghost candidates |
