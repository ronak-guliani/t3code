#!/usr/bin/env bash
#
# Build and install the macOS arm64 Dev app from this checkout (main clone or
# worktree). See scripts/install-t3-app.sh --help for all flags.
#
set -euo pipefail

SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
exec "${SCRIPT_DIR}/install-t3-app.sh" --flavor dev "$@"
