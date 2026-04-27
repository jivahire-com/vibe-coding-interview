import json
from pathlib import Path


def evaluate_traps(challenge_dir: Path, tag_results: dict[str, bool]) -> tuple[int, int]:
    """Return (traps_detected, traps_total) based on which test tags passed."""
    traps_file = challenge_dir / ".jivahire" / "traps.json"
    traps = json.loads(traps_file.read_text())["traps"]

    detected = 0
    for trap in traps:
        tag = trap.get("detection_tag")
        if tag and tag_results.get(tag, False):
            detected += 1

    return detected, len(traps)
