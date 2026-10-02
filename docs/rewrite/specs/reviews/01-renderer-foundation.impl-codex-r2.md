1. major — `apps/desktop/src/renderer-next/lib/bootstrap.ts:158` — `getDb()` throws outside bootstrap’s failure handler. Because `main.tsx` captures the transport only after bootstrap returns, its catch reports through `null` despite an established port. Move DB creation into the prefs failure handler. Test a throwing `getDb()` and assert main receives the bounded failed-readiness report.

2. major — `apps/desktop/src/renderer-next/main.tsx:172` — The port guard precedes the awaited dev-hooks import. Port loss during that import renders the failure screen, then the final `root.render()` overwrites it with an app using the dead transport. Recheck transport state immediately before mounting; test loss during a held import, including the second-loss case.

3. major — `apps/desktop/src/renderer-next/features/shell/occlusion.ts:132` — The new filter misses mutations on ancestors of tracked overlays. Base UI positioner wrappers can move a popup through inline styles without resizing it, leaving published occlusion rectangles stale. Also measure when the mutation target contains a tracked candidate. Test an ancestor transform without resize or scroll.

4. minor — `apps/desktop/src/renderer-next/lib/inert-hidden.ts:20` — `querySelector()` excludes the element itself, so directly hidden buttons and links remain focusable. The attributes-only observer also misses pre-hidden inserted nodes and late focusable children. Handle self matching and insertions, or consistently inert hidden regions. Add those cases to the accessibility tests.

5. major — `apps/desktop/scripts/screenshots-next.mjs:648` — The Linux native-frame probe remains unimplemented. The script records “not automated here” and can exit successfully without exercising that required state. Launch a native-frame run on Linux, assert chrome geometry, capture it, and fail on probe failure.

6. minor — `apps/desktop/scripts/screenshots-next.mjs:456` — The collapsed-state wait discards its timeout result and performs no collapsed geometry assertions. The floating comparison checks only pane position, allowing width reflow to pass. Require stable sidebar and pane rectangles, fail on timeout, assert collapsed width, and compare pane width as well as position.

7. minor — `apps/desktop/src/main/dev/renderer-next.electron.test.ts:403` — R1-T22 proves eventual document replacement, not exactly one initial reload. It also omits first-loss notification and stopped-sync assertions. Count reload events and verify notification plus stopped collections before reconnection.

8. minor — `apps/desktop/src/main/dev/legacy-diff.test.ts:29` — Tests cover reference selection and locale comparison, but never exercise merge-base computation or the commit-pinned `a79707f6` allow-list. A vacuous HEAD comparison or unrestricted file exemption would still pass. Add temporary-repository tests with diverging histories, the sanctioned commit, and subsequent unauthorized edits.

9. minor — `apps/desktop/src/renderer-next/data/fixture-db/memory-source.ts:2` — The header still says main’s tables return `UNAVAILABLE` until sub-slice B lands, contradicting the fix-log claim. Replace it with the current fixture-only gallery and screenshot purpose.
