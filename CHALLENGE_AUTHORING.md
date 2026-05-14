# Challenge Authoring Guide

This document is the single authoritative reference for creating a new challenge in this repository. It is **self-sufficient**: an author following it from a clean checkout, with no other file open, can produce a working challenge that the grader pipeline accepts end-to-end. Every required file is represented here as a copy-pasteable code block with `<<REPLACE: …>>` markers for placeholder values.

<!-- GRADING_SYNC
source: GRADING_RUBRICS.md
last_synced_commit: db5987e
last_synced_date: 2026-05-14
weights_hash: a9d880f9111fa9d06ec2fa53123c65fca41eba066f5320ddde89810f2cd34459
-->

> **Sync rule:** Whenever `GRADING_RUBRICS.md` is modified (weights, dimensions, new signals), update §3 of this document, bump the sync block above, and add a line to the Changelog at the end. The `weights_hash` is `sha256(json.dumps(default_composite_weights, sort_keys=True))` from `server/vibe/grader/runner.py:_DEFAULT_WEIGHTS`.

**Who this is for:** Anyone adding a new challenge to `challenges/`. No prior knowledge of the grader codebase is required.

**How to use this document:** Read §1–3 once for orientation, then work through the §10 checklist step-by-step. §§4–9 are reference material — jump to them when the checklist points you there. §11 has per-language appendices with copy-pasteable code.

---

## §1. What a Challenge Is

A challenge is a **deliberately imperfect starter codebase** — partially working code with planted bugs (traps), a public test suite the candidate can run, a hidden test suite the grader runs on submission, and machine-readable metadata the grader uses to score the result. The candidate never sees the traps or hidden tests; discovering and fixing the traps is part of what is being evaluated. Candidates are *encouraged* to use AI; the platform specifically measures the quality of that AI use alongside the code.

Every challenge targets a single focused problem that an experienced engineer could complete in 45–90 minutes with AI assistance. The starter code provides the boilerplate and data-structure choices so the candidate spends their time on the interesting parts — correctness, concurrency safety, edge-case handling, and thoughtful AI orchestration — not setup.

### Supported languages today

The grader runs **Python** (§11.A) and **C++** (§11.B). Hidden tests in any other language will not execute and the challenge will not score. To add a new language end-to-end, complete §11.C *first* — implement and wire the grader runner, then author the challenge.

### Drafting in an unsupported language

**Hard rule: every challenge — draft or active — must be grader-compatible by construction. There is no path that lets you author something the grader cannot run.** A draft is a challenge whose runner does not yet exist; the moment a runner is added per §11.C, the draft must execute correctly with no re-authoring. If §11.D's contract cannot be met in your chosen language (no tag-filtering framework, no non-interactive build, no exact-string tag match), do not author in that language until §11.C makes it viable.

To prototype a challenge in a language the grader doesn't yet support (TypeScript, Rust, Go, etc.) ahead of the §11.C platform work, mark it as a **draft**:

- Set `"status": "draft"` in `metadata.json` (see §4.1).
- Pick any `language` slug and any `grader` value — they are not enforced for drafts, but they must match what the eventual runner will use.
- Author the full challenge tree per **§11.D Language-Agnostic Draft Blueprint** — that appendix is self-contained and defines the grader contract in a language-neutral way. Following §11.D end-to-end produces a grader-compatible artifact.
- Drafts are **never assigned to candidates and never graded** *until promotion*. They live in `challenges/` as ready-to-promote artifacts. Session creation must reject draft challenges; the grader will not run them.

To promote a draft: complete §11.C for that language, then flip `"status"` to `"active"`. No re-authoring required — that property is the test that the draft was authored correctly.

> **Authoring outside this repo:** This guide is designed to be self-sufficient. If you are drafting a challenge with only this file and `GRADING_RUBRICS.md` in hand (no access to the rest of the repo), follow §11.D end-to-end. References to repo-internal paths like `scripts/measure_repo_tokens.py`, `server/vibe/grader/`, and `challenges/python-ttl-cache/` are background context — they apply only when promoting a draft to active. The grader contract itself is fully specified in this document.

### Hard invariants

Every challenge MUST satisfy all of the following before it can be used:

1. **Self-contained.** No network calls during tests. No external services beyond what `docker-compose.yml` in the repo root provides. All test dependencies are fetched at build time or installed via the package manager.
2. **Deterministic tests.** No flaky timing assumptions except in tests tagged `thread` or `ttl`, which must be designed to be robust (generous timeouts, no wall-clock sleeps under 50 ms, deterministic thread counts).
3. **Reproducible build.** A fresh clone + the commands in `SETUP.md` must produce a working test run with no manual steps.
4. **`.jivahire/` present in the challenge repo, stripped from the candidate branch.** The session-creation code removes `.jivahire/` before the candidate clones. See §6 for the hidden test file convention.
5. **Public tests mostly pass on the unmodified starter.** Failing public tests are hints toward traps, not showstoppers. A candidate should be able to run the public suite immediately after cloning and see mostly green.
6. **Every planted trap is detectable via a tagged hidden test.** No invisible traps — if the grader cannot automatically confirm the trap was fixed, it does not score.

---

## §2. Repository Layout

Every challenge follows this directory structure exactly:

```
challenges/<challenge-id>/
├── .jivahire/                  # GRADER-ONLY — stripped from candidate branch
│   ├── metadata.json           # discovery: language, difficulty, test file paths
│   ├── rubric.json             # scoring: tasks, criteria, submission_files, weights
│   └── traps.json              # planted bugs: id, detection_tag, severity
├── README.md                   # candidate-facing: problem, commands, AI policy
├── SETUP.md                    # candidate-facing: prerequisites, install, troubleshoot
├── <build-config>              # e.g. pyproject.toml, CMakeLists.txt, Cargo.toml
├── <source-dir>/               # starter code with TODO(candidate) markers
│   └── <implementation-file>
└── tests/
    ├── <public-test-file>      # visible to candidate; mostly passes on starter
    └── <hidden-test-file>      # NOT on candidate branch; grader injects at runtime
```

**Naming:** `challenge_id` is kebab-case `<language>-<topic>` (e.g., `python-ttl-cache`, `cpp-lru-cache`). The directory name must match `challenge_id` in `metadata.json`.

**Who reads what:**

| File | Read by | When | Never seen by |
|---|---|---|---|
| `.jivahire/` | Grader server | Scoring time | Candidate |
| `README.md` | Candidate | Start of interview | — |
| `SETUP.md` | Candidate | Before/during interview | — |
| `<public-test-file>` | Candidate + grader | Anytime | — |
| `<hidden-test-file>` | Grader only | Injected before build | Candidate |
| `<source-dir>/` | Candidate + grader | Editing + scoring | — |

### Size and count limits

The platform clones challenges to candidate machines, tokenises the full tree for LLM evaluators, and runs tests inside a time-bounded grader container. Bloat hurts every stage. These are hard caps — challenges exceeding them are rejected at PR review.

| Bucket | Hard cap | Rationale |
|---|---|---|
| Total repo size (excl. `.git/`, `build/`, `node_modules/`, `.venv/`, binary fixtures) | **5 MB** | Clone + grader payload must be small |
| Total file count (same exclusions) | **60 files** | Keeps tree navigable in a 45–90 min interview |
| Submission files (`submission_files` in rubric) | **≤ 5 files, ≤ 400 LOC each, ≤ 1,200 LOC total** | LLM code-quality evaluator context window |
| Read-only support source (helpers, fixtures, types) | **≤ 15 files, ≤ 2,500 LOC total** | Enough context; not a reading exercise |
| Public test file | **1 file, ≤ 300 LOC** | Candidate must be able to skim it |
| Hidden test file | **1 file, ≤ 600 LOC** | Grader runs it on every submission |
| Each `.jivahire/` JSON file | **≤ 50 KB** | Machine-read; bloated criteria → poor LLM evals |
| `README.md` | **≤ 400 lines** | Won't be read if it doesn't fit on a screen |
| `SETUP.md` | **≤ 200 lines** | Setup only; no challenge content |
| Binary / fixture assets | **≤ 500 KB combined, ≤ 5 files** | Prefer programmatic fixture generators |
| `expected_tokens` (measured via `scripts/measure_repo_tokens.py`) | **≤ 60,000 tokens** | Above this, token-efficiency baselines lose meaning |
| Directory nesting depth below `challenges/<challenge-id>/` | **≤ 4 levels** | Deep paths make `submission_files` fragile |

**Rules:**
- Caps apply to the committed repo, before grader injection.
- To exceed a cap, add a `"size_exceptions"` block to `rubric.json` (see §4) and get explicit PR sign-off.
- No binaries in `submission_files`. No generated artefacts committed (see `.gitignore` in §10).

### Copy-paste .gitignore for a new challenge

```gitignore
# Build artefacts
build/
dist/
*.egg-info/
__pycache__/
*.pyc
*.pyo

# Virtual environments
.venv/
venv/
env/

# Node / JS
node_modules/
*.js.map

# Rust
target/

# CMake cache
CMakeCache.txt
CMakeFiles/
cmake_install.cmake
Makefile
CTestTestfile.cmake
Testing/

# OS
.DS_Store
Thumbs.db
```

---

## §3. Grading Contract

This section mirrors `GRADING_RUBRICS.md`. **If you change `GRADING_RUBRICS.md`, update this section and the sync block in the front matter.**

### Composite score formula

```
total_score = (tests_passed / tests_total × 10) × 0.20
            + (traps_detected_w / traps_total_w × 10) × 0.10
            + code_quality_score × 0.20
            + prompt_quality_score × 0.15
            + ai_orchestration_score × 0.15
            + architectural_reasoning_score × 0.10
            + token_efficiency_score × 0.10
```

All LLM scores are 1–10. The composite result is 0–10. `traps_detected_w / traps_total_w` is a **severity-weighted** ratio: each trap contributes its `severity` value (1–3) to both numerator (if fixed) and denominator.

Fallback: if any grading stage fails, that dimension scores **5** (neutral). Grading continues for the remaining stages.

### Per-dimension table

| Dimension | Default weight | Source | What the author must provide |
|---|---|---|---|
| Test pass rate | **20%** | Automated — hidden test suite runs against candidate's final commit | Hidden test file at `tests/<hidden-test-file>` with at least one test per tag declared in `rubric.json::tasks[].test_tag` |
| Trap detection | **10%** | Automated — severity-weighted; a trap is detected if `tag_results[detection_tag]` is `True` | `traps.json` with `detection_tag` matching a tag used in the hidden test file |
| Code quality | **20%** | LLM evaluation — correctness, idioms, edge-case handling | `rubric.json::code_quality_criteria` (4–8 concise bullet points) and `rubric.json::submission_files` |
| Prompt quality | **15%** | LLM evaluation — classifies each prompt as `vague`, `specific`, or `professional` | No author action required; driven by candidate chat log |
| AI orchestration | **15%** | LLM evaluation — strategic use vs. blind copy-paste, correction loops, independence | No author action required; driven by telemetry + chat log |
| Architectural reasoning | **10%** | LLM evaluation — design decisions the candidate was responsible for | `rubric.json::architectural_criteria` + `rubric.json::starter_code_note` (critical — see below) |
| Token efficiency | **10%** | Formula — `actual_tokens / max_tokens` ratio | `rubric.json::expected_tokens` measured via `scripts/measure_repo_tokens.py` |

### Weight overrides

Per-challenge weights live in `rubric.json::composite_weights`. They **merge with** (not replace) the defaults via `{**defaults, **override}` — so you only need to specify the weights you want to change. However, the active weights **must sum to 1.0** or the composite score will be wrong (there is no automatic normalization). Always list all seven keys if you override any.

### Behavioural signals

The grader collects the following signals from telemetry and the chat log. They feed the LLM evaluators as context — they do not produce automated deductions, but they inform the LLM's score:

| Signal | Feeds | Meaning |
|---|---|---|
| `paste_pct` | Code quality, AI orchestration | % of final code characters from clipboard paste |
| `ai_applied_pct` | AI orchestration | % from AI completions accepted verbatim |
| `correction_loops` | AI orchestration | Count of follow-up prompts flagged as corrections |
| `window_switches` | AI orchestration | Focus-change events (candidate left IDE) |
| `suspicious_pastes` | AI orchestration | Count of unusually large single paste operations |
| `cache_hit_ratio` | Token efficiency | Prompt tokens reused from LLM KV cache |
| `reasoning_token_share` | AI orchestration | Extended-thinking tokens / completion tokens |

High `paste_pct` with low `correction_loops` lowers AI orchestration score. The evaluator explicitly looks for post-paste edits or refactoring as evidence the candidate engaged critically.

### `starter_code_note` doctrine

The `architectural_reasoning` evaluator is explicitly instructed not to credit candidates for decisions already made in the starter code. The `rubric.json::starter_code_note` field is the mechanism: it tells the evaluator what NOT to credit.

**If this field is absent or vague, the evaluator will over-credit candidates for inherited design choices, inflating scores.** Every challenge must have a precise `starter_code_note`.

Good example:
```
"starter_code_note": "The data-structure choice (collections.OrderedDict with
move_to_end-based promotion) is provided in the starter code. Do NOT credit
the candidate for the algorithm or data-structure choice — only their additions
and fixes: adding synchronisation, fixing the off-by-one in the eviction loop,
handling capacity=0, and enforcing TTL on get()."
```

### Token baseline formula

```
max_tokens = (repo_tokens × 1.5)
           + (3_500 × num_tasks)
           + difficulty_tokens[difficulty]

difficulty_tokens = { "junior": 8_000, "mid": 15_000, "senior": 25_000 }
```

`repo_tokens` is measured once per challenge via `scripts/measure_repo_tokens.py` and stored in `rubric.json::expected_tokens`. Re-measure whenever starter code or fixtures change meaningfully.

### Update protocol

When `GRADING_RUBRICS.md` changes:
1. Update the composite formula and per-dimension table above.
2. Bump `last_synced_commit`, `last_synced_date`, and `weights_hash` in the front-matter sync block.
3. Audit per-language appendices (§11) for any rubric fields that gained or lost meaning.
4. Add a one-line entry to the Changelog at the bottom of this document.

---

## §4. The `.jivahire/` Metadata Files

### 4.1 `metadata.json` — full schema

| Field | Type | Required | Controls |
|---|---|---|---|
| `challenge_id` | string | yes | Must match the directory name exactly |
| `title` | string | yes | Human-readable title shown in the recruiter dashboard |
| `language` | string | yes | `"python"`, `"cpp"`, or a future language slug |
| `difficulty` | string | yes | `"junior"`, `"mid"`, or `"senior"` |
| `estimated_minutes` | int | yes | Displayed to candidate as target time |
| `max_minutes` | int | yes | Hard time limit; triggers auto-submit on expiry |
| `tags` | string[] | yes | Searchable tags (e.g., `["concurrency", "data-structures"]`) |
| `public_test_file` | string | yes | Path relative to challenge root |
| `hidden_test_file` | string | yes | Path relative to challenge root; injected by grader |
| `grader` | string | yes | Grader backend: `"cpp"` (fully implemented) or `"python"` (see §11.A) |
| `status` | string | no | `"active"` (default) or `"draft"`. Draft challenges are excluded from session assignment and grading — see §1 "Drafting in an unsupported language". For drafts, `language` and `grader` are not validated. |

**Copy-paste template:**

```json
{
  "challenge_id": "<<REPLACE: lang-topic>>",
  "title": "<<REPLACE: Human-Readable Title>>",
  "language": "<<REPLACE: python|cpp>>",
  "difficulty": "<<REPLACE: junior|mid|senior>>",
  "estimated_minutes": 45,
  "max_minutes": 90,
  "tags": ["<<REPLACE: tag1>>", "<<REPLACE: tag2>>"],
  "public_test_file": "tests/<<REPLACE: test_public.py|public_test.cpp>>",
  "hidden_test_file": "tests/<<REPLACE: test_hidden.py|hidden_test.cpp>>",
  "grader": "<<REPLACE: cpp|python>>"
}
```

> **For drafts** (unsupported-language prototypes): add `"status": "draft"` as a top-level field. `language` and `grader` can be any string you like — they are not enforced. Omit `status` (or set it to `"active"`) for normal challenges.

---

### 4.2 `rubric.json` — full schema

| Field | Type | Required | Controls |
|---|---|---|---|
| `challenge_id` | string | yes | Must match `metadata.json` |
| `title` | string | yes | Used in LLM evaluator prompts |
| `description` | string | yes | Task summary fed to all LLM evaluators (~2 sentences) |
| `language` | string | yes | Determines syntax highlighting in recruiter view |
| `code_fence` | string | yes | Code block language hint (e.g., `"python"`, `"cpp"`) |
| `difficulty` | string | yes | Used in token baseline formula |
| `estimated_minutes` | int | yes | Sanity check for `expected_tokens` |
| `max_minutes` | int | yes | Mirror of `metadata.json` |
| `submission_files` | string[] | yes | Paths the code-quality evaluator reads; nothing else is graded |
| `starter_code_note` | string | yes | Tells the architectural-reasoning evaluator what NOT to credit |
| `code_quality_criteria` | string[] | yes | 4–8 bullet points; fed verbatim to the code-quality LLM evaluator |
| `architectural_criteria` | string[] | yes | 4–8 bullet points; fed to the architectural-reasoning evaluator |
| `tasks` | object[] | yes | One entry per test tag; maps tag to point value |
| `tasks[].id` | string | yes | Unique within the challenge |
| `tasks[].points` | int | yes | Relative weight (used in rubric display; actual scoring via `composite_weights`) |
| `tasks[].test_tag` | string | yes | Must match a tag used in the hidden test file |
| `composite_weights` | object | no | Override default weights; must sum to 1.0 if provided; merges with defaults |
| `total_points` | int | yes | Sum of `tasks[].points`; for display only |
| `expected_tokens` | int | yes | Measured via `scripts/measure_repo_tokens.py`; used in token efficiency scoring |
| `size_exceptions` | object[] | no | Justify cap overrides; requires PR reviewer sign-off |

**Copy-paste template (annotated):**

```json
{
  "challenge_id": "<<REPLACE: lang-topic>>",
  "title": "<<REPLACE: Human-Readable Title>>",
  "description": "<<REPLACE: 1-2 sentence task summary — what the candidate must do and why it is hard.>>",
  "language": "<<REPLACE: python|cpp>>",
  "code_fence": "<<REPLACE: python|cpp>>",
  "difficulty": "<<REPLACE: junior|mid|senior>>",
  "estimated_minutes": 45,
  "max_minutes": 90,

  "submission_files": [
    "<<REPLACE: src/my_module.py>>"
  ],

  "starter_code_note": "<<REPLACE: What is already provided that the candidate should NOT be credited for — data structure choice, algorithm, skeleton code. Be precise.>>",

  "code_quality_criteria": [
    "Correctness (does it pass the tests and fix the planted traps?)",
    "<<REPLACE: language-specific idiom criterion, e.g. Thread safety — lock placement and no data races>>",
    "<<REPLACE: idiomatic-use criterion, e.g. Idiomatic Python — type hints, context managers, time.monotonic>>",
    "Clarity and naming"
  ],

  "architectural_criteria": [
    "<<REPLACE: key design decision 1, e.g. Synchronisation primitive choice (Lock vs RLock)>>",
    "<<REPLACE: key design decision 2, e.g. Lock placement and granularity>>",
    "<<REPLACE: key design decision 3, e.g. Deadlock avoidance>>",
    "Edge case handling (<<REPLACE: list the specific edge cases relevant to this challenge>>)"
  ],

  "tasks": [
    {"id": "basic",   "points": 30, "test_tag": "basic"},
    {"id": "<<REPLACE: task_id>>", "points": 40, "test_tag": "<<REPLACE: tag>>"},
    {"id": "edge",    "points": 30, "test_tag": "edge"}
  ],

  "total_points": 100,

  "expected_tokens": 0,

  "composite_weights": {
    "test_score":              0.20,
    "trap_score":              0.10,
    "code_quality":            0.20,
    "prompt_quality":          0.15,
    "ai_orchestration":        0.15,
    "architectural_reasoning": 0.10,
    "token_efficiency":        0.10
  }
}
```

> Leave `expected_tokens` as `0` initially; populate it in step 10 of the §10 checklist after running `scripts/measure_repo_tokens.py`.

> `composite_weights` shown above matches the system defaults exactly. Omit the field to use defaults, or include the full object with all seven keys summing to 1.0 to override.

---

### 4.3 `traps.json` — full schema

| Field | Type | Required | Controls |
|---|---|---|---|
| `traps` | object[] | yes | Array of trap definitions |
| `traps[].id` | string | yes | Unique slug; shown in grader logs |
| `traps[].description` | string | yes | What the bug is and where; grader narrative and recruiter view |
| `traps[].detection_tag` | string | yes | Tag used by the hidden test that fails if this trap is NOT fixed |
| `traps[].severity` | int | yes | `1` minor, `2` moderate, `3` critical — weighted scoring |
| `traps[].points` | int | no | Legacy display field; not used in scoring formula |

**Copy-paste template (one entry per severity tier):**

```json
{
  "traps": [
    {
      "id": "<<REPLACE: severity-1-trap-id>>",
      "description": "<<REPLACE: Minor / cosmetic issue — e.g. missing const qualifier on a method that does not mutate state.>>",
      "detection_tag": "<<REPLACE: matching-test-tag>>",
      "severity": 1
    },
    {
      "id": "<<REPLACE: severity-2-trap-id>>",
      "description": "<<REPLACE: Moderate bug — e.g. off-by-one in the eviction loop uses > capacity instead of >= capacity; cache grows one entry beyond limit before evicting.>>",
      "detection_tag": "<<REPLACE: matching-test-tag>>",
      "severity": 2
    },
    {
      "id": "<<REPLACE: severity-3-trap-id>>",
      "description": "<<REPLACE: Critical bug — e.g. capacity=0 check (0 > 0) is false; first put inserts an entry instead of being a no-op, silently corrupting invariants.>>",
      "detection_tag": "<<REPLACE: matching-test-tag>>",
      "severity": 3
    }
  ]
}
```

### 4.4 Common authoring mistakes

| Mistake | Symptom | Fix |
|---|---|---|
| `submission_files` contains a test file | Grader credits the candidate for editing their own tests | Only list production source files |
| `detection_tag` typo or casing mismatch | Trap is never marked detected even when fixed | Double-check against the tag string in the hidden test |
| `composite_weights` does not sum to 1.0 | Composite score silently wrong | Always include all 7 keys summing to exactly 1.0 |
| `difficulty` missing | Token baseline silently falls back to `"mid"` | Always set explicitly |
| `code_quality_criteria` is empty | LLM evaluator gets a generic prompt; scores regress to the mean | Provide 4+ concise, challenge-specific bullets |
| `starter_code_note` absent or vague | Architectural-reasoning evaluator credits inherited design choices | Write it precisely — name the exact structures and algorithms provided |
| Hidden test uses a tag not in `tasks` or `traps` | Tag produces no score signal (orphan tag) | Add a `tasks` entry or a `traps` entry referencing that tag |
| `expected_tokens` left at `0` | Token efficiency score is meaningless | Run `scripts/measure_repo_tokens.py` and populate the field |

---

## §5. Designing Traps and Edge Cases

### Trap design principles

A trap must be a bug that:

- **A senior engineer reviewing real production code would flag.** Not a puzzle, not an academic gotcha. If you couldn't put it in a real PR comment, it's not a trap.
- **Is discoverable in 5–15 minutes** through careful reading, a failing test, or a runtime error. Too fast (< 2 min) and it's noise. Too slow (> 20 min) and it dominates the challenge unfairly.
- **Has a single clear fix.** Ambiguous traps produce inconsistent scoring.
- **Maps to exactly one `detection_tag`.** One trap → one tag. One tag may cover multiple traps only if they are genuinely co-located (fixed together by the same change).

### Severity calibration

| Severity | Definition | Examples |
|---|---|---|
| `1` — minor | Cosmetic defect; behaviour is technically correct but non-idiomatic or fragile | Missing `const` qualifier, magic number instead of named constant, unnecessary clone |
| `2` — moderate | Incorrect behaviour in a reachable path; wrong output but no crash | Off-by-one in eviction, wrong comparator in sort, GIL-invisible race condition |
| `3` — critical | Data loss, silent corruption, crash, or security vulnerability | Capacity-zero no-op that silently stores entries, SQL injection, use-after-free, hardcoded secret |

Most challenges should have 3–5 traps: 1–2 severity-2, 1 severity-3, and optionally 1–2 severity-1. Avoid all-severity-1 challenges (too easy to miss scoring impact) and multiple severity-3 traps (too punishing).

### Trap taxonomy

Use this as inspiration, not a checklist. Mix categories appropriate to the problem domain.

**Concurrency**
- Unsynchronised mutation of shared mutable state
- Compound operations not covered by the GIL (Python `OrderedDict.move_to_end` + `__setitem__`)
- Wrong lock type (reentrant vs. non-reentrant)
- Deadlock via nested acquisition in the wrong order
- Lock held during blocking I/O or sleep

**Correctness**
- Off-by-one in loop bounds or array indices
- Wrong comparator (`>` vs `>=`, `<` vs `<=`)
- Integer overflow / truncation
- Incorrect base case in recursion
- Missing return value on one code path

**Edge cases**
- Zero-size or empty container
- Single-element container
- Max-value inputs
- `nil` / `null` / `None` not handled
- Move-only value types (C++ specifically)

**Lifecycle / resource management**
- TTL/expiry not enforced on reads
- Double-free or double-close
- Resource leak (file descriptor, goroutine, connection)
- Early return that skips cleanup

**Security (use sparingly — only when relevant to the domain)**
- SQL injection via string concatenation
- Hardcoded credential or secret
- Vulnerable dependency with a known CVE
- Missing input sanitisation in an exposed API

### Edge-case checklist

Before finalising hidden tests, verify the challenge exercises all applicable scenarios:

- [ ] **Zero** — zero capacity, zero elements, zero-length input
- [ ] **One** — single-element container, single-operation sequence
- [ ] **Max** — capacity at limit, maximum integer value, largest valid input
- [ ] **Negative / invalid** — negative capacity, negative count, invalid key type
- [ ] **Concurrent** — multiple goroutines / threads writing simultaneously
- [ ] **Ordering** — LRU/MRU ordering preserved after interleaved reads and writes
- [ ] **Update vs. insert** — updating an existing key must not change size
- [ ] **Time** — TTL expiry on reads, TTL refresh on write, sub-millisecond precision
- [ ] **Type** — move-only types (C++), unhashable keys (Python), generic/interface types

---

## §6. Tests: Visible vs. Hidden, Tagging Discipline

### Public test file

- Lives at `metadata.json::public_test_file`.
- The candidate sees it, runs it, and may read it as a spec.
- Most tests should pass on the unmodified starter. A few should fail intentionally — these act as hints toward traps (e.g., a test named `test_lru_eviction_order` that fails hints at the off-by-one trap).
- Do not name failing tests in a way that names the trap directly.
- Keep it under 300 LOC.

### Hidden test file

- Lives at `metadata.json::hidden_test_file` **in the challenge repo on the grader server**.
- The hidden test is **not** committed inside `.jivahire/`; it lives in `tests/` alongside the public test file. The session-creation code excludes it from the candidate branch (same mechanism as `.jivahire/`).
- The grader copies it into the cloned candidate branch before building/running.
- **C++ note:** The grader reads `hidden_test_file` from `metadata.json`. For C++ challenges, name the file `hidden_test.cpp` — the CMake glob in the challenge `CMakeLists.txt` requires the `.cpp` extension to pick it up.
- Must cover: every trap (via `detection_tag`), every item in the edge-case checklist, plus at least one stress test proportional to difficulty.
- Keep it under 600 LOC.

### Tagging discipline

Tags are an **open vocabulary** — define whatever tags your challenge needs. Declare them in `rubric.json::tasks[].test_tag` and `traps.json::traps[].detection_tag`, and register them with the test framework.

Conventional starting points from the existing challenges (use when they fit; invent your own when they don't):

| Tag | Typical meaning | Typical use |
|---|---|---|
| `basic` | Single-threaded correctness | API shape, return values, simple sequences, eviction ordering |
| `thread` | Concurrent / data-race | Spawn N threads, assert invariants, no corruption |
| `edge` | Boundary / pathological inputs | Zero capacity, empty, max int, move-only types |
| `ttl` | Time-based expiry | Sleep + assert, TTL refresh on write |

Other tags a challenge might legitimately introduce: `security`, `validation`, `network`, `io`, `unicode`, `error-handling`, `migration`, `regression`, `perf`, `memory`, `recovery`, `auth`, `serialization`, `compat`. Pick names that describe **what the test asserts**, not how it asserts (e.g., `auth` not `mocks-jwt`).

**Tag naming rules:**
- Lowercase, kebab-case or single word; no spaces.
- Verb-free — describe the property under test.
- Stable across `rubric.json`, `traps.json`, and the test file. No aliasing.

**Closure rules (grader enforcement):**
- Every tag in `rubric.json::tasks[].test_tag` and `traps.json::traps[].detection_tag` MUST appear on ≥ 1 hidden test.
- Every tag used by a test SHOULD appear in `tasks` or `traps` — orphan tags produce no score.

---

## §7. Starter Code Philosophy

The starter code occupies a narrow target: **not blank** (no boilerplate tax) and **not finished** (nothing for the candidate to do). The right calibration is a working skeleton with deliberate bugs and explicit gaps.

**Principles:**
- Provide the data structure and algorithmic skeleton. State clearly in `starter_code_note` what was provided so the grader doesn't credit it.
- Mark every trap location with a `TODO(candidate):` comment that **describes the area to revisit** without naming the bug. The comment should guide attention without revealing the fix.
- Failing public tests are already a signal; `TODO` comments are a second, softer signal. Together they give candidates enough breadcrumb to find the traps within the time budget.
- Only files in `submission_files` are graded. If you want a two-file change (e.g., header + implementation), list both.

**Good `TODO(candidate):` example** (language-neutral form — adapt comment syntax to your host language: `//` for JS/TS/Rust/Go/Java/C#/Swift/Kotlin; `#` for Python/Ruby/Shell; `<!-- -->` for HTML/XML):
```
// TODO(candidate): the eviction condition below has an off-by-one error.
//                  A full cache should evict before inserting, but currently
//                  it allows the cache to grow one entry beyond capacity.
while (size > capacity) { ... }
```

**Bad `TODO(candidate):` example:**
```
// TODO(candidate): fix the > to >=
while (size > capacity) { ... }
```

The good example describes the invariant that is violated; the bad one just tells the candidate the answer.

---

## §8. Candidate-Facing Documents

### 8.1 `README.md` skeleton

Copy this, fill placeholders, keep it under 400 lines.

```markdown
# <<REPLACE: Challenge Title>>

## The Task

<<REPLACE: 2-3 sentence description of the problem. What exists, what is broken, what the candidate must produce.>>

## What you must deliver

1. <<REPLACE: Acceptance criterion 1, e.g. All public tests pass.>>
2. <<REPLACE: Acceptance criterion 2, e.g. The implementation is thread-safe under concurrent access.>>
3. <<REPLACE: Acceptance criterion 3, e.g. Edge cases (capacity=0, TTL expiry) are handled correctly.>>

## How to build and run tests

<<REPLACE: Copy the relevant block from §11.A (Python) or §11.B (C++) and adapt.>>

## AI assistance

You are encouraged to use AI tools. This interview evaluates **how** you use them — the quality of your prompts, whether you verify and adapt AI output, and how efficiently you reach a working solution. Your AI chat history is recorded as part of the submission.

## Scoring

Your submission is evaluated on:

- **Test pass rate** — how many hidden tests pass
- **Trap detection** — whether you found and fixed planted quality issues
- **Code quality** — correctness, idiomatic use, edge-case handling
- **Prompt quality** — how precisely you communicate with the AI assistant
- **AI orchestration** — strategic use vs. blind copy-paste
- **Architectural reasoning** — quality of design decisions you made (not ones inherited from the starter)
- **Token efficiency** — proportionate use of the AI token budget

## Submitting

Click **Submit** in the Vibe sidebar, or run `Vibe: Submit` from the command palette.

**Auto-submit fires when the timer reaches 0.** Make sure your changes are saved and any edits you want evaluated are part of the last commit before time expires.
```

---

### 8.2 `SETUP.md` skeleton

Copy this, fill placeholders, keep it under 200 lines.

```markdown
# Setup

## Requirements

| Tool | Minimum version |
|---|---|
| <<REPLACE: Python / CMake / Cargo / Node>> | <<REPLACE: 3.11 / 3.14 / 1.75 / 18>> |
| <<REPLACE: compiler/runtime if applicable>> | <<REPLACE: version>> |

## Install

**macOS**
```bash
<<REPLACE: brew install ...>>
\```

**Linux (Debian/Ubuntu)**
```bash
<<REPLACE: sudo apt-get install ...>>
\```

## First build

```bash
<<REPLACE: install and build commands — exact, copy-pasteable>>
```

Expected output:
```
<<REPLACE: paste the last 5–10 lines of a successful first run here>>
```

## Running tests

```bash
<<REPLACE: command to run all tests>>
<<REPLACE: command to run a subset, e.g. pytest -m basic>>
```

## Troubleshooting

**Problem:** `<<REPLACE: error message or symptom>>`
**Fix:** `<<REPLACE: exact command or change to make>>`

**Problem:** `<<REPLACE: error message or symptom>>`
**Fix:** `<<REPLACE: exact command or change to make>>`

**Problem:** `<<REPLACE: error message or symptom>>`
**Fix:** `<<REPLACE: exact command or change to make>>`
```

---

## §9. Token Budgeting

Run this command once after all starter code is written:

```bash
python scripts/measure_repo_tokens.py <<REPLACE: challenge-id>> --force
```

This prints the token count for the challenge tree. Copy the number into `rubric.json::expected_tokens`.

The grader uses it to compute `max_tokens` (the token efficiency denominator) via the formula in §3. If `expected_tokens` is `0`, the token-efficiency score will be meaningless.

**Re-measure when:**
- Starter code files change by more than ~50 lines.
- A new support file or fixture is added.
- A file is removed from the challenge.

Do not hand-tune `expected_tokens` — always use the measured value. The formula already adds a buffer (`× 1.5` plus difficulty tokens), so the measured baseline does not need manual inflation.

---

## §10. Authoring Workflow — End-to-End Checklist

Work through these steps in order. Each step that produces a file references the inline template in this document.

- [ ] **0. Language gate.** Confirm your target language is in §1 "Supported languages today" (Python, C++). If not, choose one path: (a) complete §11.C first, then proceed as a normal challenge; or (b) author it as a **draft** — set `"status": "draft"` in `metadata.json`, follow §11.D for all language-specific pieces, skip step 12 (author self-grade), and know the challenge will not be assignable or scored until promoted. You may also stay strictly inside `challenges/<challenge-id>/` — a challenge author does not edit `server/`, `extension/`, or `worker/`.

- [ ] **1. Create the directory structure**
  ```bash
  mkdir -p challenges/<<REPLACE: challenge-id>>/{.jivahire,tests,<<REPLACE: src>>}
  ```

- [ ] **2. Add `.gitignore`** — copy from §2.

- [ ] **3. Fill in `metadata.json`** — copy template from §4.1, replace all `<<REPLACE>>` markers.

- [ ] **4. Write starter code** with `TODO(candidate):` markers at each trap location. Use the per-language appendix (§11.A Python / §11.B C++) for the build-config snippet — or **§11.D** for any other language (draft mode). Follow the §7 philosophy.

- [ ] **5. Fill in `traps.json`** — copy template from §4.3. For each trap: confirm `detection_tag` matches a tag you will use in the hidden test. Aim for 3–5 traps total.

- [ ] **6. Write the hidden test file** — use the stub from §11.A, §11.B, or **§11.D** (drafts). Cover every `detection_tag` in `traps.json`, every item in the §5 edge-case checklist, and at least one stress/concurrency scenario. Keep it under 600 LOC.

- [ ] **7. Write the public test file** — use the stub from §11.A, §11.B, or **§11.D** (drafts). Most tests pass on the unmodified starter; 1–3 should fail as hints toward the traps.

- [ ] **8. Fill in `rubric.json`** — copy template from §4.2. Fill `tasks` (matching your `detection_tag`s), `code_quality_criteria`, `architectural_criteria`, `starter_code_note`, `submission_files`. Leave `expected_tokens` at `0` for now.

- [ ] **9. Write `README.md` and `SETUP.md`** — copy skeletons from §8, fill all placeholders.

- [ ] **10. Measure token count and set `expected_tokens`** *(skip for drafts — leave at `0`; this is run when the challenge is promoted to active)*
  ```bash
  python scripts/measure_repo_tokens.py <<REPLACE: challenge-id>> --force
  # Copy the printed count into rubric.json::expected_tokens
  ```

- [ ] **11. Size-cap self-check**
  ```bash
  cd challenges/<<REPLACE: challenge-id>>
  du -sh --exclude=.git --exclude=build --exclude=node_modules --exclude=.venv .
  find . -path ./.git -prune -o -path ./build -prune -o -path ./.venv -prune -o -type f -print | wc -l
  wc -l tests/<<REPLACE: public-test-file>> tests/<<REPLACE: hidden-test-file>>
  ```
  Confirm all outputs against the table in §2.

- [ ] **12. Author self-grade (simulate the grader locally)**
  ```bash
  # Clone to temp dir, strip author-only files, inject hidden tests, build, run
  CHALLENGE=<<REPLACE: challenge-id>>
  TMP=$(mktemp -d)
  cp -r challenges/$CHALLENGE $TMP/$CHALLENGE
  # Strip what the candidate branch would not have
  rm -rf $TMP/$CHALLENGE/.jivahire
  # Confirm public tests pass on unmodified starter
  cd $TMP/$CHALLENGE && <<REPLACE: install and run commands from SETUP.md>>
  # Re-inject hidden test and run full suite — should see failures on unmodified starter
  cp challenges/$CHALLENGE/tests/<<REPLACE: hidden-test-file>> $TMP/$CHALLENGE/tests/
  <<REPLACE: run all tests>>
  # Apply your reference fix manually, re-run — all tests should now pass
  ```

- [ ] **13. PR review checklist** — the PR reviewer ticks every item:
  - [ ] All JSON files are schema-valid (no parse errors)
  - [ ] Every tag in `rubric.json::tasks[].test_tag` and `traps.json::traps[].detection_tag` appears in ≥ 1 hidden test
  - [ ] Every tag used in hidden tests appears in `tasks` or `traps`
  - [ ] Size caps from §2 all pass
  - [ ] `starter_code_note` is present and precise
  - [ ] `submission_files` contains only production source files (no test files, no build configs)
  - [ ] Hidden tests fail on the unmodified starter (step 12 verified)
  - [ ] Public tests behave as intended (mostly pass; deliberate failures are hints)
  - [ ] `expected_tokens` is non-zero and was measured by the script
  - [ ] No secrets, credentials, or PII anywhere in the challenge
  - [ ] No compiled binaries or generated artefacts committed

---

## §11. Per-Language Appendices

### §11.A Python

**Directory layout:**
```
challenges/<challenge-id>/
├── .jivahire/
├── src/
│   └── <<REPLACE: module_name>>.py      # submission file
├── tests/
│   ├── test_public.py
│   └── test_hidden.py                   # NOT on candidate branch
├── pyproject.toml
├── README.md
└── SETUP.md
```

**`pyproject.toml`:**
```toml
[build-system]
requires = ["setuptools>=68"]
build-backend = "setuptools.build_meta"

[project]
name = "<<REPLACE: challenge-slug>>"
version = "0.1.0"
description = "<<REPLACE: one-line description>>"
requires-python = ">=3.11"

[project.optional-dependencies]
dev = ["pytest>=8.0"]

[tool.setuptools]
package-dir = {"" = "src"}
py-modules = ["<<REPLACE: module_name>>"]

[tool.pytest.ini_options]
testpaths = ["tests"]
markers = [
    "basic: basic single-threaded correctness",
    "<<REPLACE: tag2>>: <<REPLACE: description>>",
    "edge: edge cases and boundary inputs",
]
```

> Add one `markers` entry per custom tag used in your tests.

**`tests/test_public.py` stub:**
```python
import pytest
from <<REPLACE: module_name>> import <<REPLACE: ClassName>>


@pytest.mark.basic
def test_basic_operation():
    obj = <<REPLACE: ClassName>>(<<REPLACE: args>>)
    obj.<<REPLACE: method>>(<<REPLACE: args>>)
    assert obj.<<REPLACE: query>>() == <<REPLACE: expected>>


@pytest.mark.basic
def test_hinting_failure():
    # This test fails on the unmodified starter, hinting at the <<REPLACE: trap name>> trap.
    obj = <<REPLACE: ClassName>>(<<REPLACE: args>>)
    <<REPLACE: operations that expose the bug>>
    assert <<REPLACE: invariant that fails without the fix>>


@pytest.mark.edge
def test_edge_case():
    obj = <<REPLACE: ClassName>>(<<REPLACE: zero or boundary arg>>)
    <<REPLACE: operation>>
    assert <<REPLACE: expected behaviour>>
```

**`tests/test_hidden.py` stub:**
```python
# Hidden tests — not visible in the candidate's branch.
# Grader copies this file into tests/ before running.
import threading
import pytest
from <<REPLACE: module_name>> import <<REPLACE: ClassName>>


# --- basic ---

@pytest.mark.basic
def test_does_not_exceed_capacity():
    obj = <<REPLACE: ClassName>>(capacity=3, <<REPLACE: other_args>>)
    for i in range(10):
        obj.<<REPLACE: insert>>(i, i)
    assert obj.<<REPLACE: size>>() == 3


# --- <<REPLACE: tag>> ---

@pytest.mark.<<REPLACE: tag>>
def test_concurrent_writes_do_not_corrupt_state():
    obj = <<REPLACE: ClassName>>(capacity=64, <<REPLACE: other_args>>)
    n_threads = 8
    ops = 200

    def worker(t: int) -> None:
        for i in range(ops):
            obj.<<REPLACE: insert>>(t * ops + i, i)

    threads = [threading.Thread(target=worker, args=(t,)) for t in range(n_threads)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()

    assert obj.<<REPLACE: size>>() <= 64


# --- edge ---

@pytest.mark.edge
def test_zero_capacity_is_no_op():
    obj = <<REPLACE: ClassName>>(capacity=0, <<REPLACE: other_args>>)
    obj.<<REPLACE: insert>>(1, 1)
    assert obj.<<REPLACE: size>>() == 0
    assert obj.<<REPLACE: lookup>>(1) is None
```

**Install and run:**
```bash
# Install in editable mode with dev deps
pip install -e ".[dev]"

# Run all tests
pytest

# Run a single tag
pytest -m basic
pytest -m <<REPLACE: tag>>
```

**Grader status:** The Python grader runs `pip install -e ".[dev]"` in the cloned challenge, then `pytest -m <tag>` for every tag declared in `rubric.json::tasks[].test_tag` or `traps.json::traps[].detection_tag`. Each tag is scored independently — a non-zero exit code (including pytest's exit 5 for an unmatched marker) counts as failure for that tag.

---

### §11.B C++

**Directory layout:**
```
challenges/<challenge-id>/
├── .jivahire/
├── include/
│   └── <<REPLACE: header>>.hpp          # submission file (header-only pattern)
├── src/                                 # empty for header-only; add .cpp if needed
├── tests/
│   ├── public_test.cpp
│   └── hidden_test.cpp                  # NOT on candidate branch; MUST be named hidden_test.cpp
├── CMakeLists.txt
├── README.md
└── SETUP.md
```

> **Note:** The grader resolves the hidden test path from `metadata.json::hidden_test_file`, but the CMake glob `file(GLOB tests/*.cpp)` still requires the `.cpp` extension — keep the file named with `.cpp`.

**`CMakeLists.txt`:**
```cmake
cmake_minimum_required(VERSION 3.14)
project(<<REPLACE: challenge_slug>> CXX)

set(CMAKE_CXX_STANDARD 17)
set(CMAKE_CXX_STANDARD_REQUIRED ON)

include(FetchContent)
FetchContent_Declare(
  Catch2
  GIT_REPOSITORY https://github.com/catchorg/Catch2.git
  GIT_TAG        v3.5.2
)
FetchContent_MakeAvailable(Catch2)

file(GLOB TEST_SOURCES tests/*.cpp)

add_executable(tests ${TEST_SOURCES})
target_include_directories(tests PRIVATE include)
target_link_libraries(tests PRIVATE Catch2::Catch2WithMain)
```

The `file(GLOB TEST_SOURCES tests/*.cpp)` line picks up both `public_test.cpp` and the grader-injected `hidden_test.cpp` automatically. The grader builds with `-fsanitize=thread` for the ThreadSanitizer — **your `[thread]` tests will be run under TSan**.

**`tests/public_test.cpp` stub:**
```cpp
#include <catch2/catch_test_macros.hpp>
#include "<<REPLACE: header>>.hpp"

TEST_CASE("basic operation", "[basic]") {
    <<REPLACE: ClassName>><int, int> obj(3);
    obj.put(1, 10);
    REQUIRE(obj.get(1) == std::optional<int>(10));
    REQUIRE(obj.get(99) == std::nullopt);
}

TEST_CASE("hinting failure — <<REPLACE: trap name>>", "[basic]") {
    // This test fails on the unmodified starter, hinting at the <<REPLACE: trap>>.
    <<REPLACE: ClassName>><int, int> obj(2);
    <<REPLACE: operations that expose the bug>>
    REQUIRE(<<REPLACE: invariant that fails without the fix>>);
}

TEST_CASE("edge case", "[edge]") {
    <<REPLACE: ClassName>><int, int> obj(0);
    obj.put(1, 1);
    REQUIRE(obj.size() == 0);
    REQUIRE(obj.get(1) == std::nullopt);
}
```

**`tests/hidden_test.cpp` stub:**
```cpp
// Hidden tests — not visible in the candidate's branch.
// Grader copies this file into tests/ before building.
#include <catch2/catch_test_macros.hpp>
#include <thread>
#include <vector>
#include "<<REPLACE: header>>.hpp"

// --- basic ---

TEST_CASE("does not exceed capacity on repeated insert", "[basic]") {
    <<REPLACE: ClassName>><int, int> obj(3);
    for (int i = 0; i < 10; ++i) obj.put(i, i);
    REQUIRE(obj.size() == 3);
}

// --- thread ---

TEST_CASE("concurrent puts do not corrupt state", "[thread]") {
    <<REPLACE: ClassName>><int, int> obj(64);
    constexpr int N = 8;
    constexpr int OPS = 200;
    std::vector<std::thread> threads;
    for (int t = 0; t < N; ++t) {
        threads.emplace_back([&obj, t] {
            for (int i = 0; i < OPS; ++i) {
                obj.put(t * OPS + i, i);
            }
        });
    }
    for (auto& th : threads) th.join();
    REQUIRE(obj.size() <= 64);
}

// --- edge ---

TEST_CASE("capacity zero is a no-op store", "[edge]") {
    <<REPLACE: ClassName>><int, int> obj(0);
    obj.put(1, 1);
    REQUIRE(obj.size() == 0);
    REQUIRE(obj.get(1) == std::nullopt);
}
```

> **Tags:** Any Catch2 tag you declare in `rubric.json::tasks[].test_tag` or `traps.json::traps[].detection_tag` is run automatically — `cpp_runner.py` discovers the full tag set from those files. No grader edit is required to add `[security]`, `[perf]`, or any other tag.

**Build and run:**
```bash
# Configure and build (first run fetches Catch2 — takes ~1 min)
cmake -B build && cmake --build build -j

# Run all tests
./build/tests

# Run a single tag
./build/tests "[basic]"
./build/tests "[thread]"
./build/tests "[edge]"
```

**`SETUP.md` troubleshooting additions for C++:**

```
Problem: cmake: command not found
Fix: brew install cmake  /  sudo apt-get install cmake

Problem: error: no member named 'optional' in namespace 'std'
Fix: ensure your compiler supports C++17: g++ --version (need >= 7) or clang++ --version (need >= 5)
     on macOS: xcode-select --install

Problem: FETCH_CONTENT hangs or fails
Fix: check network access; or pre-download Catch2 v3.5.2 and set -DFETCHCONTENT_BASE_DIR=<path>
```

---

### §11.D Language-Agnostic Draft Blueprint

Use this appendix when drafting a challenge in any language not covered by §11.A or §11.B (TypeScript, Rust, Go, Kotlin, Swift, Java, C#, Ruby, etc.). Everything here is language-neutral — substitute the conventions of your chosen language.

**This appendix is the grader contract restated in language-neutral terms.** Every requirement below is something the grader will enforce once a runner for your language exists (§11.C). Following §11.D in full produces an artifact that is **grader-compatible by construction**: when the runner is wired, the draft executes correctly with no re-authoring. Skipping any required item produces a non-conformant challenge that will be rejected at promotion, not a "lighter" draft.

#### D.1 Required files (every draft must contain all of these)

```
challenges/<challenge-id>/
├── .jivahire/
│   ├── metadata.json          # §4.1 template — set "status": "draft"
│   ├── rubric.json            # §4.2 template
│   └── traps.json             # §4.3 template
├── README.md                  # §8.1 skeleton
├── SETUP.md                   # §8.2 skeleton
├── .gitignore                 # §2 template (extend for your language)
├── <build-config>             # see D.2
├── <source-dir>/              # starter code with TODO(candidate) markers (§7)
│   └── <implementation-file(s)>
└── tests/
    ├── <public-test-file>     # see D.4
    └── <hidden-test-file>     # see D.5
```

`<source-dir>` and file names follow the host language's convention (e.g. `src/`, `lib/`, `internal/`, `app/`). Keep nesting ≤ 4 levels below the challenge root (§2 size caps).

#### D.2 Build configuration requirements

Whatever build config your language uses (`package.json`, `Cargo.toml`, `go.mod`, `build.gradle`, `pom.xml`, `Gemfile`, `*.csproj`, etc.) MUST:

1. **Pin dependencies.** Declare the test framework and any test-time dependencies with explicit versions. No floating ranges that can break the grader between runs.
2. **Provide two commands:** one to install/restore dependencies, one to run all tests. Both must be runnable from the challenge root, non-interactively, with no `sudo` and no prompts.
3. **Support tag-filtered runs.** The test run command must accept a tag/marker filter argument (see D.3).
4. **Be reproducible from a fresh clone.** No machine-specific paths, no hand-edited lockfiles.

Document both commands in `SETUP.md` (§8.2).

#### D.3 Test framework requirements

You may pick any framework, **provided** it supports all three of:

- **Tag/marker filtering from the command line.** Examples by language (you are not limited to these): pytest `-m <tag>` (Python), Catch2 `[<tag>]` (C++), Vitest/Jest `--grep '@<tag>'` (JS/TS), Cargo `--features <tag>` or `#[cfg(feature)]` (Rust), Go `-run <pattern>` (Go), JUnit `@Tag("<tag>")` + Gradle `--tests` (Java), XCTest `--filter` (Swift).
- **Non-zero exit code on any failure within the filtered set.**
- **Tag strings match exactly** what you declare in `rubric.json::tasks[].test_tag` and `traps.json::traps[].detection_tag` — same casing, same characters. The grader will invoke the framework once per tag.

If your language's idiomatic framework cannot filter by tag, pick a different one. Tag filtering is non-negotiable: it is how each rubric task and trap is scored independently.

#### D.4 Public test file — language-neutral stub

Translate this pseudocode into your language's framework syntax. The public file must be self-evidently runnable by the candidate.

```
# tests/<public-test-file>  — visible to the candidate.
# Most tests should pass on the unmodified starter; 1–3 should fail as hints toward traps.

import <test framework>
import <starter module / class under test>

test "basic operation" tagged [basic]:
    construct the object with valid args
    call the basic method
    assert the expected result

test "hint failure — <neutral name, do not reveal the trap>" tagged [basic]:
    # Designed to fail on the unmodified starter.
    construct the object
    perform an operation sequence that exposes one of the traps
    assert the invariant the trap violates  # this assertion FAILS pre-fix

test "edge — boundary input" tagged [edge]:
    construct with a boundary value (zero / one / max)
    perform an operation
    assert the documented behaviour
```

Hard rules:
- ≤ 300 LOC total.
- Every tag used here is declared in `rubric.json::tasks[].test_tag` *or* `traps.json::traps[].detection_tag` (§6 closure rules).
- Failing-by-design tests must not contain the word identifying the trap (e.g., name it `test_eviction_after_repeated_puts`, not `test_off_by_one_eviction`).

#### D.5 Hidden test file — language-neutral stub

```
# tests/<hidden-test-file>  — NEVER on the candidate branch.
# Covers every detection_tag in traps.json + every applicable §5 edge-case + ≥ 1 stress test.

import <test framework>
import <concurrency primitives / clock / async helpers as needed>
import <starter module / class under test>

# --- basic ---
test "core invariant under repeated operations" tagged [basic]:
    construct with a tight bound (e.g. capacity = 3)
    perform many operations
    assert the bound holds and outputs are correct

# --- thread / concurrent (only if the problem has shared state) ---
test "no corruption under concurrent writers" tagged [thread]:
    construct with a known capacity
    spawn N concurrent workers, each performing M operations
    join all workers
    assert no internal invariant is violated and size is within bounds

# --- edge ---
test "zero / empty / single-element boundary" tagged [edge]:
    construct with the boundary value
    perform a write and a read
    assert the documented edge behaviour

# --- one test per detection_tag in traps.json ---
test "detection: <trap-id>" tagged [<detection_tag>]:
    set up the specific scenario the trap corrupts
    assert the invariant that fails before the fix and holds after
```

Hard rules:
- ≤ 600 LOC total.
- **Every** `detection_tag` from `traps.json` appears on ≥ 1 test here.
- **Every** `test_tag` from `rubric.json::tasks` appears on ≥ 1 test here.
- Hidden tests **fail** on the unmodified starter and **pass** on the reference fix. Verify this manually before publishing the draft.

#### D.6 Starter code conventions

- Provide a working skeleton — data structure choice, function signatures, type definitions — so the candidate is not paying a boilerplate tax.
- Embed each planted trap as a real bug a senior reviewer would flag in production (see §5). Mark each with a `TODO(candidate):` comment (§7) that points at the *area* without naming the *fix*.
- Use comment syntax appropriate to the host language: `//` for JS/TS/Rust/Go/Java/C#/Swift/Kotlin; `#` for Python/Ruby/Shell; `--` for SQL/Haskell; `<!-- -->` for HTML/XML.
- Only files listed in `rubric.json::submission_files` are read by the code-quality evaluator. If your starter spans multiple files (e.g. header + implementation, types + module), list every file the candidate is expected to edit.

#### D.7 `SETUP.md` commands the author must document

The draft's `SETUP.md` (using the §8.2 skeleton) must show concrete copy-pasteable commands for:

1. Installing the toolchain on **macOS** and **Linux (Debian/Ubuntu)** — both blocks required.
2. Installing dependencies (one command, run from the challenge root).
3. Running **all** tests.
4. Running tests filtered by a **single tag** (give one worked example using an actual tag from this challenge).
5. At least **three** troubleshooting entries — common errors the candidate may hit (missing toolchain, version mismatch, network failure during dependency fetch).

While the challenge is a draft, these commands are executed only by human reviewers. Once a grader runner is added per §11.C, the same commands must work non-interactively inside the grader container.

#### D.8 `.gitignore` additions per language

Start from the §2 `.gitignore` template and add the entries your language needs. Common additions:

| Language | Add |
|---|---|
| TypeScript / JavaScript | `node_modules/`, `dist/`, `*.tsbuildinfo`, `coverage/` |
| Rust | `target/`, `Cargo.lock` (only for libraries — keep it for binaries) |
| Go | `vendor/`, `*.test`, `*.out` |
| Java / Kotlin (Gradle) | `.gradle/`, `build/`, `*.class`, `out/` |
| C# / .NET | `bin/`, `obj/`, `*.user`, `.vs/` |
| Swift | `.build/`, `Packages/`, `*.xcodeproj/xcuserdata/` |
| Ruby | `vendor/bundle/`, `.bundle/`, `*.gem` |

Never commit compiled artefacts, lockfile caches, IDE configs, or generated reports.

#### D.9 Actions deferred until a runner exists (not skipped — deferred)

These steps cannot be executed before the §11.C runner is merged because the tooling does not physically exist yet. Every one of them is still **required at promotion** — they are not bypasses.

- `rubric.json::expected_tokens` — leave at `0`. Measured at promotion via the platform's token-measurement script.
- §10 step 12 (author self-grade against the real grader) — no backend yet. **In its place, drafts must perform a manual dry-run with equivalent rigor:** (a) run the public tests on the unmodified starter — should mostly pass with 1–3 hint failures; (b) apply a reference fix and run the public tests — should fully pass; (c) run the hidden tests against the unmodified starter — should fail on every `detection_tag`; (d) run the hidden tests against the reference fix — should fully pass. Record the four outcomes in a comment at the top of the hidden test file. A draft without this dry-run is incomplete.
- The "Grader status" notes that appear in §11.A and §11.B — added when the per-language appendix is written at promotion.

Nothing else may be deferred. Every other item in §§2, 4, 5, 6, 7, 8 of this guide is enforced on drafts identically to active challenges.

#### D.10 What drafts must NOT skip

- All three `.jivahire/` JSON files, valid and complete per §4.
- A precise `starter_code_note` (§3) — without it the architectural-reasoning evaluator will over-credit candidates once the challenge is promoted.
- The §2 size and file-count caps.
- The §5 edge-case checklist.
- The §6 tag closure rules (every declared tag must be used; every used tag should be declared).
- The §1 hard invariants (self-contained, deterministic, reproducible build).

#### D.11 Promotion checklist (when the runner for your language exists)

1. Verify §11.C is complete for this language and the runner is merged.
2. Flip `metadata.json::status` from `"draft"` to `"active"` (or remove the field).
3. Run the platform's token-measurement script and set `rubric.json::expected_tokens` to the result.
4. Run §10 step 12 (author self-grade) end-to-end against the new runner.
5. Optional: contribute a new per-language appendix (§11.X) mirroring §11.A and §11.B, then update §12.

---

### §11.C Onboarding a New Language

To add a language beyond Python and C++, complete every item in this checklist.

- [ ] **1. Implement a grader runner** at `server/vibe/grader/<lang>_runner.py`:
  - Signature: `build_and_test(clone_dir: Path, hidden_test_src: Path, tags: list[str]) -> tuple[dict[str, bool], str]`
  - Steps: copy hidden test into `clone_dir/tests/`, build/install, run per-tag, return `{tag: pass/fail}` and raw output.
  - Mirror `server/vibe/grader/cpp_runner.py` or `server/vibe/grader/python_runner.py` for interface compatibility.

- [ ] **2. Wire the backend into `server/vibe/grader/runner.py`**:
  - Add an entry to `_GRADER_BACKENDS` mapping your language slug (e.g. `"rust"`) to the new runner module.
  - Tag collection and the `metadata["hidden_test_file"]` lookup already happen in `_load_challenge_config` — no further changes needed in `runner.py`.

- [ ] **3. Choose a test framework with tag/marker support**. Requirements:
  - Tests can be filtered by a tag/marker string from the command line.
  - Exit code is non-zero if any test in the filtered set fails.
  - Document the tag syntax in the tagging table in §6.

- [ ] **4. Provide a deterministic build/install command** with a predictable working directory. The runner must be able to invoke it without a shell login. No `sudo`, no interactive prompts.

- [ ] **5. Add a smoke-test challenge** in the new language and run the full grader pipeline end-to-end against it before merging.

- [ ] **6. Update §6** — add the new framework's tag syntax to the "Closure rules" bullet.

- [ ] **7. Update §3** — if the grader runner changes default behaviour (e.g., different tag set, different score aggregation), note it in the per-dimension table.

---

## §12. Maintenance and Update Protocol

### When `GRADING_RUBRICS.md` changes

1. Update the composite formula and per-dimension table in §3.
2. Bump `last_synced_commit`, `last_synced_date`, and `weights_hash` in the front-matter sync block. Recompute `weights_hash` as: `sha256(json.dumps(runner._DEFAULT_WEIGHTS, sort_keys=True))`.
3. Audit §11.A and §11.B for any rubric fields that gained or lost meaning (e.g., if a new dimension is added, update the per-language stubs if they need to expose additional metadata).
4. Add a line to the Changelog below.

### When a new grading dimension is added

1. Add a row to the §3 per-dimension table.
2. Add a "what the author must provide" cell with the concrete action.
3. Add the corresponding field(s) to the `rubric.json` schema table in §4.2 and to the copy-paste template.
4. Update the per-language rubric stubs in §11.A and §11.B if the new field changes per-challenge rubric format.

### When weights change

Only §3 (composite formula, per-dimension table) and the sync block need updating. Per-challenge `rubric.json` files with `composite_weights` overrides are not affected unless the dimension names change.

### When a new language is supported

Complete §11.C, then add a §11.X appendix for the new language following the same structure as §11.A and §11.B.

---

## §13. Glossary

| Term | Definition |
|---|---|
| **challenge_id** | Kebab-case slug uniquely identifying the challenge; matches the directory name and `metadata.json::challenge_id` |
| **composite score** | The weighted sum of all seven grading dimensions; 0–10 scale; formula in §3 |
| **detection_tag** | The test tag in `traps.json` that the grader checks to determine if a trap was fixed |
| **developer confidence** | Separate behavioral score (not in composite) computed from telemetry — file exploration, IDE-native usage, post-AI-edit patterns |
| **starter_code_note** | `rubric.json` field that tells the architectural-reasoning LLM evaluator what design decisions were already made in the starter code and must not be credited |
| **submission_files** | List of files the grader reads for code-quality evaluation; edits outside this list are ignored |
| **tag** | A string label on a test used to group tests by concern; author-defined; used to wire `tasks` and `traps` in `rubric.json` / `traps.json` |
| **token efficiency** | Score (0–10) measuring `actual_tokens / max_tokens`; formula-based, no LLM evaluation |
| **trap** | An intentional planted bug in the starter code; graded via `traps.json` + hidden tests |

**Cross-references:**
- Grading weights and dimensions: [GRADING_RUBRICS.md](GRADING_RUBRICS.md)
- Product vision and candidate flow: [vibe_interview_plan_enhanced.md](vibe_interview_plan_enhanced.md)
- Developer constraints (CLAUDE.md): [CLAUDE.md](CLAUDE.md)
- Grader implementation: [server/vibe/grader/](server/vibe/grader/)
- Token measurement: [scripts/measure_repo_tokens.py](scripts/measure_repo_tokens.py)
- Reference challenge (Python): [challenges/python-ttl-cache/](challenges/python-ttl-cache/)
- Reference challenge (C++): [challenges/cpp-lru-cache/](challenges/cpp-lru-cache/)

---

## Changelog

| Date | Change | Synced from |
|---|---|---|
| 2026-05-14 | Initial version | `GRADING_RUBRICS.md` @ `db5987e` |
| 2026-05-14 | C++ grader now discovers tags dynamically from `rubric.json`/`traps.json`; Python grader backend implemented; hidden-test path now driven by `metadata.json::hidden_test_file`. Updated §6 C++ note, §11.A grader status, §11.B Critical/Tag-constraint callouts, §11.C onboarding checklist. | grader refactor |
