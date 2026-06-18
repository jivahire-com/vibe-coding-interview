"""
Layer 2 — Signals: the single interpretation layer (GRADING_METRICS_MAP.md §3).

Every value derived from telemetry is computed here, exactly once, and read by
the rubrics in Layer 3. Telemetry (the `telemetry` / `sessions` / `chat_exchanges`
rows) is walked a single time in :func:`build`; no rubric queries those tables
afterwards. If two rubrics need the "same" fact they read the same attribute on
the returned :class:`Signals` — they never re-derive it, so they cannot drift
apart.

Two kinds of signal sit side by side:

* **Direct signals** — pure functions of telemetry (counts, ratios, flags).
* **LLM signals** — interpretations that need a model: the per-prompt
  ``prompt_classification`` (vague / specific / professional) and the extracted
  ``design_why`` rationale. Each runs once here and is cached on the object (and,
  for ``prompt_classification``, persisted to ``chat_exchanges``).

The object carries ``ai_assistance``. Apply-keyed facts (``test_after_apply``,
``apply_then_edit`` …) are still computed on the non-AI track but are meaningless
there; the non-AI verification-discipline rubric reads the edit-cadence
fallbacks (``test_after_edit``, ``incremental_edit``) instead, and the vibe-only
rubrics simply aren't scored.
"""

from __future__ import annotations

import json
import statistics
import subprocess
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from vibe.db import execute, query
from vibe.grader.git_ops import candidate_base

# Window (ms) inside which a follow-up test_run "covers" an apply/edit, aligned
# to the extension's POST_APPLY_WINDOW_MS (telemetry.ts).
_POST_APPLY_WINDOW_MS = 90_000
# Window (ms) before submitted_at in which a test_run satisfies the pre-submit floor.
_PRE_SUBMIT_TEST_WINDOW_MS = 5 * 60_000
# A burst of hand edits is "covered" if a test runs within this window after it.
_TEST_AFTER_EDIT_WINDOW_MS = 90_000
# Gap (ms) that separates one hand-edit burst from the next.
_EDIT_BURST_GAP_MS = 60_000
_LARGE_REVERT_LINE_THRESHOLD = 50

_CODE_KEYWORDS = (
    "function", "variable", "line", "error", "type", "return",
    "parameter", "import", "async", "null", "index", "array",
    "object", "class", "method", "callback", "promise",
)


@dataclass
class Signals:
    """Every derived value, computed once. Layer-3 rubrics read from here."""

    ai_assistance: bool

    # exploration / engagement
    files_explored: int = 0
    files_explored_list: list[str] = field(default_factory=list)
    files_explored_detail: list[dict[str, Any]] = field(default_factory=list)
    test_runs: int = 0
    install_runs: int = 0
    build_runs: int = 0
    used_debugger: bool = False
    window_switches: int = 0
    suspicious_pastes: int = 0

    # authorship
    typed_chars: int = 0
    pasted_chars: int = 0
    ai_applied_chars: int = 0
    paste_pct: float = 0.0
    ai_applied_pct: float = 0.0
    self_authored_ratio: float | None = None
    ai_output_modified_ratio: float = 0.0

    # chat
    total_chat_tokens: int = 0
    total_prompt_tokens: int = 0
    total_completion_tokens: int = 0
    num_chat_exchanges: int = 0
    prompt_specificity: float | None = None
    # Files the candidate proactively attached as context (@-mention / pin /
    # right-click), aggregated across the session. Modest positive signal for
    # context-framing in the LLM-communication rubric.
    prompts_with_file_context: int = 0
    files_provided_as_context: list[str] = field(default_factory=list)

    # AI verification / judgment facts (vibe)
    test_after_apply: dict[str, Any] = field(default_factory=dict)
    apply_then_edit: dict[str, Any] = field(default_factory=dict)
    incremental_apply: dict[str, Any] = field(default_factory=dict)
    modify_after_apply: dict[str, Any] = field(default_factory=dict)
    explicit_rejections: int = 0
    hand_fixed_traps: dict[str, Any] = field(default_factory=dict)
    recovery_events: dict[str, Any] = field(default_factory=dict)

    # non-AI hand-edit cadence fallback
    test_after_edit: dict[str, Any] = field(default_factory=dict)
    incremental_edit: dict[str, Any] = field(default_factory=dict)

    # pre-submit floor (both tracks)
    pre_submit_test_run: dict[str, Any] = field(default_factory=dict)

    # LLM signals (optional)
    prompt_classification: list[dict[str, Any]] | None = None
    design_why: str | None = None


# ─── Builder ─────────────────────────────────────────────────────────────────


def build(
    session_id: str,
    *,
    ai_assistance: bool,
    submitted_at_s: int | None = None,
    attribution: dict[str, Any] | None = None,
    clone_dir: Path | None = None,
    chat_prompts: list[str] | None = None,
    client: Any | None = None,
) -> Signals:
    """Walk telemetry once and return the fully-populated :class:`Signals`.

    ``client`` (an OpenAI client) is optional — when omitted the LLM signals
    (``prompt_classification``, ``design_why``) are left ``None`` so the
    deterministic signals are usable without any model call.
    """
    events = _load_events(session_id)
    counters = _load_counters(session_id)
    if chat_prompts is None:
        chat_prompts = _load_chat_prompts(session_id)
    submitted_at_ms = (submitted_at_s * 1000) if submitted_at_s is not None else None

    s = Signals(ai_assistance=ai_assistance)

    # exploration / engagement
    files_opened = {
        e["payload"].get("file")
        for e in events
        if e["event_type"] == "file_open" and e["payload"].get("file")
    }
    s.files_explored = len(files_opened)
    s.files_explored_list = sorted(files_opened)
    s.files_explored_detail = _file_time_detail(events, files_opened)
    s.test_runs = sum(1 for e in events if e["event_type"] == "test_run")
    terminal = [e for e in events if e["event_type"] == "terminal_command"]
    s.install_runs = sum(1 for e in terminal if e["payload"].get("kind") == "install")
    s.build_runs = sum(1 for e in terminal if e["payload"].get("kind") == "build")
    s.used_debugger = any(e["event_type"] == "debug_session" for e in events)
    s.window_switches = sum(1 for e in events if e["event_type"] == "app_unfocused")
    s.suspicious_pastes = sum(
        1 for e in events
        if e["event_type"] == "edit_pasted" and e["payload"].get("suspicious_paste")
    )

    # authorship
    s.typed_chars = counters["typed_chars"]
    s.pasted_chars = counters["pasted_chars"]
    s.ai_applied_chars = counters["ai_applied_chars"]
    total_chars = max(s.typed_chars + s.pasted_chars, 1)
    s.paste_pct = round(s.pasted_chars / total_chars * 100, 1)
    s.ai_applied_pct = round(
        s.ai_applied_chars / max(s.typed_chars + s.pasted_chars + s.ai_applied_chars, 1) * 100, 1
    )
    sa_total = s.typed_chars + s.ai_applied_chars
    s.self_authored_ratio = round(s.typed_chars / sa_total, 3) if sa_total else None
    s.ai_output_modified_ratio = _ai_output_modified_ratio(events)

    # chat token totals
    cx = query(
        "SELECT prompt_tokens, completion_tokens FROM chat_exchanges "
        "WHERE session_id=? ORDER BY ts",
        (session_id,),
    )
    s.total_prompt_tokens = sum(r["prompt_tokens"] or 0 for r in cx)
    s.total_completion_tokens = sum(r["completion_tokens"] or 0 for r in cx)
    s.total_chat_tokens = s.total_prompt_tokens + s.total_completion_tokens
    s.num_chat_exchanges = len(cx)
    s.prompt_specificity = _prompt_specificity(chat_prompts)
    s.prompts_with_file_context, s.files_provided_as_context = _file_context_signal(session_id)

    # AI verification / judgment facts
    s.test_after_apply = _test_after_apply(events)
    s.apply_then_edit = _apply_then_edit(events)
    s.incremental_apply = _incremental_apply(events)
    s.modify_after_apply = _modify_after_apply(events)
    s.explicit_rejections = sum(1 for e in events if e["event_type"] == "edit_ai_rejected")
    s.hand_fixed_traps = _hand_fixed_traps(attribution)
    s.recovery_events = _recovery_events(clone_dir)

    # non-AI hand-edit cadence
    s.test_after_edit = _test_after_edit(events)
    s.incremental_edit = _incremental_edit(events)

    # pre-submit floor
    s.pre_submit_test_run = _pre_submit_test_run(events, submitted_at_ms)

    # LLM signals — computed once, optional
    if client is not None:
        try:
            s.prompt_classification = classify_prompts(session_id, client)
        except Exception:
            s.prompt_classification = None
        try:
            s.design_why = extract_design_why(
                session_id, client, ai_assistance=ai_assistance, clone_dir=clone_dir,
            )
        except Exception:
            s.design_why = None

    return s


# ─── Telemetry loaders (walked once) ─────────────────────────────────────────


def _load_events(session_id: str) -> list[dict[str, Any]]:
    rows = query(
        "SELECT ts, event_type, payload FROM telemetry "
        "WHERE session_id=? ORDER BY ts ASC, id ASC",
        (session_id,),
    )
    out: list[dict[str, Any]] = []
    for r in rows:
        try:
            payload = json.loads(r["payload"]) if isinstance(r["payload"], str) else (r["payload"] or {})
        except Exception:
            payload = {}
        out.append({"ts": r["ts"], "event_type": r["event_type"], "payload": payload})
    return out


def _load_counters(session_id: str) -> dict[str, int]:
    rows = query(
        "SELECT typed_chars, pasted_chars, ai_applied_chars FROM sessions WHERE id=?",
        (session_id,),
    )
    if not rows:
        return {"typed_chars": 0, "pasted_chars": 0, "ai_applied_chars": 0}
    r = rows[0]
    return {
        "typed_chars": int(r.get("typed_chars") or 0),
        "pasted_chars": int(r.get("pasted_chars") or 0),
        "ai_applied_chars": int(r.get("ai_applied_chars") or 0),
    }


def _load_chat_prompts(session_id: str) -> list[str]:
    rows = query(
        "SELECT prompt_text FROM chat_exchanges WHERE session_id=? AND prompt_text IS NOT NULL "
        "ORDER BY ts ASC",
        (session_id,),
    )
    return [r["prompt_text"] for r in rows if r["prompt_text"]]


def _file_context_signal(session_id: str) -> tuple[int, list[str]]:
    """How often, and which files, the candidate attached as context.

    Returns (number of prompts that carried ≥1 attached file, deduped list of
    distinct files provided across the session). Reads the proxy-captured
    ``referenced_files`` column so @-mention, pin, and right-click all count.
    """
    rows = query(
        "SELECT referenced_files FROM chat_exchanges "
        "WHERE session_id=? AND prompt_text IS NOT NULL ORDER BY ts ASC",
        (session_id,),
    )
    prompts_with = 0
    distinct: list[str] = []
    seen: set[str] = set()
    for r in rows:
        files = _parse_referenced_files(r["referenced_files"])
        if files:
            prompts_with += 1
            for f in files:
                if f not in seen:
                    seen.add(f)
                    distinct.append(f)
    return prompts_with, distinct


# ─── Direct-signal derivations ───────────────────────────────────────────────


def _file_time_detail(events, files_opened) -> list[dict[str, Any]]:
    file_time_ms: dict[str, int] = {f: 0 for f in files_opened if f}
    for e in events:
        if e["event_type"] != "file_focus":
            continue
        f = e["payload"].get("file")
        ms = e["payload"].get("ms")
        if not f or not isinstance(ms, (int, float)) or ms <= 0:
            continue
        file_time_ms[f] = file_time_ms.get(f, 0) + int(ms)
    return [
        {"file": f, "ms": ms}
        for f, ms in sorted(file_time_ms.items(), key=lambda kv: (-kv[1], kv[0]))
    ]


def _ai_output_modified_ratio(events) -> float:
    """Char-weighted fraction of AI-applied output reworked by typing within 90s.

    Each typed event counts at most once across the applies on its file (the
    count-of-events form over-reported — RAH-144).
    """
    ai_inserts = [e for e in events if e["event_type"] == "edit_ai_applied"]
    typed = [e for e in events if e["event_type"] == "edit_typed"]
    ai_chars_total = sum(int(ai["payload"].get("chars") or 0) for ai in ai_inserts)
    if ai_chars_total <= 0:
        return 0.0
    apply_ts_by_file: dict[str, list[int]] = {}
    for ai_e in ai_inserts:
        f = ai_e["payload"].get("file")
        if f is None:
            continue
        apply_ts_by_file.setdefault(f, []).append(ai_e["ts"])
    post_typed = 0
    for t_e in typed:
        chars = int(t_e["payload"].get("chars") or 0)
        if chars <= 0:
            continue
        for ai_ts in apply_ts_by_file.get(t_e["payload"].get("file"), ()):
            if 0 < t_e["ts"] - ai_ts < _POST_APPLY_WINDOW_MS:
                post_typed += chars
                break
    return round(min(post_typed / ai_chars_total, 1.0), 2)


def _prompt_specificity(chat_prompts: list[str]) -> float | None:
    if not chat_prompts:
        return None
    with_terms = sum(
        1 for p in chat_prompts if any(kw in p.lower() for kw in _CODE_KEYWORDS)
    )
    return round(with_terms / len(chat_prompts), 2)


def _test_after_apply(events) -> dict[str, Any]:
    applies = [e for e in events if e["event_type"] == "edit_ai_applied"]
    test_ts = [e["ts"] for e in events if e["event_type"] == "test_run"]
    if not applies:
        return {"ratio": None, "applies": 0, "covered": 0}
    covered = sum(
        1 for a in applies
        if any(a["ts"] <= t <= a["ts"] + _POST_APPLY_WINDOW_MS for t in test_ts)
    )
    return {"ratio": round(covered / len(applies), 3), "applies": len(applies), "covered": covered}


def _apply_then_edit(events) -> dict[str, Any]:
    applies = [e for e in events if e["event_type"] == "edit_ai_applied"]
    if not applies:
        return {"rate": None, "applies": 0, "reviewed": 0}
    apply_ids = {e["payload"].get("block_id") for e in applies if e["payload"].get("block_id")}
    reviewed_ids: set[str] = set()
    for e in events:
        if e["event_type"] not in ("edit_typed", "edit_pasted"):
            continue
        bid = e["payload"].get("post_apply_of")
        if bid and bid in apply_ids:
            reviewed_ids.add(bid)
    denom = max(1, len(apply_ids))
    return {"rate": round(len(reviewed_ids) / denom, 3),
            "applies": len(apply_ids), "reviewed": len(reviewed_ids)}


def _modify_after_apply(events) -> dict[str, Any]:
    apply_ids: set[str] = set()
    reviewed_ids: set[str] = set()
    for e in events:
        if e["event_type"] == "edit_ai_applied":
            bid = e["payload"].get("block_id")
            if isinstance(bid, str):
                apply_ids.add(bid)
        elif e["event_type"] in ("edit_typed", "edit_pasted"):
            bid = e["payload"].get("post_apply_of")
            if isinstance(bid, str):
                reviewed_ids.add(bid)
    if not apply_ids:
        return {"rate": None, "applies": 0, "reviewed": 0}
    reviewed = len(reviewed_ids & apply_ids)
    return {"rate": round(reviewed / len(apply_ids), 3),
            "applies": len(apply_ids), "reviewed": reviewed}


def _incremental_apply(events) -> dict[str, Any]:
    applies = [e for e in events if e["event_type"] == "edit_ai_applied"]
    if not applies:
        return {"mean_chars": None, "between_rate": None, "applies": 0}
    sizes = [int(e["payload"].get("chars") or 0) for e in applies]
    sizes = [x for x in sizes if x > 0] or [0]
    test_ts = sorted(e["ts"] for e in events if e["event_type"] == "test_run")
    pairs = list(zip(applies, applies[1:]))
    between = (
        sum(1 for a, b in pairs if any(a["ts"] < t < b["ts"] for t in test_ts)) / len(pairs)
        if pairs else 0.0
    )
    return {"mean_chars": round(statistics.mean(sizes), 1),
            "between_rate": round(between, 3), "applies": len(applies)}


def _edit_bursts(events) -> list[dict[str, int]]:
    """Group consecutive hand edits (typed/pasted) into bursts separated by gaps."""
    edits = [e for e in events if e["event_type"] in ("edit_typed", "edit_pasted")]
    bursts: list[dict[str, int]] = []
    cur: dict[str, int] | None = None
    for e in edits:
        chars = int(e["payload"].get("chars") or 0)
        if cur is None or e["ts"] - cur["end"] > _EDIT_BURST_GAP_MS:
            cur = {"start": e["ts"], "end": e["ts"], "chars": chars}
            bursts.append(cur)
        else:
            cur["end"] = e["ts"]
            cur["chars"] += chars
    return bursts


def _test_after_edit(events) -> dict[str, Any]:
    """Non-AI cadence fallback: edit bursts followed by a test within 90s."""
    bursts = _edit_bursts(events)
    test_ts = [e["ts"] for e in events if e["event_type"] == "test_run"]
    if not bursts:
        return {"ratio": None, "bursts": 0, "covered": 0}
    covered = sum(
        1 for b in bursts
        if any(b["end"] <= t <= b["end"] + _TEST_AFTER_EDIT_WINDOW_MS for t in test_ts)
    )
    return {"ratio": round(covered / len(bursts), 3), "bursts": len(bursts), "covered": covered}


def _incremental_edit(events) -> dict[str, Any]:
    bursts = _edit_bursts(events)
    if not bursts:
        return {"mean_chars": None, "bursts": 0}
    sizes = [b["chars"] for b in bursts if b["chars"] > 0] or [0]
    return {"mean_chars": round(statistics.mean(sizes), 1), "bursts": len(bursts)}


def _pre_submit_test_run(events, submitted_at_ms: int | None) -> dict[str, Any]:
    if submitted_at_ms is None:
        return {"passed": True, "enforced": False}
    window_start = submitted_at_ms - _PRE_SUBMIT_TEST_WINDOW_MS
    passed = any(
        e["event_type"] == "test_run" and window_start <= e["ts"] <= submitted_at_ms
        for e in events
    )
    return {"passed": passed, "enforced": True,
            "window_start_ms": window_start, "submitted_at_ms": submitted_at_ms}


def _hand_fixed_traps(attribution: dict[str, Any] | None) -> dict[str, Any]:
    attrs = (attribution or {}).get("attributions", {}) or {}
    if not attrs:
        return {"hand_fixed": 0, "total": 0, "any_reviewed": False}
    hand_fixed = sum(1 for v in attrs.values() if v.get("class") == "hand-fixed")
    any_reviewed = any(v.get("class") == "ai-fixed-reviewed" for v in attrs.values())
    return {"hand_fixed": hand_fixed, "total": len(attrs), "any_reviewed": any_reviewed}


def _recovery_events(clone_dir: Path | None) -> dict[str, Any]:
    if clone_dir is None or not clone_dir.exists():
        return {"count": 0, "available": False}
    # Scope to the candidate's own commits only (`<base>..HEAD`). Walking the
    # whole branch counts setup commits — the starter re-sync, the answer-key
    # strip — as candidate "recoveries"; the canonical-package sync alone is a
    # 50+ line deletion. If we can't isolate the candidate range, report no
    # signal rather than fold setup history back in. `.jivahire/` is also
    # excluded so the committed telemetry JSONL never registers.
    base = candidate_base(clone_dir)
    if base is None:
        return {"count": 0, "available": False}
    try:
        log = subprocess.run(
            ["git", "log", f"{base}..HEAD", "--pretty=%H %s", "--numstat",
             "--", ".", ":(exclude).jivahire/**"],
            cwd=clone_dir, capture_output=True, text=True, timeout=30, check=False,
        )
    except Exception:
        return {"count": 0, "available": False}
    if log.returncode != 0:
        return {"count": 0, "available": False}
    return {"count": _count_recovery_commits(log.stdout), "available": True}


def _count_recovery_commits(git_log_output: str) -> int:
    count = 0
    subject = ""
    deletions = 0
    is_commit = False

    def _flush() -> int:
        nonlocal subject, deletions, is_commit
        bump = 0
        if is_commit:
            s = subject.lower()
            if "revert" in s or "reset" in s or "rollback" in s:
                bump = 1
            elif deletions >= _LARGE_REVERT_LINE_THRESHOLD:
                bump = 1
        subject, deletions, is_commit = "", 0, False
        return bump

    for raw in git_log_output.splitlines():
        line = raw.rstrip()
        if not line:
            continue
        if len(line) > 41 and line[40] == " " and all(c in "0123456789abcdef" for c in line[:40]):
            count += _flush()
            subject = line[41:]
            is_commit = True
            continue
        parts = line.split("\t")
        if len(parts) >= 2:
            try:
                deletions += int(parts[1])
            except ValueError:
                pass
    count += _flush()
    return count


# ─── LLM signals (computed once, cached / persisted) ─────────────────────────

_CLASSIFICATION_VALUES = ("vague", "specific", "professional")
_LEVEL_TO_CLASSIFICATION = {5: "professional", 4: "professional",
                            3: "specific", 2: "vague", 1: "vague"}


def _parse_referenced_files(raw: Any) -> list[str]:
    """Decode the chat_exchanges.referenced_files JSON column to a path list."""
    if not raw:
        return []
    try:
        val = json.loads(raw) if isinstance(raw, str) else raw
    except (json.JSONDecodeError, TypeError):
        return []
    return [str(p) for p in val if p] if isinstance(val, list) else []


def classify_prompts(session_id: str, client: Any) -> list[dict[str, Any]] | None:
    """Score + classify each candidate prompt and persist to chat_exchanges.

    Single LLM call (display + reuse, not self-consistent). Writes
    ``prompt_classification`` / ``prompt_score`` / ``prompt_reasoning`` /
    ``prompt_level`` so both the recruiter "Candidate Prompts" card and any
    rubric can read the same interpretation without re-running it. Returns the
    parsed classifications, or ``None`` on failure.
    """
    from vibe.grader.llm_eval import CONFIG  # local import avoids a cycle at module load

    rows = query(
        "SELECT id, prompt_text, referenced_files FROM chat_exchanges "
        "WHERE session_id=? AND prompt_text IS NOT NULL ORDER BY ts ASC",
        (session_id,),
    )
    prompts = [(i, r["prompt_text"], _parse_referenced_files(r["referenced_files"]))
               for i, r in enumerate(rows) if r["prompt_text"]]
    if not prompts:
        return None

    ladder = CONFIG.get("prompt_classification_ladder", {})
    ladder_block = "\n".join(f"  {lvl} - {desc}" for lvl, desc in ladder.items()) or "  (none)"
    numbered = "\n".join(
        f"[{i+1}] {p[:400]}" + (f"\n     (attached as context: {', '.join(files)})" if files else "")
        for i, p, files in prompts
    )
    prompt = f"""Rate each candidate prompt below. Return JSON only.

CLASSIFICATION BUCKETS (recruiter-facing badge):
  professional — cites exact errors, types, line numbers, constraints, or runtime behaviour
  specific     — names the problem/symptom but lacks technical precision
  vague        — generic requests, "fix this", no context

1-5 LADDER (for context; informs the 1-10 score):
{ladder_block}

CONTEXT THE CANDIDATE ATTACHED: some prompts note files the candidate proactively
gave the AI (via @-mention or pinning the file). Pointing the AI at the right
file is good prompting hygiene — treat it as mild positive evidence that nudges
the score up by at most ~1 point and can move a borderline prompt up one bucket.
It is NOT a substitute for stating the actual problem: a bare "fix this" with a
file attached is still vague.

PROMPTS:
{numbered}

For each prompt return:
  - "index":          the prompt number above
  - "classification": one of "vague" | "specific" | "professional"
  - "level":          1-5 on the ladder
  - "score":          integer 1-10
  - "reasoning":      one short sentence citing what makes it vague/specific/professional

Respond with: {{"classifications": [
  {{"index": 1, "classification": "...", "level": 1-5, "score": 1-10, "reasoning": "..."}},
  ...
]}}"""
    try:
        resp = client.chat.completions.create(
            model=CONFIG["model"].get("name"),
            messages=[{"role": "user", "content": prompt}],
            temperature=0, max_tokens=900,
            response_format={"type": "json_object"},
        )
        data = json.loads((resp.choices[0].message.content or "").strip())
    except Exception:
        return None

    out: list[dict[str, Any]] = []
    for c in data.get("classifications") or []:
        if not isinstance(c, dict):
            continue
        idx = c.get("index")
        if not isinstance(idx, int) or not (0 < idx <= len(rows)):
            continue
        level = c.get("level") if isinstance(c.get("level"), int) and 1 <= c.get("level") <= 5 else None
        score = c.get("score")
        score = max(1, min(10, int(round(score)))) if isinstance(score, (int, float)) else None
        classification = c.get("classification")
        if classification not in _CLASSIFICATION_VALUES:
            classification = _LEVEL_TO_CLASSIFICATION.get(level) if level else None
        reasoning = c.get("reasoning").strip() if isinstance(c.get("reasoning"), str) else None
        execute(
            "UPDATE chat_exchanges SET prompt_classification=?, prompt_score=?, "
            "prompt_reasoning=?, prompt_level=? WHERE id=?",
            (classification, score, reasoning, level, rows[idx - 1]["id"]),
        )
        out.append({"index": idx, "classification": classification, "level": level,
                    "score": score, "reasoning": reasoning})
    return out or None


def extract_design_why(
    session_id: str, client: Any, *, ai_assistance: bool, clone_dir: Path | None,
) -> str | None:
    """Extract the candidate's design rationale, once.

    On the vibe track the source is the chat log; on the non-AI track it is
    ``NOTES.md`` + commit messages from the cloned repo. Read by both the
    architectural-reasoning rubric and the product-sense bonus.
    """
    from vibe.grader.llm_eval import CONFIG

    if ai_assistance:
        prompts = _load_chat_prompts(session_id)
        evidence = "\n".join(f"- {p[:400]}" for p in prompts[:20])
        source = "chat prompts"
    else:
        evidence = _non_ai_design_evidence(clone_dir)
        source = "NOTES.md + commit messages"
    if not evidence.strip():
        return None

    prompt = (
        "Below is the evidence of a coding-interview candidate's design rationale, drawn from "
        f"their {source}. In 1-2 plain sentences, summarise the 'why' behind their key design "
        "decisions (the trade-offs they weighed and the reasons they gave). If the evidence "
        "shows no real rationale, say so plainly. Do not invent reasoning that isn't present.\n\n"
        f"EVIDENCE:\n{evidence}"
    )
    try:
        resp = client.chat.completions.create(
            model=CONFIG["model"].get("name"),
            messages=[{"role": "user", "content": prompt}],
            temperature=0, max_tokens=200,
        )
        return (resp.choices[0].message.content or "").strip() or None
    except Exception:
        return None


def _non_ai_design_evidence(clone_dir: Path | None) -> str:
    if clone_dir is None or not clone_dir.exists():
        return ""
    parts: list[str] = []
    notes = clone_dir / "NOTES.md"
    try:
        if notes.exists():
            parts.append("NOTES.md:\n" + notes.read_text(encoding="utf-8")[:2000])
    except OSError:
        pass
    try:
        log = subprocess.run(
            ["git", "log", "--pretty=%s", "-n", "40"],
            cwd=clone_dir, capture_output=True, text=True, timeout=30, check=False,
        )
        if log.returncode == 0 and log.stdout.strip():
            parts.append("Commit messages:\n" + log.stdout.strip())
    except Exception:
        pass
    return "\n\n".join(parts)
