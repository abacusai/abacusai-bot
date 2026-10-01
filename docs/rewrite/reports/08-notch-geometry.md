# Notch geometry

## Research, ideas only

No third-party implementation is copied or linked into the application. Sources were inspected on 2026-10-02. Boring Notch is GPL-3.0; DynamicNotchKit and NotchDrop are MIT. Research downloads remain outside the worktree.

[Boring Notch](https://github.com/TheBoredTeam/boring.notch/tree/d58240cc160d5e54da1a8a5925e095d067a8e1e0) uses a transparent, shadowless panel above the main menu, joining Spaces with fullscreen auxiliary behavior. Its black surface has distinct top and bottom corner geometry, and its opened and closed radii differ. The useful principle is to join the bezel with concave shoulders and round the underside, rather than round a rectangle. Its source and GPL license are research references only.

[DynamicNotchKit](https://github.com/MrKai77/DynamicNotchKit/tree/cd0b3e52d537db115ad3a9d89601f20e0bee8d27/Sources/DynamicNotchKit) measures auxiliary top areas and safe-area height. It reserves an empty central column for the camera, places compact content on either side, and expands content below it. Its transparent panel uses screen-saver level, joins Spaces, and disables native shadow. A floating style handles displays without a notch. Width, height and corner treatment change with presentation. Its screen extension computes menu-bar reservation from that screen's frame and visible frame, rather than a global status-bar constant.

[NotchDrop](https://github.com/Lakr233/NotchDrop/tree/e70b3d715a99e47de6eb823540282eafc7401a3a/NotchDrop) also uses auxiliary areas, a transparent elevated window, fullscreen auxiliary behavior and black fill. It supplies a synthetic size when no notch exists. For this application a floating capsule is preferable to pretending an external display has a camera cutout. Its window controller demonstrates why AppKit's bottom-left coordinates must be converted before use in Electron's top-left coordinate system.

Apple's [safeAreaInsets](https://developer.apple.com/documentation/appkit/nsscreen/safeareainsets), [auxiliaryTopLeftArea](https://developer.apple.com/documentation/appkit/nsscreen/auxiliarytopleftarea) and [auxiliaryTopRightArea](https://developer.apple.com/documentation/appkit/nsscreen/auxiliarytoprightarea) describe usable screen regions in points. The gap between the left area's right edge and the right area's left edge supplies both notch position and width. Keep these values in points for Electron DIP coordinates; backing scale converts captures to pixels, not window positions. Reprobe after display configuration changes. A menu bar that auto-hides changes the visible frame, not the hardware exclusion. Anchor a notched panel to the full screen's top edge.

The resulting design uses symmetric content ears around the measured camera exclusion. The expanded body starts below the exclusion. One pure-black clipped outline merges into the hardware, with small outward top curves and larger smooth bottom corners. Interruptible size transitions keep the top edge fixed. No shadow or border belongs along the bezel. NotchNook is closed-source and supplies no implementation evidence here. Its [vendor page](https://lo.cafe/notchnook) returned HTTP 502 during inspection, so this report makes no claims about its internal geometry or window behavior.

## Initial measurement and audit

The task host's built-in display is 1710 × 1107 points at backing scale 2. AppKit reports left auxiliary area `(0,1074,763,33)` and right auxiliary area `(948,1074,762,33)`. In Electron coordinates the camera exclusion is `(763,0,185,33)`. Its center is 855.5 points, not the display center of 855. The visible frame is `(0,0,1710,1073)` in AppKit coordinates, reserving 34 points at the top. The global status-bar thickness is 22 points and is unsuitable as the notch height.

The original probe discards auxiliary origins. Placement centers on the display rather than the measured exclusion. The renderer cuts a rectangular hole through the black surface, uses ordinary bottom border radii, and rounds the ears separately from the body. Hovering idle adds height without widening its 48-point ears. The director clamps collapsed height to 36 even when hardware needs more. Cached measurements survive configuration changes with the same dimensions. Native frame and capture evidence follow below.

Capture directory: `/Users/rajaniraiyn/work/abacusai-bot/.build/ui-audit/notch/`. This directory is never committed.


## Changes

The JXA probe now retains both auxiliary rectangles, the display ID, per-display menu-bar reservation and backing scale. It safely handles displays with no auxiliary area. The exclusion's horizontal origin travels to the renderer. Native placement uses its center, and a fractional renderer offset compensates for Electron's integer frame rounding. A display configuration event clears cached metrics, even when screen dimensions have not changed. Hardware placement ignores the work area, so auto-hiding the menu bar cannot shift the notch. A notchless Mac display gets a capsule eight points below its work-area top. Windows keeps its existing taskbar-aware capsule placement.

The shadowless panel uses Electron's screen-saver level and joins fullscreen Spaces. It remains non-focusable until an explicit interaction requests focus. Quiet-hours policy, delayed pointer leave, click-through, readiness and audio ownership remain covered by existing tests.

The renderer now paints one pure-black shape. CSS `shape()` describes concave six-point top shoulders and twenty-point bottom curves with zero curvature at their straight joins. Percentage coordinates keep the clip attached at every intermediate size. The central spacer reserves the measured camera width, while the full header reserves its height. Text and buttons truncate within the ears. Separate ear/body corner rounding and the rectangular camera hole are gone.

Idle hover now widens each ear from 48 to 130 points and provides 68 points below the camera for controls. Reply reserves enough height for three text lines, its input and actions. Collapsed and recovery states retain the measured camera height rather than imposing a 32/36-point ceiling. Width and height transition for 250 ms using the existing notch easing. Width animation is intentional here: scaling the surface would also scale the camera spacer and move content under the hardware. The director still reserves the larger native envelope before animation and shrinks it after settlement; interruptions start from the currently rendered size.

The companion router no longer uses document view transitions. Their detached snapshots can escape an ancestor clip and retain old window coordinates while the native envelope changes. The surface's CSS transition is the sole resize animation. Other application routers are unchanged.

## Capture evidence

All primary captures used successful `screencapture -x -R 515,0,680,280` calls on the built-in display. No Screen Recording fallback was needed. The crop is 680 × 280 points, stored as 1360 × 560 pixels. A neutral gray native window behind the controlled shell makes the black silhouette visible against a consistent background. It is an audit backdrop, not product UI.

The controlled harness mounts the production `NotchShell`, `IdleView`, `ReplyView`, `ListeningControls` and permission list in the production native notch window. It supplies deterministic presentation data and stubs external activity, voice and audio. The before harness uses this branch's original source at `789bdce7`; the after harness uses the changed source. It does not approve permissions, execute the displayed command, send a message or access the microphone. Measurements come from `BaseWindow.getBounds()` and the actual DOM. These are real native screen captures of production components, not gallery drawings or live agent runs.

Paths below are relative to `/Users/rajaniraiyn/work/abacusai-bot/.build/ui-audit/notch/`.

| State | Before capture | After capture | Before native frame, points | After native frame, points |
| --- | --- | --- | --- | --- |
| Collapsed | `before/collapsed.png` | `after/collapsed.png` | 691, 0, 329, 65 | 691, 0, 329, 65 |
| Hover expanded | `before/hover-expanded.png` | `after/hover-expanded.png` | 691, 0, 329, 111 | 609, 0, 493, 133 |
| Listening | `before/listening.png` | `after/listening.png` | 609, 0, 493, 197 | 609, 0, 493, 197 |
| Reply | `before/reply.png` | `after/reply.png` | 609, 0, 493, 149 | 609, 0, 493, 197 |
| Attention | `before/attention.png` | `after/attention.png` | 619, 0, 473, 252 | 609, 0, 493, 252 |

Native frames include the existing transparent 24-point side margins and 32 points below. The visible collapsed shape is 281 × 33 points, centered on the 185 × 33 camera exclusion. The visible hover shape grows from 281 × 79 to 445 × 101. The camera remains at global `(763,0,185,33)` in every state. Full measurements are in `before/frames.json` and `after/frames.json`. Earlier gallery-only comparisons have the `-gallery.png` suffix and are supplementary, not the primary evidence.

The actual signed-in application was also launched before and after with fresh `copyPerfHome` copies of `perf-home-real`. The source remained read-only. Each copy received a local audit bot because the original fixture contains no bots and the companion correctly hides in that condition. Outbound networking was blocked. `before/live-collapsed.png`, `before/live-hover-expanded.png`, `after/live-collapsed.png` and `after/live-hover-expanded.png` show the application on the desktop without the gray backdrop. `live-frames.json` in each directory records its screen position and renderer viewport. The after app independently confirms the 281 × 33 collapsed and 445 × 101 hover shapes at y=0. All capture applications were terminated and disposable signed-in profiles removed.

## Validation

Connectors, agent and updater were built before dist-dependent tests. All pnpm commands used `--pm-on-fail=ignore`.

- The full renderer and main run passed 467 files and 3,924 tests with `--maxWorkers=2`.
- The final focused run passed 21 files and 104 tests. These cover notch geometry, asymmetric auxiliary areas, fractional centers, scale factors 1/1.5/2/3, menu-bar auto-hide invariance, capsule fallback, unchanged-dimension display invalidation, larger camera-height preservation, outlines and companion routing.
- The main-serial native notch suite passed. It checks y=0 on macOS, 20 native lifecycle/disposal cycles, child viewport resizing, listening controls in three languages and three display modes, permission content fit and sound synthesis.
- Root `tsc -b`, oxlint and repository oxfmt checks passed.
- i18n, locales, React compiler, UI registry, dependency audit, knip, release-graph and chat-bundle checks passed. Knip prints existing configuration hints but no unused-file failure.
- `check:release-versions` could not validate a release because it requires an installer package, update YAML and experience manifest as arguments. Those packaged artifacts were not produced by this task. Its invocation and usage error are saved in `check-versions.log`.

Logs and the scratch capture/build scripts remain in the capture directory. No screenshots, profiles, downloaded source or credentials are committed.

## Checks needing physical eyes

This machine was measured at one actual scaling mode, 1710 × 1107 at 2×. Other scale factors, asymmetric displays and auto-hide geometry are covered by tests, not by changing this user's display settings. There is no connected external display to inspect. Fullscreen Space joining is configured but a physical fullscreen/Space-switch pass remains useful. Screenshots capture the composited framebuffer, not the opaque camera housing itself; the final visual merge against the real bezel and rapid hover reversal should be checked on the MacBook. The signed-in desktop captures can include other applications active during the audit; the controlled captures isolate the silhouette with a backdrop.
