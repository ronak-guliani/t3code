#!/usr/bin/env bash
#
# Build and install the macOS arm64 Alpha app from this checkout (main clone or
# worktree). Use after verifying changes in Dev via scripts/install-t3-dev.sh.
# See scripts/install-t3-app.sh --help for all flags.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/install-t3-app.sh" --flavor alpha "$@"
