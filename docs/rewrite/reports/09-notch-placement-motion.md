# Notch placement and motion

This change supersedes the placement and resize-animation decisions in report 08. Implementation research was refreshed on 2026-10-07. No third-party code was copied.

The native window reserves the maximum 560 × 220 point shape, plus the existing transparent margins, when it is created. Presentation changes update visibility and audio eligibility without changing native or child-view bounds. Display configuration changes can reposition the envelope. The director sends one final report and no longer waits for CSS transition events or requests intermediate envelope sizes.

On macOS every display anchors at `display.bounds.y`, including external and non-notched screens. Hardware safe-area and auxiliary-area measurements, fractional camera center compensation, and the empty camera column remain intact. Windows centers the envelope at the display top and reserves a top taskbar using that display's work area. Side and bottom taskbars do not move it. Both platforms honor `prefs.notch.extraDisplays`.

Motion animates numeric shell dimensions with a 300 ms spring and 0.1 bounce, then maps those values to a centered CSS path clip inside the fixed envelope. The drawn shape has inward top shoulders and round bottom corners. Content lays out at its destination size without scaling text or the camera column. Wings fade after the shell settles; body controls follow by 50 ms. Reduced motion uses immediate shell changes. Hover opens after 120 ms and closes with 300 ms grace. Replies, approvals and typing remain interactive across pointer leave.

Forwarded pointer movement uses Chromium's clipped `elementFromPoint` result to choose native click-through. Transparent margins and clipped corners do not start hover. Native hover interaction no longer changes focusability or blurs a typing session. Input pointer-down and focus request both the panel's key focus and its active web contents. Escape, submission and collapse release focus. The existing macOS non-activating panel, screen-saver level and all-Spaces/fullscreen behavior remain in use.

## Reference notes

- [DynamicNotchKit](https://github.com/MrKai77/DynamicNotchKit/tree/main/Sources/DynamicNotchKit), MIT: `DynamicNotch/DynamicNotch.swift` reserves a transparent panel at the display's top; `Utility/DynamicNotchPanel.swift` allows key focus without ordinary app activation and sets screen-saver/stationary/all-Spaces behavior. `DynamicNotch/DynamicNotchTransitionConfiguration.swift` documents a 300 ms spring and direct compact/expanded conversion. Those ideas informed the fixed envelope and spring.
- [boring.notch](https://github.com/TheBoredTeam/boring.notch/blob/main/boringNotch/ContentView.swift), GPL, ideas only: `ContentView.swift` uses a shared interactive spring with response 0.38 and damping 0.8, cancellable hover tasks, and a 100 ms leave grace. Separate open/close springs use 0.42/0.8 and 0.45/1.0. The lesson is one interruptible shell animation and deliberate hover timing, not simultaneous native/CSS resizing. No GPL implementation was copied.
- [NotchDrop](https://github.com/Lakr233/NotchDrop/blob/main/NotchDrop/NotchWindow.swift), MIT: transparent, shadowless window, elevated status-bar level, stationary/all-Spaces/fullscreen auxiliary behavior. Its measurement code reinforces per-display coordinates.
- [Notchmeister](https://github.com/chockenberry/Notchmeister/blob/main/Notchmeister/Notchmeister/NotchExtensions.swift): `NotchExtensions.swift` measures a fake notch using the individual display and its menu-bar reservation. Its decorative spring effects are not appropriate timing targets for reply controls.
- [Alcove](https://tryalcove.com/) presents compact live activities with fluid transitions. [MediaMate](https://wouter01.github.io/MediaMate/) emphasizes compact HUDs and support across Macs. Their product pages do not expose spring parameters or native implementation details.
- [Look Alive](https://www.lookalive.app/) describes agent faces, decision prompts, replies in the notch and a pill on external displays. That supports a compact companion with usable reply controls on either display type. Its site was readable via HTTP after the browsing tool failed.
- [NotchNook](https://lo.cafe/notchnook) was requested as a reference, but its vendor page returned HTTP 502. No claims about its internal animation or window implementation are inferred from marketing or third-party reviews.

## Verification

- Desktop main/preload: 286 files, 2,588 tests passed.
- Renderer and browser-gating suites: 264 files, 2,207 tests passed. The focused notch run passed 10 files and 48 tests.
- Native notch suite: passed on the host's LG Ultrawide external display, 2560 × 1080 at 60 Hz. It checks 20 disposal cycles, Chromium viewport fitting, camera clearance, clipped shoulders and underside, listening controls, permission content and audio synthesis.
- Typecheck for desktop/web and dependencies, oxlint, oxfmt, desktop production build and `git diff --check` passed.
- An isolated dev launch uses `/private/tmp/abacus-notch-motion-profile`, with the shell API key removed and debug port 9447. The dev server and Electron process start; visual inspection through the desktop automation tool timed out. Automated native layout verification is not a visual inspection of the full app.

Real Windows interaction, macOS Spaces changes, focus return to another app, and subjective spring feel need human verification. In particular, check the actual companion on an external display at the top edge, rapid hover reversals, clicking Reply, typing while the pointer leaves, and Escape/submission returning focus.
