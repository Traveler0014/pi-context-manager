#!/usr/bin/env bash
#
# release.sh — Bump extension version, commit, tag, and push.
#
# Usage:
#   bash scripts/release.sh <extension-path> <bump>
#
# Arguments:
#   extension-path   Relative path from repo root (e.g. "example-provider"
#                    or "tools/example-plugin")
#   bump             One of: major, minor, patch, or a specific version (e.g. 1.2.3)
#
# Examples:
#   bash scripts/release.sh example-provider patch
#   bash scripts/release.sh tools/example-plugin 2.0.0
#

set -euo pipefail

REPO_ROOT="$(cd "$(dirname "$0")/.." && pwd)"

# ── Args ─────────────────────────────────────────────────────────────────────

if [ $# -lt 2 ]; then
  echo "Usage: $0 <extension-path> <bump>"
  echo "  extension-path: directory relative to repo root (e.g. example-provider or tools/example-plugin)"
  echo "  bump: major | minor | patch | <x.y.z>"
  exit 1
fi

EXT_PATH="$1"
BUMP="$2"
EXT_DIR="$REPO_ROOT/$EXT_PATH"
EXT_PKG="$EXT_DIR/package.json"
ROOT_PKG="$REPO_ROOT/package.json"

# ── Preflight ────────────────────────────────────────────────────────────────

if [ ! -f "$EXT_PKG" ]; then
  echo "✗ Extension package.json not found: $EXT_PKG"
  exit 1
fi

if ! command -v node &>/dev/null; then
  echo "✗ node is required but not installed."
  exit 1
fi

cd "$REPO_ROOT"

# Ensure we're on main
CURRENT_BRANCH="$(git branch --show-current)"
if [ "$CURRENT_BRANCH" != "main" ]; then
  echo "✗ Must be on 'main' branch (currently on '$CURRENT_BRANCH')"
  exit 1
fi

# Ensure working tree is clean for this extension
if ! git diff --quiet -- "$EXT_DIR"; then
  echo "✗ Uncommitted changes in $EXT_DIR — commit or stash first."
  exit 1
fi

# ── Read current version ─────────────────────────────────────────────────────

OLD_VERSION="$(node -p "require('$EXT_PKG').version")"
echo "  Extension: $EXT_PATH"
echo "  Current:   v$OLD_VERSION"

# ── Bump version ─────────────────────────────────────────────────────────────

if [[ "$BUMP" =~ ^[0-9]+\.[0-9]+\.[0-9]+$ ]]; then
  NEW_VERSION="$BUMP"
  node -e "
    const fs = require('fs');
    const pkg = JSON.parse(fs.readFileSync('$EXT_PKG', 'utf-8'));
    pkg.version = '$NEW_VERSION';
    fs.writeFileSync('$EXT_PKG', JSON.stringify(pkg, null, 2) + '\n');
  "
else
  case "$BUMP" in
    major|minor|patch)
      NEW_VERSION="$(node -e "
        const v = '$OLD_VERSION'.split('.').map(Number);
        const bump = '$BUMP';
        if (bump === 'major') { v[0]++; v[1] = 0; v[2] = 0; }
        if (bump === 'minor') { v[1]++; v[2] = 0; }
        if (bump === 'patch') { v[2]++; }
        process.stdout.write(v.join('.'));
      ")"
      node -e "
        const fs = require('fs');
        const pkg = JSON.parse(fs.readFileSync('$EXT_PKG', 'utf-8'));
        pkg.version = '$NEW_VERSION';
        fs.writeFileSync('$EXT_PKG', JSON.stringify(pkg, null, 2) + '\n');
      "
      ;;
    *)
      echo "✗ Invalid bump value: $BUMP (use major, minor, patch, or x.y.z)"
      exit 1
      ;;
  esac
fi

echo "  New:       v$NEW_VERSION"

# ── Regenerate docs ──────────────────────────────────────────────────────────

echo ""
echo "→ Regenerating README.md..."
npm run --silent update-docs

# ── Commit ───────────────────────────────────────────────────────────────────

# Use directory name as extension name in tag (last component of path)
EXT_NAME="$(basename "$EXT_PATH")"
TAG="${EXT_NAME}@${NEW_VERSION}"

echo ""
echo "→ Committing..."
git add "$EXT_DIR" "$REPO_ROOT/README.md"
git commit -m "release: ${TAG}"

# ── Tag ──────────────────────────────────────────────────────────────────────

echo "→ Creating tag: $TAG"
git tag "$TAG"

# ── Push ─────────────────────────────────────────────────────────────────────

echo "→ Pushing to origin..."
git push origin main
git push origin --tags

echo ""
echo "✓ Released $TAG"
echo "  Commit: $(git rev-parse --short HEAD)"
echo "  Tag:    $TAG"
echo ""
echo "  Install: pi install $(node -p "require('$ROOT_PKG').installUrl || require('$ROOT_PKG').repository")"
