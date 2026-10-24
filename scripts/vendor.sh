#!/bin/bash
# Copies the pure core and the Files backend into another project (the carapace mod) as plain source.
# Rewrites `./x.ts` imports to `./x` for bundler-style resolution, and stamps each file with the commit it came from.
# Usage: scripts/vendor.sh <destination folder>    (for example ~/carapace/mods/memory/vendor)
set -euo pipefail

DEST=${1:?usage: scripts/vendor.sh <destination folder>}
ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
COMMIT="$(git -C "$ROOT" rev-parse --short HEAD)"
DIRTY="$(git -C "$ROOT" status --porcelain -- src | head -1)"
if [[ -n $DIRTY ]]; then echo "memory-v2 has uncommitted changes in src/; commit first so the stamp is true." >&2; exit 1; fi

rm -rf "$DEST/core" "$DEST/store-files"
mkdir -p "$DEST/core" "$DEST/store-files"
for dir in core store-files; do
  for f in "$ROOT/src/$dir"/*.ts; do
    out="$DEST/$dir/$(basename "$f")"
    {
      echo "// Vendored from memory-v2 @ $COMMIT (src/$dir/$(basename "$f")). Do not edit here: change memory-v2 and run scripts/vendor.sh."
      sed -E "s#(from '\.{1,2}/[^']+)\.ts'#\1'#g" "$f"
    } > "$out"
  done
done
echo "$COMMIT" > "$DEST/VERSION"
echo "vendored memory-v2 @ $COMMIT into $DEST"
