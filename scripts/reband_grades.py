#!/usr/bin/env python3
"""Re-process the overall band + 'Why this score' reasoning for already-graded
sessions under the NEW 5-band scale (reject/weak/acceptable/good/outstanding).

This is a CHEAP recompute: it reuses each session's stored rubric scores from
`grades.report_json` — no git clone, no test run, no LLM calls, no cost. It only
re-derives the overall band, regenerates the deterministic summary points, and
refreshes the score-ranges legend so old reports render with the new ranges.

Per-rubric LLM reasoning (strong/weak/missing subpoint detail) is left untouched —
that text predates the band change and recomputing it would require re-running the
model. Only the overall verdict and its summary sentence change.

Usage:
    python scripts/reband_grades.py            # dry-run: show what WOULD change (max 5)
    python scripts/reband_grades.py --apply     # write the changes back to the DB
    python scripts/reband_grades.py --limit 3   # cap further (never exceeds 5)

Selection: the 5 most recently graded sessions (grades.graded_at DESC).
"""
import argparse
import json
import os
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "server"))

# config.Settings validates a few required env vars at import; stub them for a
# read/write-only DB script that never talks to GitHub/OpenAI.
os.environ.setdefault("OPENAI_API_KEY", "placeholder")
os.environ.setdefault("GITHUB_BOT_PAT", "placeholder")
os.environ.setdefault("GITHUB_CHALLENGES_REPO", "placeholder/placeholder")
os.environ.setdefault("ADMIN_TOKEN", "placeholder")

from vibe.db import execute, query  # noqa: E402
from vibe.grader import report as report_mod  # noqa: E402

HARD_CAP = 5  # never re-process more than this many sessions in one run


def _scored_rubrics(report: dict) -> list[dict]:
    """The applicable rubrics that feed the total — same shape _summary_points wants."""
    return [
        r
        for sec in report.get("sections", [])
        for r in sec.get("rubrics", [])
        if r.get("score") is not None
    ]


def reband(report: dict) -> tuple[dict, str, str]:
    """Return (new_report, old_band, new_band) without mutating the input."""
    new = json.loads(json.dumps(report))  # deep copy
    overall = new.get("overall", {})
    total = overall.get("score", 0)
    old_band = overall.get("band", "?")
    new_band = report_mod._band(total)

    overall["band"] = new_band
    # Regenerate the headline "Overall result" factor in place (recast of the old
    # summary_points); leave the other recruiter factors as graded.
    overall_factor = report_mod._overall_factor(total, new_band, _scored_rubrics(new))
    factors = [f for f in (overall.get("factors") or []) if f.get("key") != "overall"]
    overall["factors"] = [overall_factor, *factors]
    new["legend"] = report_mod._LEGEND  # refresh score-ranges legend
    return new, old_band, new_band


def main() -> None:
    ap = argparse.ArgumentParser()
    ap.add_argument("--apply", action="store_true", help="write changes (default: dry-run)")
    ap.add_argument("--limit", type=int, default=HARD_CAP)
    args = ap.parse_args()
    limit = max(0, min(args.limit, HARD_CAP))

    rows = query(
        "SELECT session_id, track, total_score, band, report_json "
        "FROM grades WHERE report_json IS NOT NULL "
        "ORDER BY graded_at DESC LIMIT ?",
        (limit,),
    )
    if not rows:
        print("No graded sessions with a stored report to re-band.")
        return

    print(f"{'APPLY' if args.apply else 'DRY-RUN'} — {len(rows)} session(s) (cap {HARD_CAP}):\n")
    changed = 0
    for r in rows:
        try:
            report = json.loads(r["report_json"])
        except Exception as exc:
            print(f"  {r['session_id']}: SKIP — bad report_json ({exc})")
            continue

        new_report, old_band, new_band = reband(report)
        flag = "" if old_band == new_band else "  <-- band changes"
        print(f"  {r['session_id']}  score={r['total_score']:g}  {old_band} -> {new_band}{flag}")

        if args.apply:
            execute(
                "UPDATE grades SET band = ?, report_json = ? WHERE session_id = ?",
                (new_band, json.dumps(new_report), r["session_id"]),
            )
            changed += 1

    if args.apply:
        print(f"\nUpdated {changed} session(s).")
    else:
        print("\nDry-run only — re-run with --apply to write these changes.")


if __name__ == "__main__":
    main()
