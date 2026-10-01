# Notch geometry

## Research, ideas only

No third-party implementation is copied or linked into the application. Sources were inspected on 2026-10-02. Boring Notch is GPL-3.0; DynamicNotchKit and NotchDrop are MIT. Research downloads remain outside the worktree.

[Boring Notch](https://github.com/TheBoredTeam/boring.notch/tree/d58240cc160d5e54da1a8a5925e095d067a8e1e0) uses a transparent, shadowless panel above the main menu, joining Spaces with fullscreen auxiliary behavior. Its black surface has distinct top and bottom corner geometry, and its opened and closed radii differ. The useful principle is to join the bezel with concave shoulders and round the underside, rather than round a rectangle. Its source and GPL license are research references only.

[DynamicNotchKit](https://github.com/MrKai77/DynamicNotchKit/tree/cd0b3e52d537db115ad3a9d89601f20e0bee8d27/Sources/DynamicNotchKit) measures auxiliary top areas and safe-area height. It reserves an empty central column for the camera, places compact content on either side, and expands content below it. Its transparent panel uses screen-saver level, joins Spaces, and disables native shadow. A floating style handles displays without a notch. Width, height and corner treatment change with presentation. Its screen extension computes menu-bar reservation from that screen's frame and visible frame, rather than a global status-bar constant.

[NotchDrop](https://github.com/Lakr233/NotchDrop/tree/e70b3d715a99e47de6eb823540282eafc7401a3a/NotchDrop) also uses auxiliary areas, a transparent elevated window, fullscreen auxiliary behavior and black fill. It supplies a synthetic size when no notch exists. For this application a floating capsule is preferable to pretending an external display has a camera cutout. Its window controller demonstrates why AppKit's bottom-left coordinates must be converted before use in Electron's top-left coordinate system.

Apple's [safeAreaInsets](https://developer.apple.com/documentation/appkit/nsscreen/safeareainsets), [auxiliaryTopLeftArea](https://developer.apple.com/documentation/appkit/nsscreen/auxiliarytopleftarea) and [auxiliaryTopRightArea](https://developer.apple.com/documentation/appkit/nsscreen/auxiliarytoprightarea) describe usable screen regions in points. The gap between the left area's right edge and the right area's left edge supplies both notch position and width. Keep these values in points for Electron DIP coordinates; backing scale converts captures to pixels, not window positions. Reprobe after display configuration changes. A menu bar that auto-hides changes the visible frame, not the hardware exclusion. Anchor a notched panel to the full screen's top edge.

The resulting design uses symmetric content ears around the measured camera exclusion. The expanded body starts below the exclusion. One pure-black clipped outline merges into the hardware, with small outward top curves and larger smooth bottom corners. Interruptible size transitions keep the top edge fixed. No shadow or border belongs along the bezel. NotchNook is closed-source and supplies no implementation evidence here.

## Initial measurement and audit

The task host's built-in display is 1710 × 1107 points at backing scale 2. AppKit reports left auxiliary area `(0,1074,763,33)` and right auxiliary area `(948,1074,762,33)`. In Electron coordinates the camera exclusion is `(763,0,185,33)`. Its center is 855.5 points, not the display center of 855. The visible frame is `(0,0,1710,1073)` in AppKit coordinates, reserving 34 points at the top. The global status-bar thickness is 22 points and is unsuitable as the notch height.

The original probe discards auxiliary origins. Placement centers on the display rather than the measured exclusion. The renderer cuts a rectangular hole through the black surface, uses ordinary bottom border radii, and rounds the ears separately from the body. Hovering idle adds height without widening its 48-point ears. The director clamps collapsed height to 36 even when hardware needs more. Cached measurements survive configuration changes with the same dimensions. Native frame and capture evidence follow below.

Capture directory: `/Users/rajaniraiyn/work/abacusai-bot/.build/ui-audit/notch/`. This directory is never committed.
