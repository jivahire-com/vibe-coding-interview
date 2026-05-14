import json
from pathlib import Path


def evaluate_traps(
    challenge_dir: Path, tag_results: dict[str, bool]
) -> tuple[int, int, list, list, int, int]:
    """Return (traps_detected, traps_total, detected_list, missed_list, detected_weighted, total_weighted)."""
    traps_file = challenge_dir / ".jivahire" / "traps.json"
    traps = json.loads(traps_file.read_text())["traps"]

    detected_traps: list = []
    missed_traps: list = []
    detected_weighted = 0
    total_weighted = 0
    for trap in traps:
        tag = trap.get("detection_tag")
        severity = trap.get("severity", 2)
        total_weighted += severity
        entry = {"id": trap["id"], "description": trap["description"], "detection_tag": tag}
        if tag and tag_results.get(tag, False):
            detected_traps.append(entry)
            detected_weighted += severity
        else:
            missed_traps.append(entry)

    return len(detected_traps), len(traps), detected_traps, missed_traps, detected_weighted, total_weighted
