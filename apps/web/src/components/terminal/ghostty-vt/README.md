# ghostty-vt.wasm

The terminal's VT core: ghostty-web 0.4.0's wasm, rebuilt with one upstream Ghostty fix. ghostty-web's JS still
comes from npm (`ghostty-web@0.4.0` and `patches/ghostty-web@0.4.0.patch`); only the wasm comes from here.

**Why:** ghostty-web 0.4.0 ships Ghostty 5714ed07a, which zeroes a new page only in safe builds. The browser
build is ReleaseSmall, and on wasm the allocator hands back freed memory as it was. A page that outgrows the
standard size (a screen with more than about 200 distinct colours or styles) then starts with an old page's
bytes. Widening the terminal reflows into such pages, which gives junk glyphs, repeated prompts and joined
lines on screen and in the scrollback, on every platform.

**Source:** Ghostty 5714ed07a1012573261b7b7e3ed2add9c1504496 (the commit ghostty-web v0.4.0 pins) plus upstream
fix 420de124f04aa322bf250098cc62d7195db94bfd ("fix: ensure memory is zeroed in runtime safety modes for
wasm/freestanding", 29 Mar 2026), cherry-picked. One added line, `const builtin = @import("builtin");` in
`src/terminal/PageList.zig`, because the fix uses `builtin` and that commit already imported it. Then
ghostty-web v0.4.0's `patches/ghostty-wasm-api.patch` and its own build flags:
`zig build lib-vt -Dtarget=wasm32-freestanding -Doptimize=ReleaseSmall`, with zig 0.15.2.

**Rebuild:** `./build-ghostty-vt.sh <scratch dir>` (zig 0.15.2 on PATH). The build is reproducible: run without
the fix, it gives ghostty-web 0.4.0's own wasm byte for byte (sha256 d6f0326f…0c60a).
sha256 of this file: 466b669ea4539dff14988db36d1f7ac59b24ac817d63e364cf308b90934a851a

**Drop it** when ghostty-web ships a wasm built from Ghostty 420de124f or later. Import the package's wasm
again in `../ghostty.ts`.
