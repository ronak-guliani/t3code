#!/usr/bin/env bash
#
# Build and install a macOS arm64 T3 Code app from the checkout this script
# lives in, which may be the main clone or any git worktree. Dev and Alpha each
# own a single /Applications slot, so the install is serialized per flavor and
# reports exactly which branch/commit now occupies the slot.
#
# Usage:
#   scripts/install-t3-app.sh --flavor dev            # build + install + launch Dev
#   scripts/install-t3-app.sh --flavor alpha          # build + install + launch Alpha
#   scripts/install-t3-app.sh --flavor dev --dmg      # install through a DMG
#   scripts/install-t3-app.sh --flavor alpha --dir    # skip DMG/ZIP creation
#   scripts/install-t3-app.sh --flavor dev --no-build # reuse the existing artifact
#   scripts/install-t3-app.sh --flavor dev --no-launch
#
set -euo pipefail

# Resolve through symlinks so the checkout is always the one this file lives in,
# never the shell's cwd.
SCRIPT_PATH="${BASH_SOURCE[0]}"
while [[ -L "$SCRIPT_PATH" ]]; do
  SCRIPT_PATH="$(cd "$(dirname "$SCRIPT_PATH")" && pwd)/$(readlink "$SCRIPT_PATH")"
done
REPO_ROOT="$(cd "$(dirname "$SCRIPT_PATH")/.." && pwd)"

FLAVOR=""
DO_BUILD=1
DO_LAUNCH=1
TARGET=""
for arg in "$@"; do
  case "$arg" in
    --flavor=*) FLAVOR="${arg#--flavor=}" ;;
    dev|alpha) FLAVOR="$arg" ;;
    --flavor) FLAVOR="__next__" ;;
    --no-build) DO_BUILD=0 ;;
    --no-launch) DO_LAUNCH=0 ;;
    --dmg) TARGET="dmg" ;;
    --dir) TARGET="dir" ;;
    -h|--help)
      sed -n '2,15p' "$0"
      exit 0
      ;;
    *)
      if [[ "$FLAVOR" == "__next__" ]]; then
        FLAVOR="$arg"
      else
        echo "Unknown argument: $arg" >&2
        exit 2
      fi
      ;;
  esac
done

case "$FLAVOR" in
  dev)
    APP_NAME="T3 Code (Dev)"
    ARTIFACT_GLOB="T3-Code-Dev-[0-9]*-arm64"
    TARGET="${TARGET:-dir}"
    ;;
  alpha)
    APP_NAME="T3 Code (Alpha)"
    ARTIFACT_GLOB="T3-Code-[0-9]*-arm64"
    TARGET="${TARGET:-dmg}"
    ;;
  *)
    echo "Pass --flavor dev or --flavor alpha." >&2
    exit 2
    ;;
esac

APP_BUNDLE="${APP_NAME}.app"
INSTALL_DEST="/Applications/${APP_BUNDLE}"
RELEASE_DIR="${REPO_ROOT}/release"
LOCK_DIR="${TMPDIR:-/tmp}/t3code-install-${FLAVOR}.lock"

log() { printf '\n[install-t3-%s] %s\n' "$FLAVOR" "$*"; }

if [[ "$(uname)" != "Darwin" ]]; then
  echo "This script only runs on macOS." >&2
  exit 1
fi

HOST_ARCH="$(uname -m)"
if [[ "$HOST_ARCH" != "arm64" ]]; then
  echo "Warning: host arch is ${HOST_ARCH}; this script builds an arm64 app." >&2
fi

BRANCH="$(git -C "$REPO_ROOT" rev-parse --abbrev-ref HEAD 2>/dev/null || echo 'unknown')"
COMMIT="$(git -C "$REPO_ROOT" rev-parse --short HEAD 2>/dev/null || echo 'unknown')"
log "Checkout: ${REPO_ROOT}"
log "Branch:   ${BRANCH} (${COMMIT})"

# A worktree gets its own node_modules; git worktree add does not create them and
# copying them from another checkout dereferences Electron's framework symlinks.
if [[ ! -d "${REPO_ROOT}/node_modules" ]]; then
  echo "No node_modules in ${REPO_ROOT}." >&2
  echo "Run 'pnpm install' in this worktree first (never copy node_modules)." >&2
  exit 1
fi

# Packaging reuses the installed Electron distribution only when its macOS
# framework symlinks survived. Older checkouts reuse it unconditionally and fail
# to codesign, so tell the user to rebase instead of leaving a cryptic error.
ELECTRON_FRAMEWORK_CURRENT="${REPO_ROOT}/apps/desktop/node_modules/electron/dist/Electron.app/Contents/Frameworks/Electron Framework.framework/Versions/Current"
if [[ -e "$ELECTRON_FRAMEWORK_CURRENT" && ! -L "$ELECTRON_FRAMEWORK_CURRENT" ]]; then
  if grep -q 'hasReusableElectronDistribution' "${REPO_ROOT}/scripts/build-desktop-artifact.ts"; then
    log "Electron framework symlinks are dereferenced here; electron-builder will use its own cached distribution."
  else
    echo "This checkout has a dereferenced Electron distribution and no reuse guard." >&2
    echo "Rebase this branch onto main, or run 'rm -rf node_modules && pnpm install'." >&2
    exit 1
  fi
fi

if ! mkdir "$LOCK_DIR" 2>/dev/null; then
  echo "Another ${APP_NAME} install is in progress (lock: ${LOCK_DIR})." >&2
  echo "Wait for it to finish, or remove the lock if it is stale." >&2
  exit 1
fi

MOUNT_POINT=""
cleanup() {
  if [[ -n "$MOUNT_POINT" && -d "$MOUNT_POINT" ]]; then
    hdiutil detach "$MOUNT_POINT" -quiet || hdiutil detach "$MOUNT_POINT" -force -quiet || true
  fi
  rmdir "$LOCK_DIR" 2>/dev/null || true
}
trap cleanup EXIT

log "Quitting any running ${APP_NAME} instance..."
osascript -e "tell application \"${APP_NAME}\" to quit" >/dev/null 2>&1 || true
# Wait only as long as needed for a clean exit, then force-kill stragglers.
for _ in {1..20}; do
  if ! pgrep -f "${APP_BUNDLE}/Contents/MacOS/" >/dev/null 2>&1; then
    break
  fi
  sleep 0.05
done
pkill -f "${APP_BUNDLE}/Contents/MacOS/" >/dev/null 2>&1 || true

if [[ "$DO_BUILD" -eq 1 ]]; then
  log "Building ${FLAVOR} arm64 app (target=${TARGET})..."
  if [[ "$TARGET" == "dmg" ]]; then
    rm -f "${RELEASE_DIR}"/${ARTIFACT_GLOB}.dmg \
          "${RELEASE_DIR}"/${ARTIFACT_GLOB}.dmg.blockmap \
          "${RELEASE_DIR}"/${ARTIFACT_GLOB}.zip \
          "${RELEASE_DIR}"/${ARTIFACT_GLOB}.zip.blockmap
  else
    rm -rf "${RELEASE_DIR:?}/${APP_BUNDLE}"
  fi
  ( cd "$REPO_ROOT" && node scripts/build-desktop-artifact.ts \
      --platform mac --target "$TARGET" --arch arm64 --flavor "$FLAVOR" )
fi

if [[ "$TARGET" == "dmg" ]]; then
  DMG_PATH="$(ls -t "${RELEASE_DIR}"/${ARTIFACT_GLOB}.dmg 2>/dev/null | head -n 1 || true)"
  if [[ -z "$DMG_PATH" || ! -f "$DMG_PATH" ]]; then
    echo "No arm64 DMG found in ${RELEASE_DIR}." >&2
    echo "Re-run without --no-build to produce one." >&2
    exit 1
  fi
  log "Mounting DMG: ${DMG_PATH}"
  ATTACH_OUTPUT="$(hdiutil attach -nobrowse -readonly -plist "$DMG_PATH")"
  MOUNT_POINT="$(printf '%s' "$ATTACH_OUTPUT" \
    | /usr/bin/awk '/<string>\/Volumes\//{ sub(/.*<string>/,""); sub(/<\/string>.*/,""); print; exit }')"
  if [[ -z "$MOUNT_POINT" || ! -d "$MOUNT_POINT" ]]; then
    echo "Failed to determine DMG mount point." >&2
    exit 1
  fi
  log "Mounted at: ${MOUNT_POINT}"
  SRC_APP="${MOUNT_POINT}/${APP_BUNDLE}"
else
  SRC_APP="${RELEASE_DIR}/${APP_BUNDLE}"
  log "Using unpacked app: ${SRC_APP}"
fi

if [[ ! -d "$SRC_APP" ]]; then
  echo "Source app not found at ${SRC_APP}." >&2
  exit 1
fi

log "Replacing ${INSTALL_DEST}..."
rm -rf "$INSTALL_DEST"
ditto "$SRC_APP" "$INSTALL_DEST"

log "Clearing quarantine attributes..."
xattr -dr com.apple.quarantine "$INSTALL_DEST" 2>/dev/null || true

INSTALLED_VERSION="$(/usr/libexec/PlistBuddy -c 'Print :CFBundleShortVersionString' \
  "${INSTALL_DEST}/Contents/Info.plist" 2>/dev/null || echo 'unknown')"
log "Installed ${APP_NAME} v${INSTALLED_VERSION} from ${BRANCH} (${COMMIT})"

# The /Applications slot is shared by every checkout, so leave a breadcrumb that
# says which worktree the currently installed build came from.
printf '%s\t%s\t%s\t%s\n' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$REPO_ROOT" "$BRANCH" "$COMMIT" \
  > "${HOME}/.t3code-installed-${FLAVOR}"

if [[ "$DO_LAUNCH" -eq 1 ]]; then
  log "Launching..."
  open "$INSTALL_DEST"
fi

log "Done."
