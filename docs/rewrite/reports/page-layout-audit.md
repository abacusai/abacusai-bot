# Page layout audit

The cross-page cleanup builds on the existing `form-kit` and registry controls on main. It has no dependency on the Sessions stack, and does not copy its floating-surface or tab components.

- Reading columns remain capped at 1040px; grids at 1280px. The 24px desktop gutter comes from `01-renderer-foundation.md` and the existing `content-col` rules. Below 800px it becomes 16px, preserving the phone designs.
- Page tops use the existing Settings rhythm: 40px on desktop, 24px on phones; section gaps are 16px. `page-column`, `PageToolbar` and `page-title` now share these values with Routines, Artifacts and Bots start pages.
- Settings/Library controls wrap according to their row's container width. Below 360px controls get a full row. Category filters wrap instead of hiding choices beyond a horizontal strip. Touch sizes and translated labels remain intact.
- Cards reuse the shell's existing 12px `pane-radius`. Bot details reuse `GroupCard` and the same 52px minimum setting row. Internal list separators convey rows; the Sessions stack separately removes gutter lines between islands.
- Onboarding keeps its distinct canvas type scale and stage, with the shared responsive horizontal gutter. Existing Base UI dialogs, menus, focus management, TanStack Form validation and EmptyState stay in use.

Run `ABACUSAI_BOT_DEBUG_PORT=9560 LAYOUT_REPORT=/tmp/pages.json node apps/web/scripts/check-page-layout.mjs` against an isolated seeded desktop development instance. It checks all Settings and Library routes, Bots start, Routines and Artifacts at 640/800/1000/1280/1710/2560. It changes only viewport emulation and navigation, then clears the emulation. Deliberate internal scroll regions are excluded from page overflow.
