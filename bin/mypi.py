#!/usr/bin/env python3
"""Run the harness from any directory, without activating the venv first.

    bin/mypi.py "tell me a two-line poem"
    bin/mypi.py -p openai --test-tool "What's the weather in Paris?"

If this isn't already running on the project's .venv Python, it re-launches
itself with that Python, so the installed packages are found.
"""

import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
VENV = ROOT / ".venv"
VENV_PYTHON = VENV / "bin" / "python"

# Inside a venv, sys.prefix points at the venv folder.
if Path(sys.prefix).resolve() != VENV.resolve():
    if not VENV_PYTHON.exists():
        sys.exit(f"mypi: no venv at {VENV}; run `python3 -m venv .venv` and install requirements.txt")
    # Replace this process with the venv's Python running this same script (no return).
    os.execv(VENV_PYTHON, [str(VENV_PYTHON), str(Path(__file__).resolve()), *sys.argv[1:]])

# Make `import harness` work even when run from another directory.
sys.path.insert(0, str(ROOT))

from harness.cli import main  # noqa: E402  (import must come after the sys.path change)

main()
