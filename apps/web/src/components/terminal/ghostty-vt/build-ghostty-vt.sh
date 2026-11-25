#!/bin/bash
# Rebuilds ghostty-vt.wasm (see README.md). Usage: build-ghostty-vt.sh <scratch dir>; needs git and zig 0.15.2 on PATH.
set -euo pipefail
GHOSTTY_WEB=75490c102c9030371caaecc6fd934068cc30ce3b # ghostty-web v0.4.0
BASE=5714ed07a1012573261b7b7e3ed2add9c1504496        # the Ghostty commit ghostty-web v0.4.0 pins
FIX=420de124f04aa322bf250098cc62d7195db94bfd         # "ensure memory is zeroed ... for wasm/freestanding"
DIR=$1; OUT=$(cd "$(dirname "$0")" && pwd)
[ "$(zig version)" = 0.15.2 ] || { echo "zig 0.15.2 required" >&2; exit 1; }
mkdir -p "$DIR" && cd "$DIR"
[ -d ghostty-web ] || git clone -q https://github.com/coder/ghostty-web.git
[ -d ghostty ] || git clone -q https://github.com/ghostty-org/ghostty.git
git -C ghostty-web checkout -q $GHOSTTY_WEB
cd ghostty && git checkout -q -- . && git clean -qfd && git checkout -q --detach $BASE
git cherry-pick -n $FIX
# The fix uses `builtin`, which PageList.zig at this base does not import yet.
sed -i '0,/^const std = @import("std");/s//const std = @import("std");\nconst builtin = @import("builtin");/' src/terminal/PageList.zig
git apply ../ghostty-web/patches/ghostty-wasm-api.patch
zig build lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall
cp zig-out/bin/ghostty-vt.wasm "$OUT/ghostty-vt.wasm"
sha256sum "$OUT/ghostty-vt.wasm"
