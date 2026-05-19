"""Author-facing documentation endpoints.

Exposes redacted versions of the challenge-authoring guide and a qualitative
grading overview to trusted authors. Both endpoints require the admin token.

The HTML content is frozen at module-import time as Python triple-string
constants. The original CHALLENGE_AUTHORING.md / GRADING_RUBRICS.md files
on disk are NEVER read at request time, and sensitive content (composite
weights, behavioural-signal field names, internal grader file paths, live
trap descriptions, etc.) has been redacted by hand.
"""

from fastapi import APIRouter, Header, HTTPException
from fastapi.responses import HTMLResponse

from vibe.config import settings

router = APIRouter(prefix="/api/v1/admin/author-docs")


# ────────────────────────────────────────────────────────────────────────────
# Authoring guide — redacted HTML fragment.
# Excludes: §3 Grading Contract, §5 trap taxonomy + edge-case checklist,
# token baseline formula constants, TSan note, sync block, all internal-path
# references, §11.C, §12, §13 cross-references, and live-trap example
# descriptions in §3 / §4.3.
# ────────────────────────────────────────────────────────────────────────────
_GUIDE_HTML = """
<h2>Challenge Authoring Guide</h2>
<p>This page is the authoritative reference for creating a new challenge.
It is <strong>self-sufficient</strong>: an author following it from a clean
checkout, with no other file open, can produce a working challenge the
grader pipeline accepts end-to-end. Every required file is represented
here as a copy-pasteable code block with <code>&lt;&lt;REPLACE:&nbsp;…&gt;&gt;</code>
markers for placeholder values.</p>

<p><strong>Who this is for:</strong> Anyone adding a new challenge to
<code>challenges/</code>. No prior knowledge of the grader codebase is required.</p>

<p><strong>How to use this document:</strong> Read §§1–2 once for orientation,
then work through the §10 checklist step-by-step. §§4–9 are reference
material — jump to them when the checklist points you there. §11 has
per-language appendices with copy-pasteable code.</p>

<h2>§1. What a Challenge Is</h2>
<p>A challenge is a <strong>deliberately imperfect starter codebase</strong> —
partially working code with planted bugs (traps), a public test suite the
candidate can run, a hidden test suite the grader runs on submission, and
machine-readable metadata the grader uses to score the result. The candidate
never sees the traps or hidden tests; discovering and fixing the traps is
part of what is being evaluated. Candidates are <em>encouraged</em> to use AI;
the platform specifically measures the quality of that AI use alongside the
code.</p>

<p>Every challenge targets a single focused problem that an experienced
engineer could complete in 45–90 minutes with AI assistance. The starter
code provides the boilerplate and data-structure choices so the candidate
spends their time on the interesting parts — correctness, concurrency
safety, edge-case handling, and thoughtful AI orchestration — not setup.</p>

<h3>Supported languages today</h3>
<p>The grading pipeline runs <strong>Python</strong> (§11.A),
<strong>C++</strong> (§11.B), and <strong>TypeScript</strong> (§11.E).
Hidden tests in any other language will not execute and the challenge will
not score.</p>

<h3>Drafting in an unsupported language</h3>
<p><strong>Hard rule: every challenge — draft or active — must be
grader-compatible by construction.</strong> A draft is a challenge whose
runner does not yet exist; the moment a runner is added, the draft must
execute correctly with no re-authoring. If §11.D's contract cannot be met
in your chosen language (no tag-filtering framework, no non-interactive
build, no exact-string tag match), do not author in that language until
the platform supports it.</p>

<p>To prototype a challenge in a language the grader doesn't yet support
(Rust, Go, etc.) mark it as a <strong>draft</strong>:</p>
<ul>
  <li>Set <code>"status": "draft"</code> in <code>metadata.json</code> (see §4.1).</li>
  <li>Pick any <code>language</code> slug and any <code>grader</code> value — they are not enforced for drafts, but they must match what the eventual runner will use.</li>
  <li>Author the full challenge tree per <strong>§11.D Language-Agnostic Draft Blueprint</strong> — that appendix is self-contained and defines the grader contract in a language-neutral way.</li>
  <li>Drafts are <strong>never assigned to candidates and never graded</strong> until promotion. Session creation rejects draft challenges.</li>
</ul>

<h3>Hard invariants</h3>
<p>Every challenge MUST satisfy all of the following before it can be used:</p>
<ol>
  <li><strong>Self-contained.</strong> No network calls during tests. No external services beyond what <code>docker-compose.yml</code> in the repo root provides. All test dependencies are fetched at build time or installed via the package manager.</li>
  <li><strong>Deterministic tests.</strong> No flaky timing assumptions except in tests tagged <code>thread</code> or <code>ttl</code>, which must be designed to be robust (generous timeouts, no wall-clock sleeps under 50 ms, deterministic thread counts).</li>
  <li><strong>Reproducible build.</strong> A fresh clone + the commands in <code>SETUP.md</code> must produce a working test run with no manual steps.</li>
  <li><strong><code>.jivahire/</code> present in the challenge repo, stripped from the candidate branch.</strong> The session-creation code removes <code>.jivahire/</code> before the candidate clones. See §6 for the hidden test file convention.</li>
  <li><strong>Public tests mostly pass on the unmodified starter.</strong> Failing public tests are hints toward traps, not showstoppers.</li>
  <li><strong>Every planted trap is detectable via a tagged hidden test.</strong> No invisible traps — if the grading pipeline cannot automatically confirm the trap was fixed, it does not score.</li>
</ol>

<h2>§2. Repository Layout</h2>
<p>Every challenge follows this directory structure exactly:</p>
<pre class="code-block"><code>challenges/&lt;challenge-id&gt;/
├── .jivahire/                  # GRADER-ONLY — stripped from candidate branch
│   ├── metadata.json           # discovery: language, difficulty, test file paths
│   ├── rubric.json             # scoring: tasks, criteria, submission_files, weights
│   └── traps.json              # planted bugs: id, detection_tag, severity
├── README.md                   # candidate-facing: problem, commands, AI policy
├── SETUP.md                    # candidate-facing: prerequisites, install, troubleshoot
├── &lt;build-config&gt;              # e.g. pyproject.toml, CMakeLists.txt, Cargo.toml
├── &lt;source-dir&gt;/               # starter code with TODO(candidate) markers
│   └── &lt;implementation-file&gt;
└── tests/
    ├── &lt;public-test-file&gt;      # visible to candidate; mostly passes on starter
    └── &lt;hidden-test-file&gt;      # NOT on candidate branch; grader injects at runtime</code></pre>

<p><strong>Naming:</strong> <code>challenge_id</code> is kebab-case
<code>&lt;language&gt;-&lt;topic&gt;</code> (e.g., <code>python-ttl-cache</code>,
<code>cpp-lru-cache</code>). The directory name must match
<code>challenge_id</code> in <code>metadata.json</code>.</p>

<h3>Who reads what</h3>
<table class="schema-table">
<thead><tr><th>File</th><th>Read by</th><th>When</th><th>Never seen by</th></tr></thead>
<tbody>
  <tr><td><code>.jivahire/</code></td><td>Grader server</td><td>Scoring time</td><td>Candidate</td></tr>
  <tr><td><code>README.md</code></td><td>Candidate</td><td>Start of interview</td><td>—</td></tr>
  <tr><td><code>SETUP.md</code></td><td>Candidate</td><td>Before/during interview</td><td>—</td></tr>
  <tr><td><code>&lt;public-test-file&gt;</code></td><td>Candidate + grader</td><td>Anytime</td><td>—</td></tr>
  <tr><td><code>&lt;hidden-test-file&gt;</code></td><td>Grader only</td><td>Injected before build</td><td>Candidate</td></tr>
  <tr><td><code>&lt;source-dir&gt;/</code></td><td>Candidate + grader</td><td>Editing + scoring</td><td>—</td></tr>
</tbody>
</table>

<h3>Size and count limits</h3>
<p>The platform clones challenges to candidate machines, tokenises the full
tree for LLM evaluators, and runs tests inside a time-bounded grader
container. Bloat hurts every stage. These are hard caps — challenges
exceeding them are rejected at PR review.</p>

<table class="schema-table">
<thead><tr><th>Bucket</th><th>Hard cap</th><th>Rationale</th></tr></thead>
<tbody>
  <tr><td>Total repo size (excl. <code>.git/</code>, <code>build/</code>, <code>node_modules/</code>, <code>.venv/</code>, binary fixtures)</td><td><strong>5 MB</strong></td><td>Clone + grader payload must be small</td></tr>
  <tr><td>Total file count (same exclusions)</td><td><strong>60 files</strong></td><td>Keeps tree navigable in a 45–90 min interview</td></tr>
  <tr><td>Submission files (<code>submission_files</code> in rubric)</td><td><strong>≤ 5 files, ≤ 400 LOC each, ≤ 1,200 LOC total</strong></td><td>LLM code-quality evaluator context window</td></tr>
  <tr><td>Read-only support source (helpers, fixtures, types)</td><td><strong>≤ 15 files, ≤ 2,500 LOC total</strong></td><td>Enough context; not a reading exercise</td></tr>
  <tr><td>Public test file</td><td><strong>1 file, ≤ 300 LOC</strong></td><td>Candidate must be able to skim it</td></tr>
  <tr><td>Hidden test file</td><td><strong>1 file, ≤ 600 LOC</strong></td><td>Grader runs it on every submission</td></tr>
  <tr><td>Each <code>.jivahire/</code> JSON file</td><td><strong>≤ 50 KB</strong></td><td>Machine-read; bloated criteria → poor LLM evals</td></tr>
  <tr><td><code>README.md</code></td><td><strong>≤ 400 lines</strong></td><td>Won't be read if it doesn't fit on a screen</td></tr>
  <tr><td><code>SETUP.md</code></td><td><strong>≤ 200 lines</strong></td><td>Setup only; no challenge content</td></tr>
  <tr><td>Binary / fixture assets</td><td><strong>≤ 500 KB combined, ≤ 5 files</strong></td><td>Prefer programmatic fixture generators</td></tr>
  <tr><td><code>expected_tokens</code> (measured via <code>scripts/measure_repo_tokens.py</code>)</td><td><strong>≤ 60,000 tokens</strong></td><td>Above this, token-efficiency baselines lose meaning</td></tr>
  <tr><td>Directory nesting depth below <code>challenges/&lt;challenge-id&gt;/</code></td><td><strong>≤ 4 levels</strong></td><td>Deep paths make <code>submission_files</code> fragile</td></tr>
</tbody>
</table>

<p><strong>Rules:</strong></p>
<ul>
  <li>Caps apply to the committed repo, before grader injection.</li>
  <li>To exceed a cap, add a <code>"size_exceptions"</code> block to <code>rubric.json</code> (see §4) and get explicit PR sign-off.</li>
  <li>No binaries in <code>submission_files</code>. No generated artefacts committed (see <code>.gitignore</code> below).</li>
</ul>

<h3>Copy-paste .gitignore for a new challenge</h3>
<pre class="code-block"><code># Build artefacts
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
Thumbs.db</code></pre>

<h2>§4. The <code>.jivahire/</code> Metadata Files</h2>

<h3>4.1 <code>metadata.json</code> — full schema</h3>
<table class="schema-table">
<thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Controls</th></tr></thead>
<tbody>
  <tr><td><code>challenge_id</code></td><td>string</td><td>yes</td><td>Must match the directory name exactly</td></tr>
  <tr><td><code>title</code></td><td>string</td><td>yes</td><td>Human-readable title shown in the recruiter dashboard</td></tr>
  <tr><td><code>language</code></td><td>string</td><td>yes</td><td><code>"python"</code>, <code>"cpp"</code>, or a future language slug</td></tr>
  <tr><td><code>difficulty</code></td><td>string</td><td>yes</td><td><code>"junior"</code>, <code>"mid"</code>, or <code>"senior"</code></td></tr>
  <tr><td><code>estimated_minutes</code></td><td>int</td><td>yes</td><td>Displayed to candidate as target time</td></tr>
  <tr><td><code>max_minutes</code></td><td>int</td><td>yes</td><td>Hard time limit; triggers auto-submit on expiry</td></tr>
  <tr><td><code>tags</code></td><td>string[]</td><td>yes</td><td>Searchable tags (e.g., <code>["concurrency", "data-structures"]</code>)</td></tr>
  <tr><td><code>public_test_file</code></td><td>string</td><td>yes</td><td>Path relative to challenge root</td></tr>
  <tr><td><code>hidden_test_file</code></td><td>string</td><td>yes</td><td>Path relative to challenge root; injected by grader</td></tr>
  <tr><td><code>grader</code></td><td>string</td><td>yes</td><td>Grader backend slug (see per-language appendix)</td></tr>
  <tr><td><code>status</code></td><td>string</td><td>no</td><td><code>"active"</code> (default) or <code>"draft"</code>. Draft challenges are excluded from session assignment and grading. For drafts, <code>language</code> and <code>grader</code> are not validated.</td></tr>
</tbody>
</table>

<p><strong>Copy-paste template:</strong></p>
<pre class="code-block"><code>{
  "challenge_id": "&lt;&lt;REPLACE: lang-topic&gt;&gt;",
  "title": "&lt;&lt;REPLACE: Human-Readable Title&gt;&gt;",
  "language": "&lt;&lt;REPLACE: python|cpp&gt;&gt;",
  "difficulty": "&lt;&lt;REPLACE: junior|mid|senior&gt;&gt;",
  "estimated_minutes": 45,
  "max_minutes": 90,
  "tags": ["&lt;&lt;REPLACE: tag1&gt;&gt;", "&lt;&lt;REPLACE: tag2&gt;&gt;"],
  "public_test_file": "tests/&lt;&lt;REPLACE: test_public.py|public_test.cpp&gt;&gt;",
  "hidden_test_file": "tests/&lt;&lt;REPLACE: test_hidden.py|hidden_test.cpp&gt;&gt;",
  "grader": "&lt;&lt;REPLACE: cpp|python&gt;&gt;"
}</code></pre>

<p><em>For drafts:</em> add <code>"status": "draft"</code> as a top-level field.
<code>language</code> and <code>grader</code> can be any string you like — they
are not enforced. Omit <code>status</code> (or set it to <code>"active"</code>)
for normal challenges.</p>

<h3>4.2 <code>rubric.json</code> — full schema</h3>
<table class="schema-table">
<thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Controls</th></tr></thead>
<tbody>
  <tr><td><code>challenge_id</code></td><td>string</td><td>yes</td><td>Must match <code>metadata.json</code></td></tr>
  <tr><td><code>title</code></td><td>string</td><td>yes</td><td>Used in LLM evaluator prompts</td></tr>
  <tr><td><code>description</code></td><td>string</td><td>yes</td><td>Task summary fed to all LLM evaluators (~2 sentences)</td></tr>
  <tr><td><code>language</code></td><td>string</td><td>yes</td><td>Determines syntax highlighting in recruiter view</td></tr>
  <tr><td><code>code_fence</code></td><td>string</td><td>yes</td><td>Code block language hint (e.g., <code>"python"</code>, <code>"cpp"</code>)</td></tr>
  <tr><td><code>difficulty</code></td><td>string</td><td>yes</td><td>Used in token baseline formula</td></tr>
  <tr><td><code>estimated_minutes</code></td><td>int</td><td>yes</td><td>Sanity check for <code>expected_tokens</code></td></tr>
  <tr><td><code>max_minutes</code></td><td>int</td><td>yes</td><td>Mirror of <code>metadata.json</code></td></tr>
  <tr><td><code>submission_files</code></td><td>string[]</td><td>yes</td><td>Paths the code-quality evaluator reads; nothing else is graded</td></tr>
  <tr><td><code>starter_code_note</code></td><td>string</td><td>yes</td><td>Tells the architectural-reasoning evaluator what NOT to credit</td></tr>
  <tr><td><code>code_quality_criteria</code></td><td>string[]</td><td>yes</td><td>4–8 bullet points; fed verbatim to the code-quality LLM evaluator</td></tr>
  <tr><td><code>architectural_criteria</code></td><td>string[]</td><td>yes</td><td>4–8 bullet points; fed to the architectural-reasoning evaluator</td></tr>
  <tr><td><code>tasks</code></td><td>object[]</td><td>yes</td><td>One entry per test tag; maps tag to point value</td></tr>
  <tr><td><code>tasks[].id</code></td><td>string</td><td>yes</td><td>Unique within the challenge</td></tr>
  <tr><td><code>tasks[].points</code></td><td>int</td><td>yes</td><td>Relative weight (used in rubric display; actual scoring via <code>composite_weights</code>)</td></tr>
  <tr><td><code>tasks[].test_tag</code></td><td>string</td><td>yes</td><td>Must match a tag used in the hidden test file</td></tr>
  <tr><td><code>composite_weights</code></td><td>object</td><td>no</td><td>Override default weights; must sum to 1.0 if provided; merges with defaults</td></tr>
  <tr><td><code>total_points</code></td><td>int</td><td>yes</td><td>Sum of <code>tasks[].points</code>; for display only</td></tr>
  <tr><td><code>expected_tokens</code></td><td>int</td><td>yes</td><td>Measured via <code>scripts/measure_repo_tokens.py</code>; used in token efficiency scoring</td></tr>
  <tr><td><code>size_exceptions</code></td><td>object[]</td><td>no</td><td>Justify cap overrides; requires PR reviewer sign-off</td></tr>
</tbody>
</table>

<p><strong>Copy-paste template (annotated):</strong></p>
<pre class="code-block"><code>{
  "challenge_id": "&lt;&lt;REPLACE: lang-topic&gt;&gt;",
  "title": "&lt;&lt;REPLACE: Human-Readable Title&gt;&gt;",
  "description": "&lt;&lt;REPLACE: 1-2 sentence task summary — what the candidate must do and why it is hard.&gt;&gt;",
  "language": "&lt;&lt;REPLACE: python|cpp&gt;&gt;",
  "code_fence": "&lt;&lt;REPLACE: python|cpp&gt;&gt;",
  "difficulty": "&lt;&lt;REPLACE: junior|mid|senior&gt;&gt;",
  "estimated_minutes": 45,
  "max_minutes": 90,

  "submission_files": [
    "&lt;&lt;REPLACE: src/my_module.py&gt;&gt;"
  ],

  "starter_code_note": "The hash table implementation (separate-chaining with linked lists) is provided in the starter. Do NOT credit the candidate for the data structure choice — only their additions: fixing the resize trigger threshold, handling hash collisions on delete, and adding bounds checks on the load factor.",

  "code_quality_criteria": [
    "Correctness (does it pass the tests and fix the planted traps?)",
    "&lt;&lt;REPLACE: language-specific idiom criterion&gt;&gt;",
    "&lt;&lt;REPLACE: idiomatic-use criterion&gt;&gt;",
    "Clarity and naming"
  ],

  "architectural_criteria": [
    "&lt;&lt;REPLACE: key design decision 1&gt;&gt;",
    "&lt;&lt;REPLACE: key design decision 2&gt;&gt;",
    "&lt;&lt;REPLACE: key design decision 3&gt;&gt;",
    "Edge case handling (&lt;&lt;REPLACE: list the specific edge cases relevant to this challenge&gt;&gt;)"
  ],

  "tasks": [
    {"id": "basic",   "points": 30, "test_tag": "basic"},
    {"id": "&lt;&lt;REPLACE: task_id&gt;&gt;", "points": 40, "test_tag": "&lt;&lt;REPLACE: tag&gt;&gt;"},
    {"id": "edge",    "points": 30, "test_tag": "edge"}
  ],

  "total_points": 100,

  "expected_tokens": 0
}</code></pre>

<p>Leave <code>expected_tokens</code> as <code>0</code> initially; populate it
in step 10 of the §10 checklist after running
<code>scripts/measure_repo_tokens.py</code>.</p>

<p>Omit <code>composite_weights</code> to use system defaults. If you must
override, include all keys explicitly and ensure they sum to 1.0 — see the
Grading Overview page for the qualitative dimension list. Per-challenge weight
overrides should be rare and require reviewer sign-off.</p>

<h3>4.3 <code>traps.json</code> — full schema</h3>
<table class="schema-table">
<thead><tr><th>Field</th><th>Type</th><th>Required</th><th>Controls</th></tr></thead>
<tbody>
  <tr><td><code>traps</code></td><td>object[]</td><td>yes</td><td>Array of trap definitions</td></tr>
  <tr><td><code>traps[].id</code></td><td>string</td><td>yes</td><td>Unique slug; shown in grader logs</td></tr>
  <tr><td><code>traps[].description</code></td><td>string</td><td>yes</td><td>What the bug is and where; grader narrative and recruiter view</td></tr>
  <tr><td><code>traps[].detection_tag</code></td><td>string</td><td>yes</td><td>Tag used by the hidden test that fails if this trap is NOT fixed</td></tr>
  <tr><td><code>traps[].severity</code></td><td>int</td><td>yes</td><td><code>1</code> minor, <code>2</code> moderate, <code>3</code> critical — weighted scoring</td></tr>
  <tr><td><code>traps[].points</code></td><td>int</td><td>no</td><td>Legacy display field; not used in scoring formula</td></tr>
</tbody>
</table>

<p><strong>Copy-paste template (one entry per severity tier, with
synthetic illustrative bugs — do not reuse these descriptions in a real
challenge):</strong></p>
<pre class="code-block"><code>{
  "traps": [
    {
      "id": "&lt;&lt;REPLACE: severity-1-trap-id&gt;&gt;",
      "description": "Magic number 86400 used inline where a named SECONDS_PER_DAY constant would be clearer.",
      "detection_tag": "&lt;&lt;REPLACE: matching-test-tag&gt;&gt;",
      "severity": 1
    },
    {
      "id": "&lt;&lt;REPLACE: severity-2-trap-id&gt;&gt;",
      "description": "Sort comparator inverts the order for ties, producing non-deterministic output on equal keys.",
      "detection_tag": "&lt;&lt;REPLACE: matching-test-tag&gt;&gt;",
      "severity": 2
    },
    {
      "id": "&lt;&lt;REPLACE: severity-3-trap-id&gt;&gt;",
      "description": "Input string is concatenated directly into a SQL query, allowing injection.",
      "detection_tag": "&lt;&lt;REPLACE: matching-test-tag&gt;&gt;",
      "severity": 3
    }
  ]
}</code></pre>

<h3>4.4 Common authoring mistakes</h3>
<table class="schema-table">
<thead><tr><th>Mistake</th><th>Symptom</th><th>Fix</th></tr></thead>
<tbody>
  <tr><td><code>submission_files</code> contains a test file</td><td>Grader credits the candidate for editing their own tests</td><td>Only list production source files</td></tr>
  <tr><td><code>detection_tag</code> typo or casing mismatch</td><td>Trap is never marked detected even when fixed</td><td>Double-check against the tag string in the hidden test</td></tr>
  <tr><td><code>composite_weights</code> does not sum to 1.0</td><td>Composite score silently wrong</td><td>Always include all keys summing to exactly 1.0</td></tr>
  <tr><td><code>difficulty</code> missing</td><td>Token baseline silently falls back to <code>"mid"</code></td><td>Always set explicitly</td></tr>
  <tr><td><code>code_quality_criteria</code> is empty</td><td>LLM evaluator gets a generic prompt; scores regress to the mean</td><td>Provide 4+ concise, challenge-specific bullets</td></tr>
  <tr><td><code>starter_code_note</code> absent or vague</td><td>Architectural-reasoning evaluator credits inherited design choices</td><td>Write it precisely — name the exact structures and algorithms provided</td></tr>
  <tr><td>Hidden test uses a tag not in <code>tasks</code> or <code>traps</code></td><td>Tag produces no score signal (orphan tag)</td><td>Add a <code>tasks</code> entry or a <code>traps</code> entry referencing that tag</td></tr>
  <tr><td><code>expected_tokens</code> left at <code>0</code></td><td>Token efficiency score is meaningless</td><td>Run <code>scripts/measure_repo_tokens.py</code> and populate the field</td></tr>
</tbody>
</table>

<h2>§5. Designing Traps</h2>
<p>Traps should be bugs a senior engineer would flag in a production
code review — not puzzles, not academic gotchas. Aim for <strong>3–5
traps per challenge</strong> spread across severity tiers (severity 1
minor / cosmetic, severity 2 incorrect-but-non-fatal behaviour, severity 3
data loss / security / silent corruption). Each trap must have a
<strong>single clear fix</strong> and must map to <strong>exactly one
<code>detection_tag</code></strong> on a hidden test. Avoid all-severity-1
challenges (no scoring impact) and multiple severity-3 traps (too
punishing).</p>

<h2>§6. Tests: Visible vs. Hidden, Tagging Discipline</h2>

<h3>Public test file</h3>
<ul>
  <li>Lives at <code>metadata.json::public_test_file</code>.</li>
  <li>The candidate sees it, runs it, and may read it as a spec.</li>
  <li>Most tests should pass on the unmodified starter. A few should fail intentionally — these act as hints toward traps.</li>
  <li>Do not name failing tests in a way that names the trap directly.</li>
  <li>Keep it under 300 LOC.</li>
</ul>

<h3>Hidden test file</h3>
<ul>
  <li>Lives at <code>metadata.json::hidden_test_file</code> <strong>in the challenge repo on the grader server</strong>.</li>
  <li>The hidden test is <strong>not</strong> committed inside <code>.jivahire/</code>; it lives in <code>tests/</code> alongside the public test file. The session-creation code excludes it from the candidate branch (same mechanism as <code>.jivahire/</code>).</li>
  <li>The grader copies it into the cloned candidate branch before building/running.</li>
  <li><strong>C++ note:</strong> The grader reads <code>hidden_test_file</code> from <code>metadata.json</code>. For C++ challenges, name the file <code>hidden_test.cpp</code> — the CMake glob in the challenge <code>CMakeLists.txt</code> requires the <code>.cpp</code> extension to pick it up.</li>
  <li>Must cover: every trap (via <code>detection_tag</code>), every applicable edge case, plus at least one stress test proportional to difficulty.</li>
  <li>Keep it under 600 LOC.</li>
</ul>

<h3>Tagging discipline</h3>
<p>Tags are an <strong>open vocabulary</strong> — define whatever tags your
challenge needs. Declare them in <code>rubric.json::tasks[].test_tag</code>
and <code>traps.json::traps[].detection_tag</code>, and register them with
the test framework.</p>

<p>Conventional starting points:</p>
<table class="schema-table">
<thead><tr><th>Tag</th><th>Typical meaning</th><th>Typical use</th></tr></thead>
<tbody>
  <tr><td><code>basic</code></td><td>Single-threaded correctness</td><td>API shape, return values, simple sequences, eviction ordering</td></tr>
  <tr><td><code>thread</code></td><td>Concurrent / data-race</td><td>Spawn N threads, assert invariants, no corruption</td></tr>
  <tr><td><code>edge</code></td><td>Boundary / pathological inputs</td><td>Zero capacity, empty, max int, move-only types</td></tr>
  <tr><td><code>ttl</code></td><td>Time-based expiry</td><td>Sleep + assert, TTL refresh on write</td></tr>
</tbody>
</table>

<p>Other tags a challenge might legitimately introduce: <code>security</code>,
<code>validation</code>, <code>network</code>, <code>io</code>,
<code>unicode</code>, <code>error-handling</code>, <code>migration</code>,
<code>regression</code>, <code>perf</code>, <code>memory</code>,
<code>recovery</code>, <code>auth</code>, <code>serialization</code>,
<code>compat</code>. Pick names that describe <strong>what the test
asserts</strong>, not how it asserts.</p>

<p><strong>Tag naming rules:</strong></p>
<ul>
  <li>Lowercase, kebab-case or single word; no spaces.</li>
  <li>Verb-free — describe the property under test.</li>
  <li>Stable across <code>rubric.json</code>, <code>traps.json</code>, and the test file. No aliasing.</li>
</ul>

<p><strong>Closure rules (grader enforcement):</strong></p>
<ul>
  <li>Every tag in <code>rubric.json::tasks[].test_tag</code> and <code>traps.json::traps[].detection_tag</code> MUST appear on ≥ 1 hidden test.</li>
  <li>Every tag used by a test SHOULD appear in <code>tasks</code> or <code>traps</code> — orphan tags produce no score.</li>
</ul>

<h2>§7. Starter Code Philosophy</h2>
<p>The starter code occupies a narrow target: <strong>not blank</strong>
(no boilerplate tax) and <strong>not finished</strong> (nothing for the
candidate to do). The right calibration is a working skeleton with
deliberate bugs and explicit gaps.</p>

<p><strong>Principles:</strong></p>
<ul>
  <li>Provide the data structure and algorithmic skeleton. State clearly in <code>starter_code_note</code> what was provided so the grader doesn't credit it.</li>
  <li>Mark every trap location with a <code>TODO(candidate):</code> comment that <strong>describes the area to revisit</strong> without naming the bug. The comment should guide attention without revealing the fix.</li>
  <li>Failing public tests are already a signal; <code>TODO</code> comments are a second, softer signal. Together they give candidates enough breadcrumb to find the traps within the time budget.</li>
  <li>Only files in <code>submission_files</code> are graded. If you want a two-file change (e.g., header + implementation), list both.</li>
</ul>

<p><strong>Good <code>TODO(candidate):</code> example</strong> (language-neutral form — adapt comment syntax to your host language):</p>
<pre class="code-block"><code>// TODO(candidate): the eviction condition below has an off-by-one error.
//                  A full cache should evict before inserting, but currently
//                  it allows the cache to grow one entry beyond capacity.
while (size &gt; capacity) { ... }</code></pre>

<p><strong>Bad <code>TODO(candidate):</code> example:</strong></p>
<pre class="code-block"><code>// TODO(candidate): fix the &gt; to &gt;=
while (size &gt; capacity) { ... }</code></pre>

<p>The good example describes the invariant that is violated; the bad one
just tells the candidate the answer.</p>

<h2>§8. Candidate-Facing Documents</h2>

<h3>8.1 <code>README.md</code> skeleton</h3>
<p>Copy this, fill placeholders, keep it under 400 lines.</p>
<pre class="code-block"><code># &lt;&lt;REPLACE: Challenge Title&gt;&gt;

## The Task

&lt;&lt;REPLACE: 2-3 sentence description of the problem. What exists, what is broken, what the candidate must produce.&gt;&gt;

## What you must deliver

1. &lt;&lt;REPLACE: Acceptance criterion 1, e.g. All public tests pass.&gt;&gt;
2. &lt;&lt;REPLACE: Acceptance criterion 2, e.g. The implementation is thread-safe under concurrent access.&gt;&gt;
3. &lt;&lt;REPLACE: Acceptance criterion 3, e.g. Edge cases (capacity=0, TTL expiry) are handled correctly.&gt;&gt;

## How to build and run tests

&lt;&lt;REPLACE: Copy the relevant block from §11.A (Python) or §11.B (C++) and adapt.&gt;&gt;

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

**Auto-submit fires when the timer reaches 0.** Make sure your changes are saved and any edits you want evaluated are part of the last commit before time expires.</code></pre>

<h3>8.2 <code>SETUP.md</code> skeleton</h3>
<p>Copy this, fill placeholders, keep it under 200 lines.</p>
<pre class="code-block"><code># Setup

## Requirements

| Tool | Minimum version |
|---|---|
| &lt;&lt;REPLACE: Python / CMake / Cargo / Node&gt;&gt; | &lt;&lt;REPLACE: 3.11 / 3.14 / 1.75 / 18&gt;&gt; |
| &lt;&lt;REPLACE: compiler/runtime if applicable&gt;&gt; | &lt;&lt;REPLACE: version&gt;&gt; |

## Install

**macOS**
```bash
&lt;&lt;REPLACE: brew install ...&gt;&gt;
```

**Linux (Debian/Ubuntu)**
```bash
&lt;&lt;REPLACE: sudo apt-get install ...&gt;&gt;
```

## First build

```bash
&lt;&lt;REPLACE: install and build commands — exact, copy-pasteable&gt;&gt;
```

## Running tests

```bash
&lt;&lt;REPLACE: command to run all tests&gt;&gt;
&lt;&lt;REPLACE: command to run a subset, e.g. pytest -m basic&gt;&gt;
```

## Troubleshooting

**Problem:** &lt;&lt;REPLACE: error message or symptom&gt;&gt;
**Fix:** &lt;&lt;REPLACE: exact command or change to make&gt;&gt;</code></pre>

<h2>§9. Token Budgeting</h2>
<p>Run this command once after all starter code is written:</p>
<pre class="code-block"><code>python scripts/measure_repo_tokens.py &lt;&lt;REPLACE: challenge-id&gt;&gt; --force</code></pre>

<p>This prints the token count for the challenge tree. Copy the number into
<code>rubric.json::expected_tokens</code>. The grading pipeline uses it
to compute the token-efficiency denominator; if <code>expected_tokens</code>
is <code>0</code>, the score is meaningless.</p>

<p><strong>Re-measure when:</strong></p>
<ul>
  <li>Starter code files change by more than ~50 lines.</li>
  <li>A new support file or fixture is added.</li>
  <li>A file is removed from the challenge.</li>
</ul>

<p>Do not hand-tune <code>expected_tokens</code> — always use the measured
value. The grading formula already adds a buffer, so the measured baseline
does not need manual inflation.</p>

<h2>§10. Authoring Workflow — End-to-End Checklist</h2>
<p>Work through these steps in order. Each step that produces a file
references the inline template in this document.</p>
<ol>
  <li><strong>Language gate.</strong> Confirm your target language is supported (Python, C++, TypeScript). If not, author it as a <strong>draft</strong> — set <code>"status": "draft"</code> in <code>metadata.json</code>, follow §11.D for all language-specific pieces, skip the author self-grade step, and know the challenge will not be assignable or scored until promoted.</li>
  <li><strong>Create the directory structure</strong><br>
    <code>mkdir -p challenges/&lt;&lt;REPLACE: challenge-id&gt;&gt;/{.jivahire,tests,&lt;&lt;REPLACE: src&gt;&gt;}</code></li>
  <li><strong>Add <code>.gitignore</code></strong> — copy from §2.</li>
  <li><strong>Fill in <code>metadata.json</code></strong> — copy template from §4.1, replace all <code>&lt;&lt;REPLACE&gt;&gt;</code> markers.</li>
  <li><strong>Write starter code</strong> with <code>TODO(candidate):</code> markers at each trap location. Use the per-language appendix (§11.A Python / §11.B C++) for the build-config snippet — or §11.D for any other language (draft mode). Follow the §7 philosophy.</li>
  <li><strong>Fill in <code>traps.json</code></strong> — copy template from §4.3. For each trap: confirm <code>detection_tag</code> matches a tag you will use in the hidden test. Aim for 3–5 traps total.</li>
  <li><strong>Write the hidden test file</strong> — use the stub from §11.A, §11.B, or §11.D (drafts). Cover every <code>detection_tag</code> in <code>traps.json</code>, every applicable edge case, and at least one stress/concurrency scenario. Keep it under 600 LOC.</li>
  <li><strong>Write the public test file</strong> — use the stub from §11.A, §11.B, or §11.D (drafts). Most tests pass on the unmodified starter; 1–3 should fail as hints toward the traps.</li>
  <li><strong>Fill in <code>rubric.json</code></strong> — copy template from §4.2. Fill <code>tasks</code> (matching your <code>detection_tag</code>s), <code>code_quality_criteria</code>, <code>architectural_criteria</code>, <code>starter_code_note</code>, <code>submission_files</code>. Leave <code>expected_tokens</code> at <code>0</code> for now.</li>
  <li><strong>Write <code>README.md</code> and <code>SETUP.md</code></strong> — copy skeletons from §8, fill all placeholders.</li>
  <li><strong>Measure token count and set <code>expected_tokens</code></strong> <em>(skip for drafts — leave at <code>0</code>)</em><br>
    <code>python scripts/measure_repo_tokens.py &lt;&lt;REPLACE: challenge-id&gt;&gt; --force</code></li>
  <li><strong>Size-cap self-check.</strong> Confirm all outputs against the table in §2.</li>
  <li><strong>Author self-grade (simulate the grader locally).</strong> Clone to temp dir, strip <code>.jivahire/</code>, confirm public tests pass on unmodified starter, re-inject hidden tests, confirm failures, apply your reference fix, confirm all tests pass.</li>
  <li><strong>PR review checklist</strong> — the PR reviewer ticks every item:
    <ul>
      <li>All JSON files are schema-valid (no parse errors)</li>
      <li>Every tag in <code>rubric.json::tasks[].test_tag</code> and <code>traps.json::traps[].detection_tag</code> appears in ≥ 1 hidden test</li>
      <li>Every tag used in hidden tests appears in <code>tasks</code> or <code>traps</code></li>
      <li>Size caps from §2 all pass</li>
      <li><code>starter_code_note</code> is present and precise</li>
      <li><code>submission_files</code> contains only production source files</li>
      <li>Hidden tests fail on the unmodified starter</li>
      <li>Public tests behave as intended (mostly pass; deliberate failures are hints)</li>
      <li><code>expected_tokens</code> is non-zero and was measured by the script</li>
      <li>No secrets, credentials, or PII anywhere in the challenge</li>
      <li>No compiled binaries or generated artefacts committed</li>
    </ul>
  </li>
</ol>

<h2>§11. Per-Language Appendices</h2>

<h3>§11.A Python</h3>

<p><strong>Directory layout:</strong></p>
<pre class="code-block"><code>challenges/&lt;challenge-id&gt;/
├── .jivahire/
├── src/
│   └── &lt;&lt;REPLACE: module_name&gt;&gt;.py      # submission file
├── tests/
│   ├── test_public.py
│   └── test_hidden.py                   # NOT on candidate branch
├── pyproject.toml
├── README.md
└── SETUP.md</code></pre>

<p><strong><code>pyproject.toml</code>:</strong></p>
<pre class="code-block"><code>[build-system]
requires = ["setuptools&gt;=68"]
build-backend = "setuptools.build_meta"

[project]
name = "&lt;&lt;REPLACE: challenge-slug&gt;&gt;"
version = "0.1.0"
description = "&lt;&lt;REPLACE: one-line description&gt;&gt;"
requires-python = "&gt;=3.11"

[project.optional-dependencies]
dev = ["pytest&gt;=8.0"]

[tool.setuptools]
package-dir = {"" = "src"}
py-modules = ["&lt;&lt;REPLACE: module_name&gt;&gt;"]

[tool.pytest.ini_options]
testpaths = ["tests"]
markers = [
    "basic: basic single-threaded correctness",
    "&lt;&lt;REPLACE: tag2&gt;&gt;: &lt;&lt;REPLACE: description&gt;&gt;",
    "edge: edge cases and boundary inputs",
]</code></pre>

<p>Add one <code>markers</code> entry per custom tag used in your tests.</p>

<p><strong><code>tests/test_public.py</code> stub:</strong></p>
<pre class="code-block"><code>import pytest
from &lt;&lt;REPLACE: module_name&gt;&gt; import &lt;&lt;REPLACE: ClassName&gt;&gt;


@pytest.mark.basic
def test_basic_operation():
    obj = &lt;&lt;REPLACE: ClassName&gt;&gt;(&lt;&lt;REPLACE: args&gt;&gt;)
    obj.&lt;&lt;REPLACE: method&gt;&gt;(&lt;&lt;REPLACE: args&gt;&gt;)
    assert obj.&lt;&lt;REPLACE: query&gt;&gt;() == &lt;&lt;REPLACE: expected&gt;&gt;


@pytest.mark.basic
def test_hinting_failure():
    # This test fails on the unmodified starter, hinting at the &lt;&lt;REPLACE: trap name&gt;&gt; trap.
    obj = &lt;&lt;REPLACE: ClassName&gt;&gt;(&lt;&lt;REPLACE: args&gt;&gt;)
    &lt;&lt;REPLACE: operations that expose the bug&gt;&gt;
    assert &lt;&lt;REPLACE: invariant that fails without the fix&gt;&gt;


@pytest.mark.edge
def test_edge_case():
    obj = &lt;&lt;REPLACE: ClassName&gt;&gt;(&lt;&lt;REPLACE: zero or boundary arg&gt;&gt;)
    &lt;&lt;REPLACE: operation&gt;&gt;
    assert &lt;&lt;REPLACE: expected behaviour&gt;&gt;</code></pre>

<p><strong><code>tests/test_hidden.py</code> stub:</strong></p>
<pre class="code-block"><code># Hidden tests — not visible in the candidate's branch.
# Grader copies this file into tests/ before running.
import threading
import pytest
from &lt;&lt;REPLACE: module_name&gt;&gt; import &lt;&lt;REPLACE: ClassName&gt;&gt;


# --- basic ---

@pytest.mark.basic
def test_does_not_exceed_capacity():
    obj = &lt;&lt;REPLACE: ClassName&gt;&gt;(capacity=3, &lt;&lt;REPLACE: other_args&gt;&gt;)
    for i in range(10):
        obj.&lt;&lt;REPLACE: insert&gt;&gt;(i, i)
    assert obj.&lt;&lt;REPLACE: size&gt;&gt;() == 3


# --- &lt;&lt;REPLACE: tag&gt;&gt; ---

@pytest.mark.&lt;&lt;REPLACE: tag&gt;&gt;
def test_concurrent_writes_do_not_corrupt_state():
    obj = &lt;&lt;REPLACE: ClassName&gt;&gt;(capacity=64, &lt;&lt;REPLACE: other_args&gt;&gt;)
    n_threads = 8
    ops = 200

    def worker(t: int) -&gt; None:
        for i in range(ops):
            obj.&lt;&lt;REPLACE: insert&gt;&gt;(t * ops + i, i)

    threads = [threading.Thread(target=worker, args=(t,)) for t in range(n_threads)]
    for th in threads:
        th.start()
    for th in threads:
        th.join()

    assert obj.&lt;&lt;REPLACE: size&gt;&gt;() &lt;= 64


# --- edge ---

@pytest.mark.edge
def test_zero_capacity_is_no_op():
    obj = &lt;&lt;REPLACE: ClassName&gt;&gt;(capacity=0, &lt;&lt;REPLACE: other_args&gt;&gt;)
    obj.&lt;&lt;REPLACE: insert&gt;&gt;(1, 1)
    assert obj.&lt;&lt;REPLACE: size&gt;&gt;() == 0
    assert obj.&lt;&lt;REPLACE: lookup&gt;&gt;(1) is None</code></pre>

<p><strong>Install and run:</strong></p>
<pre class="code-block"><code># Install in editable mode with dev deps
pip install -e ".[dev]"

# Run all tests
pytest

# Run a single tag
pytest -m basic
pytest -m &lt;&lt;REPLACE: tag&gt;&gt;</code></pre>

<p><strong>Grader status:</strong> The grading pipeline runs your tests
once per declared tag (every tag in <code>rubric.json::tasks[].test_tag</code>
or <code>traps.json::traps[].detection_tag</code>). Each tag is scored
independently — a non-zero exit code for that tag counts as failure.</p>

<h3>§11.B C++</h3>

<p><strong>Directory layout:</strong></p>
<pre class="code-block"><code>challenges/&lt;challenge-id&gt;/
├── .jivahire/
├── include/
│   └── &lt;&lt;REPLACE: header&gt;&gt;.hpp          # submission file (header-only pattern)
├── src/                                 # empty for header-only; add .cpp if needed
├── tests/
│   ├── public_test.cpp
│   └── hidden_test.cpp                  # NOT on candidate branch; MUST be named hidden_test.cpp
├── CMakeLists.txt
├── README.md
└── SETUP.md</code></pre>

<p>The grading pipeline resolves the hidden test path from
<code>metadata.json::hidden_test_file</code>, but the CMake glob
<code>file(GLOB tests/*.cpp)</code> still requires the <code>.cpp</code>
extension — keep the file named with <code>.cpp</code>.</p>

<p><strong><code>CMakeLists.txt</code>:</strong></p>
<pre class="code-block"><code>cmake_minimum_required(VERSION 3.14)
project(&lt;&lt;REPLACE: challenge_slug&gt;&gt; CXX)

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
target_link_libraries(tests PRIVATE Catch2::Catch2WithMain)</code></pre>

<p>The <code>file(GLOB TEST_SOURCES tests/*.cpp)</code> line picks up both
<code>public_test.cpp</code> and the grader-injected <code>hidden_test.cpp</code>
automatically.</p>

<p><strong><code>tests/public_test.cpp</code> stub:</strong></p>
<pre class="code-block"><code>#include &lt;catch2/catch_test_macros.hpp&gt;
#include "&lt;&lt;REPLACE: header&gt;&gt;.hpp"

TEST_CASE("basic operation", "[basic]") {
    &lt;&lt;REPLACE: ClassName&gt;&gt;&lt;int, int&gt; obj(3);
    obj.put(1, 10);
    REQUIRE(obj.get(1) == std::optional&lt;int&gt;(10));
    REQUIRE(obj.get(99) == std::nullopt);
}

TEST_CASE("hinting failure — &lt;&lt;REPLACE: trap name&gt;&gt;", "[basic]") {
    // This test fails on the unmodified starter, hinting at the &lt;&lt;REPLACE: trap&gt;&gt;.
    &lt;&lt;REPLACE: ClassName&gt;&gt;&lt;int, int&gt; obj(2);
    &lt;&lt;REPLACE: operations that expose the bug&gt;&gt;
    REQUIRE(&lt;&lt;REPLACE: invariant that fails without the fix&gt;&gt;);
}

TEST_CASE("edge case", "[edge]") {
    &lt;&lt;REPLACE: ClassName&gt;&gt;&lt;int, int&gt; obj(0);
    obj.put(1, 1);
    REQUIRE(obj.size() == 0);
    REQUIRE(obj.get(1) == std::nullopt);
}</code></pre>

<p><strong><code>tests/hidden_test.cpp</code> stub:</strong></p>
<pre class="code-block"><code>// Hidden tests — not visible in the candidate's branch.
// Grader copies this file into tests/ before building.
#include &lt;catch2/catch_test_macros.hpp&gt;
#include &lt;thread&gt;
#include &lt;vector&gt;
#include "&lt;&lt;REPLACE: header&gt;&gt;.hpp"

// --- basic ---

TEST_CASE("does not exceed capacity on repeated insert", "[basic]") {
    &lt;&lt;REPLACE: ClassName&gt;&gt;&lt;int, int&gt; obj(3);
    for (int i = 0; i &lt; 10; ++i) obj.put(i, i);
    REQUIRE(obj.size() == 3);
}

// --- thread ---

TEST_CASE("concurrent puts do not corrupt state", "[thread]") {
    &lt;&lt;REPLACE: ClassName&gt;&gt;&lt;int, int&gt; obj(64);
    constexpr int N = 8;
    constexpr int OPS = 200;
    std::vector&lt;std::thread&gt; threads;
    for (int t = 0; t &lt; N; ++t) {
        threads.emplace_back([&amp;obj, t] {
            for (int i = 0; i &lt; OPS; ++i) {
                obj.put(t * OPS + i, i);
            }
        });
    }
    for (auto&amp; th : threads) th.join();
    REQUIRE(obj.size() &lt;= 64);
}

// --- edge ---

TEST_CASE("capacity zero is a no-op store", "[edge]") {
    &lt;&lt;REPLACE: ClassName&gt;&gt;&lt;int, int&gt; obj(0);
    obj.put(1, 1);
    REQUIRE(obj.size() == 0);
    REQUIRE(obj.get(1) == std::nullopt);
}</code></pre>

<p>Any Catch2 tag you declare in <code>rubric.json::tasks[].test_tag</code>
or <code>traps.json::traps[].detection_tag</code> is run automatically.
No grader edit is required to add <code>[security]</code>, <code>[perf]</code>,
or any other tag.</p>

<p><strong>Build and run:</strong></p>
<pre class="code-block"><code># Configure and build (first run fetches Catch2 — takes ~1 min)
cmake -B build &amp;&amp; cmake --build build -j

# Run all tests
./build/tests

# Run a single tag
./build/tests "[basic]"
./build/tests "[thread]"
./build/tests "[edge]"</code></pre>

<p><strong>Grader status:</strong> The grading pipeline runs your tests
once per declared tag (every tag in <code>rubric.json::tasks[].test_tag</code>
or <code>traps.json::traps[].detection_tag</code>). Each tag is scored
independently — a non-zero exit code for that tag counts as failure.</p>

<h3>§11.E TypeScript</h3>

<p><strong>Directory layout:</strong></p>
<pre class="code-block"><code>challenges/&lt;challenge-id&gt;/
├── .jivahire/
├── src/
│   └── &lt;&lt;REPLACE: module_name&gt;&gt;.ts       # submission file
├── tests/
│   ├── &lt;&lt;REPLACE: module&gt;&gt;.public.test.ts
│   └── &lt;&lt;REPLACE: module&gt;&gt;.hidden.test.ts # NOT on candidate branch
├── package.json
├── tsconfig.json
├── vitest.config.ts
├── README.md
└── SETUP.md</code></pre>

<p><strong>Tagging convention:</strong> Vitest filters by test-name substring
(<code>-t "&lt;pattern&gt;"</code>). Every test name ends with
<code>@&lt;tag&gt;</code> so the grader can run one tag at a time. Tags must
match <code>rubric.json::tasks[].test_tag</code> and
<code>traps.json::traps[].detection_tag</code> exactly (case-sensitive,
no whitespace).</p>

<p><strong><code>package.json</code>:</strong> Pin both <code>typescript</code>
and <code>vitest</code> to exact versions. Scripts must include
<code>"test": "vitest run …"</code> runnable from the challenge root with
no prompts.</p>

<p><strong>Build and run:</strong></p>
<pre class="code-block"><code>npm install
npm test                       # all tests
npm run test:tag "@basic"      # one tag group (vitest -t substring match)</code></pre>

<p><strong>Grader status:</strong> The grading pipeline runs your tests
once per declared tag (every tag in <code>rubric.json::tasks[].test_tag</code>
or <code>traps.json::traps[].detection_tag</code>). Each tag is scored
independently — a non-zero exit code (or zero-passed/zero-failed summary
line, which signals an unmatched tag) counts as failure.</p>

<h3>§11.D Language-Agnostic Draft Blueprint</h3>
<p>Use this appendix when drafting a challenge in any language not covered
by §11.A, §11.B, or §11.E (Rust, Go, Kotlin, Swift, Java, C#, Ruby, etc.).
Everything here is language-neutral — substitute the conventions of your
chosen language.</p>

<p><strong>This appendix is the grader contract restated in
language-neutral terms.</strong> Every requirement below is something the
grader will enforce once a runner for your language exists. Following
§11.D in full produces an artifact that is <strong>grader-compatible by
construction</strong>: when the runner is wired, the draft executes
correctly with no re-authoring. Skipping any required item produces a
non-conformant challenge that will be rejected at promotion, not a
"lighter" draft.</p>

<h4>D.1 Required files (every draft must contain all of these)</h4>
<pre class="code-block"><code>challenges/&lt;challenge-id&gt;/
├── .jivahire/
│   ├── metadata.json          # §4.1 template — set "status": "draft"
│   ├── rubric.json            # §4.2 template
│   └── traps.json             # §4.3 template
├── README.md                  # §8.1 skeleton
├── SETUP.md                   # §8.2 skeleton
├── .gitignore                 # §2 template (extend for your language)
├── &lt;build-config&gt;             # see D.2
├── &lt;source-dir&gt;/              # starter code with TODO(candidate) markers (§7)
│   └── &lt;implementation-file(s)&gt;
└── tests/
    ├── &lt;public-test-file&gt;     # see D.4
    └── &lt;hidden-test-file&gt;     # see D.5</code></pre>

<p><code>&lt;source-dir&gt;</code> and file names follow the host language's
convention (e.g. <code>src/</code>, <code>lib/</code>, <code>internal/</code>,
<code>app/</code>). Keep nesting ≤ 4 levels below the challenge root.</p>

<h4>D.2 Build configuration requirements</h4>
<p>Whatever build config your language uses (<code>package.json</code>,
<code>Cargo.toml</code>, <code>go.mod</code>, <code>build.gradle</code>,
<code>pom.xml</code>, <code>Gemfile</code>, <code>*.csproj</code>, etc.) MUST:</p>
<ol>
  <li><strong>Pin dependencies.</strong> Declare the test framework and any test-time dependencies with explicit versions. No floating ranges that can break the grader between runs.</li>
  <li><strong>Provide two commands:</strong> one to install/restore dependencies, one to run all tests. Both must be runnable from the challenge root, non-interactively, with no <code>sudo</code> and no prompts.</li>
  <li><strong>Support tag-filtered runs.</strong> The test run command must accept a tag/marker filter argument (see D.3).</li>
  <li><strong>Be reproducible from a fresh clone.</strong> No machine-specific paths, no hand-edited lockfiles.</li>
</ol>
<p>Document both commands in <code>SETUP.md</code> (§8.2).</p>

<h4>D.3 Test framework requirements</h4>
<p>You may pick any framework, <strong>provided</strong> it supports all three of:</p>
<ul>
  <li><strong>Tag/marker filtering from the command line.</strong> Examples by language (you are not limited to these): pytest <code>-m &lt;tag&gt;</code> (Python), Catch2 <code>[&lt;tag&gt;]</code> (C++), Vitest/Jest <code>--grep '@&lt;tag&gt;'</code> (JS/TS), Cargo <code>--features &lt;tag&gt;</code> (Rust), Go <code>-run &lt;pattern&gt;</code> (Go), JUnit <code>@Tag("&lt;tag&gt;")</code> (Java), XCTest <code>--filter</code> (Swift).</li>
  <li><strong>Non-zero exit code on any failure within the filtered set.</strong></li>
  <li><strong>Tag strings match exactly</strong> what you declare in <code>rubric.json::tasks[].test_tag</code> and <code>traps.json::traps[].detection_tag</code> — same casing, same characters. The grader will invoke the framework once per tag.</li>
</ul>

<h4>D.4 Public test file — language-neutral stub</h4>
<pre class="code-block"><code># tests/&lt;public-test-file&gt;  — visible to the candidate.
# Most tests should pass on the unmodified starter; 1–3 should fail as hints toward traps.

import &lt;test framework&gt;
import &lt;starter module / class under test&gt;

test "basic operation" tagged [basic]:
    construct the object with valid args
    call the basic method
    assert the expected result

test "hint failure — &lt;neutral name, do not reveal the trap&gt;" tagged [basic]:
    # Designed to fail on the unmodified starter.
    construct the object
    perform an operation sequence that exposes one of the traps
    assert the invariant the trap violates  # this assertion FAILS pre-fix

test "edge — boundary input" tagged [edge]:
    construct with a boundary value (zero / one / max)
    perform an operation
    assert the documented behaviour</code></pre>

<p>Hard rules: ≤ 300 LOC total; every tag used here is declared in
<code>rubric.json::tasks[].test_tag</code> or
<code>traps.json::traps[].detection_tag</code>; failing-by-design tests
must not contain the word identifying the trap.</p>

<h4>D.5 Hidden test file — language-neutral stub</h4>
<pre class="code-block"><code># tests/&lt;hidden-test-file&gt;  — NEVER on the candidate branch.
# Covers every detection_tag in traps.json + every applicable edge case + ≥ 1 stress test.

import &lt;test framework&gt;
import &lt;concurrency primitives / clock / async helpers as needed&gt;
import &lt;starter module / class under test&gt;

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
test "detection: &lt;trap-id&gt;" tagged [&lt;detection_tag&gt;]:
    set up the specific scenario the trap corrupts
    assert the invariant that fails before the fix and holds after</code></pre>

<p>Hard rules: ≤ 600 LOC total; every <code>detection_tag</code> from
<code>traps.json</code> appears on ≥ 1 test here; every <code>test_tag</code>
from <code>rubric.json::tasks</code> appears on ≥ 1 test here; hidden tests
<strong>fail</strong> on the unmodified starter and <strong>pass</strong>
on the reference fix.</p>

<h4>D.6 Starter code conventions</h4>
<ul>
  <li>Provide a working skeleton — data structure choice, function signatures, type definitions — so the candidate is not paying a boilerplate tax.</li>
  <li>Embed each planted trap as a real bug a senior reviewer would flag in production (see §5). Mark each with a <code>TODO(candidate):</code> comment (§7) that points at the <em>area</em> without naming the <em>fix</em>.</li>
  <li>Use comment syntax appropriate to the host language: <code>//</code> for JS/TS/Rust/Go/Java/C#/Swift/Kotlin; <code>#</code> for Python/Ruby/Shell; <code>--</code> for SQL/Haskell; <code>&lt;!-- --&gt;</code> for HTML/XML.</li>
  <li>Only files listed in <code>rubric.json::submission_files</code> are read by the code-quality evaluator. If your starter spans multiple files, list every file the candidate is expected to edit.</li>
</ul>

<h4>D.7 SETUP.md commands the author must document</h4>
<p>The draft's <code>SETUP.md</code> must show concrete copy-pasteable commands for:</p>
<ol>
  <li>Installing the toolchain on <strong>macOS</strong> and <strong>Linux (Debian/Ubuntu)</strong> — both blocks required.</li>
  <li>Installing dependencies (one command, run from the challenge root).</li>
  <li>Running <strong>all</strong> tests.</li>
  <li>Running tests filtered by a <strong>single tag</strong> (give one worked example using an actual tag from this challenge).</li>
  <li>At least <strong>three</strong> troubleshooting entries — common errors the candidate may hit.</li>
</ol>

<h4>D.8 <code>.gitignore</code> additions per language</h4>
<table class="schema-table">
<thead><tr><th>Language</th><th>Add</th></tr></thead>
<tbody>
  <tr><td>TypeScript / JavaScript</td><td><code>node_modules/</code>, <code>dist/</code>, <code>*.tsbuildinfo</code>, <code>coverage/</code></td></tr>
  <tr><td>Rust</td><td><code>target/</code>, <code>Cargo.lock</code> (only for libraries — keep it for binaries)</td></tr>
  <tr><td>Go</td><td><code>vendor/</code>, <code>*.test</code>, <code>*.out</code></td></tr>
  <tr><td>Java / Kotlin (Gradle)</td><td><code>.gradle/</code>, <code>build/</code>, <code>*.class</code>, <code>out/</code></td></tr>
  <tr><td>C# / .NET</td><td><code>bin/</code>, <code>obj/</code>, <code>*.user</code>, <code>.vs/</code></td></tr>
  <tr><td>Swift</td><td><code>.build/</code>, <code>Packages/</code>, <code>*.xcodeproj/xcuserdata/</code></td></tr>
  <tr><td>Ruby</td><td><code>vendor/bundle/</code>, <code>.bundle/</code>, <code>*.gem</code></td></tr>
</tbody>
</table>

<h4>D.9 Actions deferred until a runner exists (not skipped — deferred)</h4>
<ul>
  <li><code>rubric.json::expected_tokens</code> — leave at <code>0</code>. Measured at promotion via the platform's token-measurement script.</li>
  <li>Author self-grade against the real grader — no backend yet for this language. <strong>In its place, drafts must perform a manual dry-run with equivalent rigor:</strong> (a) run the public tests on the unmodified starter — should mostly pass with 1–3 hint failures; (b) apply a reference fix and run the public tests — should fully pass; (c) run the hidden tests against the unmodified starter — should fail on every <code>detection_tag</code>; (d) run the hidden tests against the reference fix — should fully pass. Record the four outcomes in a comment at the top of the hidden test file.</li>
</ul>

<h4>D.10 What drafts must NOT skip</h4>
<ul>
  <li>All three <code>.jivahire/</code> JSON files, valid and complete per §4.</li>
  <li>A precise <code>starter_code_note</code> — without it the architectural-reasoning evaluator will over-credit candidates once the challenge is promoted.</li>
  <li>The §2 size and file-count caps.</li>
  <li>The §6 tag closure rules (every declared tag must be used; every used tag should be declared).</li>
  <li>The §1 hard invariants (self-contained, deterministic, reproducible build).</li>
</ul>

<h4>D.11 Promotion checklist</h4>
<ol>
  <li>Verify the per-language runner is wired and supported.</li>
  <li>Flip <code>metadata.json::status</code> from <code>"draft"</code> to <code>"active"</code> (or remove the field).</li>
  <li>Run the platform's token-measurement script and set <code>rubric.json::expected_tokens</code> to the result.</li>
  <li>Run the author self-grade end-to-end against the new runner.</li>
</ol>

<h2>§13. Glossary</h2>
<table class="schema-table">
<thead><tr><th>Term</th><th>Definition</th></tr></thead>
<tbody>
  <tr><td><strong>challenge_id</strong></td><td>Kebab-case slug uniquely identifying the challenge; matches the directory name and <code>metadata.json::challenge_id</code>.</td></tr>
  <tr><td><strong>composite score</strong></td><td>The weighted sum of all grading dimensions; 0–10 scale. See the Grading Overview page for the qualitative dimension list.</td></tr>
  <tr><td><strong>detection_tag</strong></td><td>The test tag in <code>traps.json</code> that the grader checks to determine if a trap was fixed.</td></tr>
  <tr><td><strong>developer confidence</strong></td><td>Separate behavioural score (not in composite) computed from telemetry — file exploration, IDE-native usage, post-AI-edit patterns.</td></tr>
  <tr><td><strong>starter_code_note</strong></td><td><code>rubric.json</code> field that tells the architectural-reasoning LLM evaluator what design decisions were already made in the starter code and must not be credited.</td></tr>
  <tr><td><strong>submission_files</strong></td><td>List of files the grader reads for code-quality evaluation; edits outside this list are ignored.</td></tr>
  <tr><td><strong>tag</strong></td><td>A string label on a test used to group tests by concern; author-defined; used to wire <code>tasks</code> and <code>traps</code> in <code>rubric.json</code> / <code>traps.json</code>.</td></tr>
  <tr><td><strong>token efficiency</strong></td><td>Score (0–10) measuring proportionate AI usage relative to a per-challenge baseline.</td></tr>
  <tr><td><strong>trap</strong></td><td>An intentional planted bug in the starter code; graded via <code>traps.json</code> + hidden tests.</td></tr>
</tbody>
</table>
"""


# ────────────────────────────────────────────────────────────────────────────
# Grading overview — redacted, qualitative-only HTML fragment.
# Excludes: composite weight percentages, formula, LLM model identity,
# prompt-classification table, scoring scales, per-challenge planted-trap
# tables, "what recruiters see", and anti-gaming measures.
# ────────────────────────────────────────────────────────────────────────────
_GRADING_HTML = """
<h2>Grading Overview</h2>

<p><strong>Philosophy:</strong> The best engineers aren't those who refuse
AI. They're the ones who use it strategically — knowing when to prompt,
when to reject, when to refactor, and when to write from scratch. These
rubrics evaluate <em>AI orchestration skill</em>, not just code output.</p>

<h2>How Grading Works</h2>

<p>Each session is graded in three stages:</p>
<ol>
  <li><strong>Automated</strong> — hidden tests and planted trap detection run against the candidate's final commit.</li>
  <li><strong>LLM Evaluation</strong> — structured AI evaluations assess quality dimensions.</li>
  <li><strong>Composite Score</strong> — a weighted formula combines all scores into a final result on a 0–10 scale.</li>
</ol>

<p>Each challenge is graded automatically (tests + traps) and via
structured LLM evaluations on five dimensions. The exact weights and
scoring scales are configured per-challenge in
<code>rubric.json::composite_weights</code>; system defaults apply if
omitted.</p>

<h2>Dimensions</h2>

<p>The composite score is built from seven dimensions. The table below
summarises what each measures and where it comes from. Exact weights and
scoring scales are intentionally not published here — they are part of the
grading configuration and live in <code>rubric.json</code> alongside each
challenge.</p>

<table class="schema-table">
<thead><tr><th>Dimension</th><th>What it measures</th><th>Source</th></tr></thead>
<tbody>
  <tr>
    <td><strong>Test pass rate</strong></td>
    <td>How many of the hidden, tagged tests pass against the candidate's final commit.</td>
    <td>Automated (hidden test suite)</td>
  </tr>
  <tr>
    <td><strong>Trap detection</strong></td>
    <td>Whether the candidate found and fixed planted bugs in the starter code; severity-weighted.</td>
    <td>Automated (per-trap detection tag)</td>
  </tr>
  <tr>
    <td><strong>Code quality</strong></td>
    <td>Correctness, idiomatic language use, clarity and naming, edge-case handling — judged from the submitted source.</td>
    <td>LLM evaluation</td>
  </tr>
  <tr>
    <td><strong>Prompt quality</strong></td>
    <td>How precisely and professionally the candidate communicates with the AI assistant.</td>
    <td>LLM evaluation</td>
  </tr>
  <tr>
    <td><strong>AI orchestration</strong></td>
    <td>Whether the candidate used AI strategically — iterating, correcting, and applying judgement — rather than blindly copying output.</td>
    <td>LLM evaluation</td>
  </tr>
  <tr>
    <td><strong>Architectural reasoning</strong></td>
    <td>The quality of design decisions the candidate was responsible for — explicitly excluding choices already made in the starter code.</td>
    <td>LLM evaluation</td>
  </tr>
  <tr>
    <td><strong>Token efficiency</strong></td>
    <td>Whether the candidate's AI usage was proportionate to the problem — neither wasteful nor so sparse it suggests the AI wasn't helpful.</td>
    <td>Formula based on a per-challenge baseline</td>
  </tr>
</tbody>
</table>

<h2>What this means for an author</h2>

<p>Three of the seven dimensions are <strong>fully driven by candidate
behaviour</strong> (prompt quality, AI orchestration, token efficiency) —
authors do not need to provide additional content for those. The
remaining four require explicit author input in <code>rubric.json</code>:</p>

<ul>
  <li><strong>Test pass rate</strong> — author writes the hidden tests and tags them.</li>
  <li><strong>Trap detection</strong> — author writes <code>traps.json</code> with each trap's <code>detection_tag</code> matching a hidden test tag.</li>
  <li><strong>Code quality</strong> — author provides 4–8 concise <code>code_quality_criteria</code> bullet points and the <code>submission_files</code> list.</li>
  <li><strong>Architectural reasoning</strong> — author provides 4–8 <code>architectural_criteria</code> bullet points and (critical) a precise <code>starter_code_note</code>.</li>
</ul>

<h2>The <code>starter_code_note</code> doctrine</h2>

<p>The architectural-reasoning evaluator is <strong>explicitly instructed
not to credit</strong> the candidate for design decisions already made in
the starter code. The <code>rubric.json::starter_code_note</code> field
is the mechanism: it tells the evaluator what NOT to credit.</p>

<p><strong>If this field is absent or vague, the evaluator will
over-credit candidates for inherited design choices, inflating
scores.</strong> Every challenge must have a precise
<code>starter_code_note</code> — enumerate exactly what is provided in
the starter and what the candidate is expected to add or fix.</p>

<p><strong>Good example:</strong></p>
<pre class="code-block"><code>"starter_code_note": "The hash table implementation (separate-chaining
with linked lists) is provided in the starter. Do NOT credit the
candidate for the data structure choice — only their additions: fixing
the resize trigger threshold, handling hash collisions on delete, and
adding bounds checks on the load factor."</code></pre>

<p><strong>Bad example:</strong></p>
<pre class="code-block"><code>"starter_code_note": "Starter code is provided."</code></pre>

<p>The bad example tells the evaluator nothing useful; the good example
names the specific structures and the specific additions expected, so
the evaluator can correctly attribute architectural decisions to the
candidate (vs. inheriting them from the starter).</p>

<h2>Grading robustness</h2>

<p>If any grading stage fails (timeout, framework error, etc.), that
dimension scores neutrally and grading continues for the remaining
stages. A single failed dimension does not invalidate a session's
score.</p>
"""


def _check_token(x_admin_token: str | None) -> None:
    if x_admin_token != settings.admin_token:
        raise HTTPException(status_code=401, detail="Unauthorized")


@router.get("/guide", response_class=HTMLResponse, include_in_schema=False)
def get_guide(x_admin_token: str = Header(None)) -> HTMLResponse:
    _check_token(x_admin_token)
    return HTMLResponse(content=_GUIDE_HTML, media_type="text/html")


@router.get("/grading", response_class=HTMLResponse, include_in_schema=False)
def get_grading(x_admin_token: str = Header(None)) -> HTMLResponse:
    _check_token(x_admin_token)
    return HTMLResponse(content=_GRADING_HTML, media_type="text/html")
