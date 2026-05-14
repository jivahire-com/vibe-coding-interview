# Vibe Coding Interview — Grading Rubrics

> **Philosophy:** The best engineers in 2026 aren't those who refuse AI. They're the ones who use it strategically — knowing when to prompt, when to reject, when to refactor, and when to write from scratch. These rubrics evaluate *AI orchestration skill*, not just code output.

---

## How Grading Works

Each session is graded in three stages:

1. **Automated** — hidden tests and planted trap detection run against the candidate's final commit
2. **LLM Evaluation** — five structured AI evaluations assess quality dimensions
3. **Composite Score** — a weighted formula combines all scores into a final result out of 10

---

## Composite Score Formula

| Dimension | Weight | Source |
|---|---|---|
| Test pass rate | 20% | Automated (hidden test suite) |
| Trap detection | 10% | Automated (planted bug detection) |
| Code quality | 20% | LLM evaluation |
| Prompt quality | 15% | LLM evaluation |
| AI orchestration | 15% | LLM evaluation |
| Architectural reasoning | 10% | LLM evaluation |
| Token efficiency | 10% | LLM evaluation |
| **Total** | **100%** | |

**Formula:**

```
total_score = (tests_passed / tests_total × 10) × 0.20
            + (traps_detected / traps_total × 10) × 0.10
            + code_quality_score × 0.20
            + prompt_quality_score × 0.15
            + ai_orchestration_score × 0.15
            + architectural_reasoning_score × 0.10
            + token_efficiency_score × 0.10
```

All LLM scores are on a **1–10 scale**. The composite result is out of **10**.

---

## Automated Grading (30% of total)

### Hidden Test Suite (20%)

Candidates see and can run the *public* tests included in the repo. The grader re-runs a separate *hidden* test suite that covers additional edge cases, concurrency correctness, and security scenarios. Each test is tagged; the grader records which tags pass.

### Trap Detection (10%)

Every challenge repo has **planted bugs** — intentional code defects embedded in the starter code. The `.jivahire/traps.json` file defines each trap and the test tag that reveals whether the candidate fixed it. Traps go unannounced to candidates; detecting and fixing them requires careful code review.

---

## LLM Evaluations (70% of total)

All five evaluations use GPT-4o-mini with `temperature=0`. Each returns a score (1–10) and 2–3 sentences of reasoning. Recruiters see the reasoning text in the session detail view.

---

### 1. Code Quality (20%)

**What it measures:** Whether the submitted code is correct, readable, and handles edge cases gracefully.

**Input to the evaluator:**
- Challenge description and rubric tasks
- Known traps and whether they were fixed
- Hidden test results (passed/failed tags)
- Candidate's submitted source code

**Evaluation criteria** (challenge-specific, with defaults):

| Criterion | Description |
|---|---|
| Correctness | Does it pass the tests and fix the planted traps? |
| Idiomatic language use | Proper language conventions, standard library use |
| Clarity and naming | Readable structure, well-named identifiers |
| Edge case handling | Robust failure modes, boundary conditions |

---

### 2. Prompt Quality (15%)

**What it measures:** How precisely and professionally the candidate communicates with the AI assistant.

**Input to the evaluator:**
- All prompts from `.jivahire_chat_log.json` (up to 20)

**Classification step:** Each prompt is first classified as one of:

| Class | Definition | Example |
|---|---|---|
| `vague` | No technical context | *"fix this"*, *"make it work"* |
| `specific` | Describes the symptom | *"function X returns the wrong value"* |
| `professional` | Cites exact errors, types, line numbers, or runtime behaviour | *"function X returns Y for input Z because the loop terminates one iteration early"* |

**Scoring scale:**

| Score | Meaning |
|---|---|
| 9–10 | Consistently professional — cites exact errors, types, constraints, runtime behaviour |
| 7–8 | Mostly specific — clear problem descriptions even if lacking precision |
| 5–6 | Mixed — some good prompts, some vague |
| 3–4 | Mostly vague — generic requests like "fix this" or "make it work" |
| 1–2 | All layman — zero technical context, shows no understanding of the problem |

---

### 3. AI Orchestration (15%)

**What it measures:** Whether the candidate used AI strategically — iterating, correcting, and applying judgment — rather than blindly copying output.

**Input to the evaluator:**
- Up to 20 AI chat exchanges (prompt + first 400 chars of response)
- The first 3,000 chars of final submitted code

**Evaluation criteria:**

| Criterion | Description |
|---|---|
| Prompt quality | Specific and targeted vs vague/generic |
| Critical evaluation | Did they understand and adapt AI suggestions rather than blindly copy? |
| Iterative refinement | Did they follow up when AI output was wrong or incomplete? |
| Independence | Evidence of own reasoning alongside AI use |

---

### 4. Architectural Reasoning (10%)

**What it measures:** The quality of design decisions the candidate was *responsible for* — not choices already made in the starter code.

**Input to the evaluator:**
- Full challenge rubric (including `starter_code_note`)
- Candidate's full submitted source code

**Important constraint:** The evaluator is explicitly instructed *not to credit* candidates for algorithms, data structures, or patterns already present in the starter code. Only decisions the candidate actually made are scored.

**Evaluation criteria** (challenge-specific, with defaults):

| Criterion | Description |
|---|---|
| Algorithm choice | Only if the candidate selected the algorithm (not inherited) |
| Data structure choice | Only if the candidate selected the structure (not inherited) |
| Concurrency/synchronisation design | Lock placement, primitive choice, deadlock avoidance |
| Edge-case awareness | Boundary handling, capacity constraints, unexpected inputs |

---

### 5. Token Efficiency (10%)

**What it measures:** Whether the candidate's AI usage was proportionate to the problem — neither wasteful nor so sparse it suggests the AI wasn't helpful.

**Input to the evaluator:**
- Total tokens used (prompt + completion) across all chat exchanges
- Challenge baseline token expectation (set per rubric, default 30,000)
- Computed ratio: `actual / expected`

**Scoring scale:**

| Score | Ratio to Baseline | Interpretation |
|---|---|---|
| 10 | 0.5–1.5× | Optimal AI use |
| 8–9 | 1.5–2× | Somewhat verbose but reasonable |
| 6–7 | 0.3–0.5× (with good code) or 2–3× | Efficient but sparse, or mildly over-prompted |
| 4–5 | > 3× or < 0.3× (with poor code) | Excessive prompting or near-zero with poor output |
| 1–3 | > 5× | Highly wasteful |

---

## Challenge Rubrics

### Challenge: Thread-Safe TTL Cache (`python-ttl-cache`)

**Language:** Python | **Difficulty:** Mid | **Estimated time:** 45 min | **Time limit:** 90 min

**Task:** Make an existing TTL cache thread-safe, enforce TTL expiry on reads, and fix planted bugs in eviction and edge-case handling. Get/put must remain amortised O(1).

> **Note to graders:** The data structure (`collections.OrderedDict` with `move_to_end`-based promotion) is provided in the starter code. Do **not** credit the candidate for the algorithm or data-structure choice — only their additions and fixes.

#### Task Scoring

| Task | Points | Test Marker |
|---|---|---|
| Basic cache correctness | 25 | `basic` |
| Thread safety | 30 | `thread` |
| Edge cases | 20 | `edge` |
| TTL expiry enforcement | 25 | `ttl` |
| **Total** | **100** | |

#### Planted Traps

| Trap | Description | Points |
|---|---|---|
| Race condition | `get`/`put` mutate `OrderedDict` (`move_to_end`, `popitem`, `__setitem__`) without synchronisation. The GIL does **not** make compound operations atomic. | 20 |
| Off-by-one eviction | Eviction loop uses `> capacity` instead of `>= capacity`; cache grows one entry beyond limit before evicting. | 10 |
| Capacity-zero no-op | `capacity=0`: eviction check `(0 > 0)` is false, so the first `put` inserts an entry instead of being a no-op. | 10 |
| TTL not enforced on read | `get()` does not check TTL; expired entries are returned as if still valid. The starter stores `inserted_at` but never compares it to `time.monotonic() - ttl`. | 15 |

#### Code Quality Criteria

- Correctness (tests pass and traps fixed)
- Thread safety — lock placement and no data races on `OrderedDict`
- Idiomatic Python — type hints, context managers, `time.monotonic` for TTL
- Clarity and naming

#### Architectural Criteria

- Synchronisation primitive choice (`threading.Lock` vs `threading.RLock`)
- Lock placement and granularity (per-method, scope of critical section)
- Deadlock avoidance (no nested locking, no reentrant calls)
- Edge case handling (capacity=0 no-op, eviction boundary, TTL on get)
- Monotonic time source (`time.monotonic` vs `time.time`)

---

### Challenge: Thread-Safe LRU Cache (`cpp-lru-cache`)

**Language:** C++ | **Difficulty:** Mid | **Estimated time:** 45 min | **Time limit:** 90 min

**Task:** Make an existing LRU cache thread-safe and fix planted bugs in eviction and edge-case handling. Get/put must remain O(1).

> **Note to graders:** The data structure (`std::list` + `std::unordered_map` with splice-based eviction) is provided in the starter code. Do **not** credit the candidate for the algorithm or data-structure choice — only their additions and fixes.

#### Task Scoring

| Task | Points | Test Tag |
|---|---|---|
| Basic cache correctness | 30 | `[basic]` |
| Thread safety | 35 | `[thread]` |
| Edge cases | 20 | `[edge]` |
| **Total** | **85** (normalised to 100) | |

#### Planted Traps

| Trap | Description | Points |
|---|---|---|
| Race condition | `get`/`put` mutate `std::list` and `std::unordered_map` without synchronisation. | 20 |
| Off-by-one eviction | Eviction loop uses `> capacity` instead of `>= capacity`; cache grows one entry beyond limit. | 10 |
| Capacity-zero no-op | `capacity=0`: eviction check `(0 > 0)` is false, so the first `put` inserts an entry instead of being a no-op. | 10 |

#### Code Quality Criteria

- Correctness (tests pass and traps fixed)
- Thread safety — mutex/lock usage and no data races
- Idiomatic C++ — move semantics, const correctness, RAII
- Clarity and naming

#### Architectural Criteria

- Synchronisation primitive choice (`std::mutex` vs `std::shared_mutex`)
- Lock placement and granularity (per-method, scope of critical section)
- Deadlock avoidance (no nested locking, no recursive locks)
- Edge case handling (capacity=0 no-op, eviction boundary off-by-one)
- Const-correctness of locking strategy (e.g. `size()` under shared lock)

---

## What Recruiters See

The recruiter dashboard surfaces all grading data in a **Session Detail View**:

1. **Score card** — composite score + per-dimension breakdown
2. **Commit timeline** — each auto-snapshot with diff previews showing how the solution evolved
3. **Prompt history** — full chat log with topic tags and correction-loop indicators
4. **AI usage chart** — human typing vs AI-generated code over time
5. **Grader summary** — LLM-generated narrative combining all five evaluation results
6. **Test output** — raw test runner output
7. **Cost** — total tokens consumed and USD cost for the session

---

## Anti-Gaming Measures

| Measure | How it works |
|---|---|
| Private repos | Candidates never see the repo URL; the extension clones a one-time branch |
| Randomised challenge assignment | Random selection from a pool of challenges per language/difficulty |
| Branch isolation | Each candidate gets `interview/<session_id>` — read-only after submission |
| Traps stripped from candidate branch | `.jivahire/` directory (rubric, traps, hidden tests) removed before clone |
| Time limit | Enforced both client-side (extension countdown) and server-side (API checks + Celery auto-submit) |
| Token budget | Per-session LLM budget ($2.00 default) enforced by sidecar — candidate sees a budget-exhausted message |
