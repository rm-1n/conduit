#!/usr/bin/env bash
# Run the CI test matrix locally in containers identical to the
# GitHub Actions workflow.
#
# Usage:
#   scripts/ci.sh                        # run everything (3 Python + Node)
#   scripts/ci.sh python                 # all 3 Python versions
#   scripts/ci.sh python 3.9             # one Python version
#   scripts/ci.sh node                   # Node 20
#
# Why this exists:
#   The .github/workflows/test.yml jobs use `container:` to run the
#   tests inside the SAME Docker images this script pulls. So a green
#   `scripts/ci.sh` locally is a near-perfect predictor of green CI.
#   The only Linux-side install/test commands live in the two helper
#   scripts (`ci-python.sh`, `ci-node.sh`); both are sourced from inside
#   the container, both locally and in Actions.
#
# Requires: Docker daemon running. On macOS: `open -a Docker`.

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
PY_VERSIONS=(3.9 3.12 3.14)
NODE_VERSION=20

PY_IMAGE_PREFIX="python:"
PY_IMAGE_SUFFIX="-slim"
NODE_IMAGE="node:${NODE_VERSION}-bullseye-slim"

# Ensure Docker is alive before anything else.
if ! docker info >/dev/null 2>&1; then
  echo "✗ Docker daemon not reachable." >&2
  echo "  macOS: open -a Docker  (then re-run)" >&2
  exit 1
fi

run_python() {
  local v="$1"
  echo "── Python ${v} ───────────────────────────────────"
  docker run --rm \
    -v "${REPO_ROOT}:/work" -w /work \
    --network bridge \
    "${PY_IMAGE_PREFIX}${v}${PY_IMAGE_SUFFIX}" \
    bash scripts/ci-python.sh
}

run_node() {
  echo "── Node ${NODE_VERSION} ─────────────────────────────────"
  docker run --rm \
    -v "${REPO_ROOT}:/work" -w /work \
    --network bridge \
    "${NODE_IMAGE}" \
    bash scripts/ci-node.sh
}

cmd="${1:-all}"
case "$cmd" in
  all)
    for v in "${PY_VERSIONS[@]}"; do run_python "$v"; done
    run_node
    ;;
  python)
    if [[ -n "${2:-}" ]]; then
      run_python "$2"
    else
      for v in "${PY_VERSIONS[@]}"; do run_python "$v"; done
    fi
    ;;
  node)
    run_node
    ;;
  *)
    echo "usage: scripts/ci.sh [all | python [VERSION] | node]" >&2
    exit 2
    ;;
esac

echo "✓ all jobs passed"
