#!/usr/bin/env bash
# Inside-the-container runner for the Python CLI test job. Invoked by
# scripts/ci.sh locally and by .github/workflows/test.yml in CI; both
# arrive in a working dir of /work (= repo root).
#
# Keep this file the SINGLE source of truth for Python install + test
# commands so local runs and CI can't drift apart.

set -euo pipefail

cd tools/conduit
python -m pip install --quiet --upgrade pip
pip install --quiet -e ".[test]"
python -m pytest tests/ -v
