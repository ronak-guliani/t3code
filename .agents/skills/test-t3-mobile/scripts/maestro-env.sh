#!/bin/bash
# Bootstrap the Maestro mobile-testing environment.
# Usage: source .agents/skills/test-t3-mobile/scripts/maestro-env.sh [udid-or-name-substring]
# Sets JAVA_HOME, PATH, MAESTRO_CLI_NO_ANALYTICS, T3_SIM_UDID (boots the
# simulator if needed). Fails with a clear message when the toolchain or
# simulator is unavailable. Safe to source repeatedly. Deliberately avoids
# `set -u` and bare globs so sourcing never alters the caller's shell
# options or aborts it under either bash or zsh.
MAESTRO_DIR="$HOME/.local/maestro/maestro"
_java_bin=$(find "$HOME/.local/java" -maxdepth 5 -path "*Contents/Home/bin/java" 2>/dev/null | head -1)
if [ -n "$_java_bin" ]; then
  JAVA_HOME_CANDIDATE=$(dirname "$(dirname "$_java_bin")")
else
  JAVA_HOME_CANDIDATE=""
fi

if [ ! -x "$MAESTRO_DIR/bin/maestro" ]; then
  echo "maestro-env: Maestro CLI not found at $MAESTRO_DIR." >&2
  echo "maestro-env: install per .agents/skills/test-t3-mobile/references/environment.md (direct tarballs, not brew)." >&2
  return 1 2>/dev/null || exit 1
fi
if [ ! -x "$JAVA_HOME_CANDIDATE/bin/java" ]; then
  echo "maestro-env: Java runtime not found under ~/.local/java." >&2
  echo "maestro-env: install per .agents/skills/test-t3-mobile/references/environment.md." >&2
  return 1 2>/dev/null || exit 1
fi

export JAVA_HOME="$JAVA_HOME_CANDIDATE"
case ":$PATH:" in
  *":$MAESTRO_DIR/bin:"*) ;;
  *) export PATH="$MAESTRO_DIR/bin:$PATH" ;;
esac
export MAESTRO_CLI_NO_ANALYTICS=1

_want="${1:-}"
if [ -z "$_want" ]; then
  _udid=$(xcrun simctl list devices 2>/dev/null | grep -E "\(Booted\)" | head -1 | grep -oE "[0-9A-F-]{36}" | head -1)
  if [ -z "$_udid" ]; then
    _udid=$(xcrun simctl list devices available 2>/dev/null | grep -m1 "iPhone 17 Pro (" | grep -oE "[0-9A-F-]{36}" | head -1)
    if [ -z "$_udid" ]; then
      echo "maestro-env: no booted or iPhone 17 Pro simulator found." >&2
      return 1 2>/dev/null || exit 1
    fi
  fi
else
  # Fixed-string match with option terminator: substrings like `[` or
  # leading `-` must not reach grep as regex or flags.
  _udid=$(xcrun simctl list devices 2>/dev/null | grep -i -F -- "$_want" | head -1 | grep -oE "[0-9A-F-]{36}" | head -1)
  if [ -z "$_udid" ]; then
    echo "maestro-env: no simulator matching '$_want'." >&2
    return 1 2>/dev/null || exit 1
  fi
fi
# Block on SpringBoard readiness instead of sleeping a fixed delay; a cold
# simulator routinely needs longer than any reasonable constant.
if ! xcrun simctl bootstatus "$_udid" -b >/dev/null 2>&1; then
  echo "maestro-env: simulator $_udid did not finish booting." >&2
  return 1 2>/dev/null || exit 1
fi

export T3_SIM_UDID="$_udid"
if ! "$MAESTRO_DIR/bin/maestro" --device "$T3_SIM_UDID" hierarchy >/dev/null 2>&1; then
  echo "maestro-env: Maestro cannot reach simulator $T3_SIM_UDID." >&2
  return 1 2>/dev/null || exit 1
fi
echo "maestro-env: ready (device $T3_SIM_UDID)."
