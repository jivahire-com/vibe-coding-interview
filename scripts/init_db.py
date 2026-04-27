#!/usr/bin/env python3
"""Apply schema.sql to the SQLite database."""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).parent.parent / "server"))
from vibe.db import bootstrap

bootstrap()
print("DB initialised.")
