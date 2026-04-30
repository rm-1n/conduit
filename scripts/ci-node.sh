#!/usr/bin/env bash
# Inside-the-container runner for the web/JS test job. See ci-python.sh
# for the rationale — same shape, different toolchain.

set -euo pipefail

cd web/tests
npm ci --silent
npm test
