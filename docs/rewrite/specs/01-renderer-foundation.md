# 01 — Renderer foundation (phase 1)

Status: draft spec **r2** (no code); r1 reviewed by Codex (`reviews/01-renderer-foundation.codex-r1.md`, 24 findings), responses at the end. Branch `rewrite/renderer`, stacked on the phase 0 PRs `rewrite/00a-transport` and `rewrite/00b-db-tables` (spec `00-transport-db-migration.md` r2, sections A and B) and on the window-chrome slice (spec `00-window-chrome.md` r2, commit `a059a113`). Paths are relative to `apps/desktop/` unless noted. Line citations are against `HEAD` `3e46fe3e`; `src/main/index.ts` has uncommitted edits in the working tree, so its numbers are the committed ones.

Sources read: `docs/rewrite/PLAN.md` (rev 6, all of it); spec 00 transport A.1–A.12 and B.1–B.8 (r2); spec 00 window chrome §6 (renderer contract), §3 (capability), §6 "Popups over the title bar"; the design canvas (`project/canvas.json` plus the boards on pages 1, 5, 6 and the shell parts `Rail`, `TopBar`, `BotsSidebar`, `SessionsSidebar`, `HoverSidebar`, `WidthRules`); reference clones under `scratchpad/refs` (router 1.170.40 / router-plugin 1.168.41 / router-generator tests, db 0.10.0 source, ui with shadcn CLI 4.21.0 source and `style-mira.css`); npm registry (queried 30 Sep 2026); skills `tanstack-router`, `tanstack-db`, `tanstack-query`, `shadcn`, `vercel-react-view-transitions`, `vercel-composition-patterns`.

---

## 0. Findings that change the brief (read first)

These were checked against source, not assumed. Each is carried into the sections below.

| # | Brief / plan says | Verified fact | Consequence in this spec |
|---|---|---|---|
| F1 | "babel-plugin-react-compiler with `@vitejs/plugin-react`" | No Babel is needed. `@vitejs/plugin-react` **6.1.1** (npm latest; installed 6.0.5) has a native `compiler?: boolean | ReactCompilerPluginOptions` option backed by `oxc-transform-react`, a Rust port of the compiler, declared as an **optional** peer `^0.145.0` (vitejs/vite-plugin-react#1419; `@vitejs/plugin-react@6.1.1 dist/index.d.ts` `Options.compiler`, README "Rust React Compiler", marked experimental). The option takes compiler options (`compilationMode`, `target`, …, plus `logDiagnostics`) but **no include/exclude of its own**: the compiler plugin filters with the React plugin's own `include`/`exclude` (`dist/index.js:194`, `createReactCompilerPlugin(…, include, exclude, …)`). With `compiler` on, that instance also turns off oxc's Fast Refresh transform and does refresh itself, only for its `include` (`dist/index.js:76`). Verified in a scratch Vite 8.2.1 project (below). | §3.3: **two `react()` instances, compiler instance first**: `react({ include: NEXT_SRC, compiler: true })` then `react({ exclude: [node_modules, NEXT_SRC] })`. Measured: renderer-next files compiled + Fast Refresh; old renderer files not compiled + Fast Refresh kept, in dev and in build. The reverse order, or a single scoped instance, drops Fast Refresh for the old renderer. |
| F2 | `@tanstack/db` 0.10.0 / `@tanstack/react-db` 0.4.2 (PLAN L58, spec 00 B) | Those versions exist only in the clone (`refs/db/packages/db/CHANGELOG.md:3`). npm `latest` is **0.9.2 / 0.4.1** (published 14 Sep 2026). 0.9.2 already has the receipt-returning `commit()`, `truncate`, `markReady`, `markError`, `rowUpdateMode` that spec 00 B.3 relies on (`@tanstack/db@0.9.2 dist/esm/types.d.ts:318-340`). | Pin 0.9.2 / 0.4.1 exact; bump to 0.10.0 / 0.4.2 in a one-line PR when published. Spec 00 B.5 needs the same correction (§15). |
| F3 | "one components.json per project — decide subfolder + `tailwind.css`, or `--cwd`" | The CLI reads `package.json` **exactly at `cwd`** (`packages/shadcn/src/utils/get-package-info.ts:5-13`), resolves `#` aliases from that file's `imports` (`utils/package-imports.ts:19-31`, first `./` target of an array, `utils/import-matcher.ts:26-51`), and writes `components.json` at `cwd` (`commands/init.ts:732`). A subfolder `--cwd src/renderer-next` has no `package.json`, so alias resolution and dependency install both fail. Config lookup is `cosmiconfig.search(cwd)` upward (`utils/get-config.ts:26-28,198`). | **Decision: the single `apps/desktop/components.json` is re-pointed at renderer-next** (hand-written; `init` never runs in this package, see F4). The old renderer's `components/ui` is frozen from now on. §5.1. |
| F4 | shadcn init "`--base base --preset mira` with lucide" | The `mira` preset is `iconLibrary: "hugeicons"`, `menuColor: "default"`, `rtl: false` (`packages/shadcn/src/preset/defaults.ts:64-78`). With a preset, init backs up any existing `components.json` and re-infers aliases from the project (`commands/init.ts:540-560`, `utils/get-project-info.ts:524-560`); a generic `#next/*` wildcard gives it nothing recognisable to infer `components/ui/lib` from, and files are written with the inferred aliases before any post-fix could run (Codex r1 #3). `add` with an existing `components.json` does **not** infer (`getProjectConfig` returns the existing config first, `get-project-info.ts:530-540`). | §5.1: run `init --base base --preset mira` **once in an isolated scratch package** with a standard layout, take its generated CSS, `cn` helper and dependency list, and hand-write this package's `components.json`; every later `add` runs in place, gated by `--dry-run` path assertions. |
| F5 | PLAN "Nuked: tw-animate-css" | The base registry style declares `devDependencies: ["tw-animate-css", "shadcn"]` and writes `@import "tw-animate-css"` (`apps/v4/registry/bases/base/registry.ts:17-27`); `style-mira.css` uses `animate-in`, `fade-in-0`, `zoom-in-95` from it. | Keep `tw-animate-css` (registry-owned; `ui/` is never edited). Remove it from the "nuked" list in PLAN. |
| F6 | "sonner/toast" | Registry `sonner.tsx` imports `next-themes` (not in this app); registry `toast.tsx` is Base UI Toast with `data-slot="toast-viewport"`, which is exactly the slot the window-chrome occlusion/no-drag list names. | renderer-next uses registry **`toast`**. `sonner` stays a dependency only for the old renderer. |
| F7 | `useAppNavigate` with `startTransition` + `addTransitionType` | The router commits matches inside its own `React.startTransition(fn, expected)` assigned on every `Transitioner` render (`refs/router/packages/react-router/src/Transitioner.tsx:31-37`). It calls it twice per slow navigation: once to **offer pending matches** (`router-core/src/load-client.ts:1524-1530`, one match `status: "pending"`) and once to **commit** (`load-client.ts:1870-1881`; a superseded navigation returns before `commit`). A type added in the caller's sync `startTransition` is lost; awaiting `navigate()` inside an async action deadlocks on the render acknowledgement. React 19.3's `addTransitionType` outside a transition logs and starts its own (`react@19.3.0 cjs/react.development.js:586-599`). | §6.7: intent travels **in the history entry's state** (`navIntent: { id, type }`), and a seam around `router.startTransition` adds types only on the **commit** call (no pending match), only for the location that is actually committing, once per navigation id. Router pinned exact. |
| F8 | `motion` 12.x (PLAN L68) | npm `latest` is `motion` **13.4.6** (peer `react ^18 || ^19`); import path stays `motion/react`. | Use 13.4.6. |
| F9 | i18next "latest" | Latest are i18next 26 / react-i18next 17 (majors). Both renderers share one `package.json`. | Keep the installed majors (`i18next ^25.8.7`, `react-i18next ^16.5.4`) in phase 1; the major bump is a separate PR that tests both renderers. |
| F10 | TanStack Devtools cockpit incl. "db" | There is no published DB devtools package (`@tanstack/db-devtools` and `@tanstack/react-db-devtools` 404 on npm). | Cockpit ships a 60-line in-app "Collections" plugin (status, rows, epoch, seq) until an official one exists. |
| F11 | Rail per PLAN L248: Bots, Sessions, Routines, Artifacts, **Library**; canvas `Rail.dc.html` shows 4 items + a bottom **Connectors** button | PLAN rev 6 is newer than the Rail board. | Library is the fifth top item, drawn with the canvas's Connectors duotone glyph; Settings and Account stay at the bottom. Canvas Rail board to be updated (design follow-up, not a blocker). |
| F12 | Spec 00 puts transport and collections in `src/renderer/data/**` | The new renderer lives in `src/renderer-next/` until cut-over. | Those modules are created in `src/renderer-next/data/**` instead; spec 00 A.7/A.9/A-T7/B.3/B.5 paths are amended (§15). They move with the tree at cut-over. |

---

## 1. Scope

### 1.1 In scope

The empty-but-real shell of the new renderer, runnable in the real app with real data:

- **Entry and build:** `index-next.html` + `src/renderer-next/main.tsx` as a second Vite input; main loads it when `RENDERER_GENERATION === "wco"` (§3.6). The old renderer (`index.html` → `src/renderer/main.tsx`) is untouched.
- **Routes (file-based):** `__root`, pathless `_shell` (Rail + SidebarSlot + TopBar + content pane + SidePanel + Outlet), pathless `_bare`, `/` → `/bots/new`, and a placeholder for **every** route in PLAN's route tree (bots, sessions, routines, artifacts, library, settings, onboarding, `/__ui`), each rendering an `Empty` state and selecting the right sidebar. Masked pop-up routes exist as placeholders so the masks, search schemas and the route-tree snapshot are fixed now.
- **Shell behaviour:** pinned/collapsed sidebar with floating-on-rail-hover, the four width bands (≥1100, 1000–1099, 900–999, 800–899) from canvas page 6, side panel in layout vs drawer, title bar from `env(titlebar-area-*)` and the capability state (canvas page 5), light/dark/system from the prefs collection.
- **Data:** oRPC transport over the MessagePort (spec 00 A.7), `@orpc/tanstack-query` utils, the collections registry via `ipcCollectionOptions` (spec 00 B.3), prefs + theme, query-options skeletons, TanStack Store slices for ephemeral shell UI. **Live sidebars:** Bots (from `bots`), Sessions (from `sessions` + `workspaces`), Routines (from `routines`, names only); Library and Settings sidebars are static navigation.
- **Cross-cutting modules:** motion presets, sound presets (shaped, silent), keyboard (⌘K, ⌘N, ⌘B, ⌘⌥B, ⌘,), occlusion watcher, window-chrome hooks, i18n boot, devtools cockpit, `/__ui` gallery and the screenshot script.

### 1.2 Out of scope (phase 2+)

Chat of any kind (no `createChatUI`, no `ai.*` calls, no composer beyond a static placeholder in the gallery), BotAvatar (a coloured circle stands in), onboarding flow logic (routes exist, render empty states), the notch window, sound synthesis, the migration runner UI (spec 00 C), deleting anything from the old renderer, bumping i18next majors.

### 1.3 Gate (from PLAN phase 1)

Shell renders with real sidebars from collections; 4 widths × 2 themes screenshots match canvas pages 1, 5, 6 (§12).

---

## 2. Current state (what exists, cited)

- **Vite:** one config for main, preload and renderer. No `root` is set, so the renderer entry is `apps/desktop/index.html` (`index.html:14` loads `/src/renderer/main.tsx`); `build.outDir` is `dist/renderer` (`vite.config.ts:38`); plugins `tailwindcss()`, `react()`, `vite-plugin-electron` (`vite.config.ts:46-110`); aliases `#main #preload #renderer #shared` repeated from `package.json` `imports` (`vite.config.ts:112-125`, `package.json:11-34`). `src/renderer/index.html` is a stale duplicate that points at `/src/main.tsx` and is not a build input.
- **Main loads the renderer** in `loadAppContent` (`src/main/index.ts:678-695`): restored URL, else `VITE_DEV_SERVER_URL` (`:675`), else the experience `app://bundle.<hash>/` URL (`services/updates/experience/app-protocol.ts:18-24`, `runtime.ts:36-40`), else `loadFile(../renderer/index.html)` (`:692`). `RENDERER_GENERATION` is `"legacy"` (`src/main/renderer-generation.ts:5`) and today only switches window chrome (`index.ts:456,534,752,1232`); main exposes chrome state as a main-only `ipcMain.handle("window:chrome")` (`index.ts:1221-1226`).
- **CSP:** the same policy as a `<meta>` (`index.html:6-9`) and as a response header for `app://` documents (`src/main/renderer-csp.ts:4-7`). No `ws:` other than same-origin, no `unsafe-inline` scripts.
- **TypeScript:** 7.0.2 (`pnpm-workspace.yaml` catalog). `tsconfig.json` references main, preload, renderer, vite projects. `tsconfig.renderer.json:4,11` has `types: ["vite/client","electron"]` and includes `src/renderer`, `src/shared`, `src/preload/*.d.ts` (so the old renderer sees `window.api`).
- **Vitest:** projects `renderer` (jsdom, `src/renderer/**/*.test.{ts,tsx}`, setup `src/renderer/test-support/setup.ts`), `main`, `main-serial`, `preload`, `shared` (`vitest.config.ts:65-118`); `test:unit` runs `shared main renderer` (`package.json:51`). The renderer setup stubs `ResizeObserver`, `localStorage`, `matchMedia` (always `matches: false`), pointer capture and `scrollIntoView` (`test-support/setup.ts:17-77`).
- **shadcn:** `components.json` style `base-mira`, `baseColor: neutral`, `iconLibrary: lucide`, `rtl: true`, css `src/renderer/assets/base.css`, aliases `#renderer/*`, `menuColor: default-translucent`, extra registry `@aceternity` (`components.json:3-26`). shadcn CLI 4.19.0 and `@base-ui/react` 1.7.0 installed (`package.json:72,118`).
- **Tailwind 4.3.3** via `@tailwindcss/vite`; `base.css` imports `tailwindcss`, `tw-animate-css`, `shadcn/tailwind.css`, Inter and JetBrains Mono (`assets/base.css:1-5`), declares `@custom-variant dark (&:is(.dark *))` (`:7`), neutral tokens with a magenta primary (`:84-146`, `.dark` at `:147`), and a transparent-background mode for vibrancy (`:25-29`).
- **i18n:** `i18n.ts` bundles `en-US` and lazy-loads 10 more locales (`i18n.ts:15-26`), picks the stored language from `durableStorage` (`:70-82`), applies `lang`/`dir` (`:92-95`), and `main.tsx` awaits it before rendering (`main.tsx:32-33`). 1,643 keys in `en-US.json` under 52 top-level objects (largest: `workspace` 351, `bots` 165, `capabilities` 165, `routines` 109). `check:i18n` scans `SCAN_DIRS = ["src/renderer"]` (`scripts/check-jsx-i18n.js:35`); `sync-locales` reads `src/renderer/locales` and checks `t()` keys under `src/renderer` (`scripts/sync-locales.js:19,75`).
- **Router today:** code-based, `createHashHistory()`, `defaultPreload: "intent"`, `defaultPreloadStaleTime: 0` (`router.tsx:560-567`).
- **Lint:** oxlint `correctness` + a renderer override that turns the React Compiler rules **off** (`oxlint.config.ts:17-40`). No knip.
- **Contract/transport:** not implemented yet (`src/shared/contract/` does not exist); phase 1 depends on spec 00 A and B landing first.

---

## 3. Dependencies

All versions queried on npm on 30 Sep 2026. The desktop app keeps bundled renderer libraries in `devDependencies` (`package.json:67-130`), and this spec follows that. Exact pins where noted; `^` elsewhere matches the file's style. pnpm's release-age gate applies (`pnpm-workspace.yaml` `minimumReleaseAgeExclude`); every version below is older than 7 days except where flagged.

### 3.1 Add or bump

| Package | Version | Kind | Why / note |
|---|---|---|---|
| `react`, `react-dom` | **^19.3.0** (catalog) | bump from 19.2.8 | Stable `ViewTransition`, `addTransitionType`, `Activity` exports (verified in `react@19.3.0 cjs/react.production.js`). Bumps the old renderer too (minor; its suite must stay green). Published 9 Sep 2026. |
| `@types/react`, `@types/react-dom` | ^19.3.0 (catalog) | bump | Types for the above. |
| `@tanstack/react-router` | **1.170.40** exact | bump from ^1.170.31 | File routes, `retainSearchParams`/`stripSearchParams`, `createRouteMask`. Exact because of the §6.7 seam. |
| `@tanstack/router-plugin` | 1.168.41 exact | add | Vite plugin `tanstackRouter` (export verified in `dist/esm/vite.d.ts:130-131`). |
| `@tanstack/react-router-devtools` | 1.167.2 | add | `TanStackRouterDevtoolsPanel` for the cockpit. |
| `@tanstack/db` | **0.9.2** exact | add | See F2. Also added by spec 00 B; one entry. |
| `@tanstack/react-db` | **0.4.1** exact | add | `useLiveQuery`. |
| `@tanstack/react-query` | ^5.104.0 | bump from ^5.101.4 | |
| `@tanstack/react-query-devtools` | 5.104.0 | add | `ReactQueryDevtoolsPanel`. |
| `@tanstack/react-store` | ^0.11.2 | bump | Shell UI slices. |
| `@tanstack/react-devtools` | 0.10.13 | add | Cockpit shell (`TanStackDevtools`, plugin `{ name, render }`). |
| `@tanstack/react-hotkeys` | 0.12.1 | add | `useHotkey`, `HotkeysProvider`, `useHotkeyHint` (exports verified). |
| `@tanstack/react-hotkeys-devtools` | 0.9.1 | add | Cockpit plugin. |
| `@tanstack/react-pacer` | 0.24.0 | add | Debounced pane-width and prefs writes. |
| `@tanstack/react-pacer-devtools` | 0.9.0 | add | Cockpit plugin. |
| `@orpc/client`, `@orpc/contract`, `@orpc/server`, `@orpc/tanstack-query` | **1.15.4** exact | add (spec 00 A.9) | renderer-next imports `client`, `contract` (types), `tanstack-query`; `server` only in the memory transport used by tests. |
| `valibot` | ^1.5.0 | add (spec 00 A.9) | Search schemas, param parsing, prefs patches. |
| `motion` | ^13.4.6 | add | `motion/react` (F8). `framer-motion` stays for the old renderer. |
| `shadcn` | **4.21.0** exact | bump from ^4.19.0 | CLI whose source was verified (F3, F4); also provides `shadcn/tailwind.css`. Exact so `ui/` output is reproducible. |
| `@shadcn/react` | ^0.3.1 | bump | Registry chat parts depend on it (message-scroller, questionnaire). |
| `@base-ui/react` | ^1.8.0 | bump from ^1.7.0 (registry decides) | `shadcn add` sets the floor; old renderer's `ui/` tests must stay green on 1.8. |
| `lucide-react` | ^1.49.0 | bump from ^1.33.0 | Icon library the registry emits. |
| `@vitejs/plugin-react` | **6.1.1** exact (catalog `6.1.1`) | bump from 6.0.5 | Native `compiler` option (F1). Exact because the option is marked experimental and §3.3 depends on its config-merge behaviour. Optional peers `@rolldown/plugin-babel` and `babel-plugin-react-compiler` are **not** installed. |
| `oxc-transform-react` | **0.145.0** exact | add | The Rust React Compiler the `compiler` option loads (`import("oxc-transform-react")`). The peer range `^0.145.0` on a 0.x version means `>=0.145.0 <0.146.0`, so npm latest 0.152.0 is **outside** it; install 0.145.0 and bump both packages together when plugin-react widens the range. |
| `axe-core` | 4.13.0 | add | a11y smoke in jsdom and in the screenshot run. |
| `knip` | 6.38.0 | add (root) | Unused files/exports for renderer-next (§3.5). |

Not added now, listed so nobody adds them early: `temml` 0.13.5 (phase 2), `@tanstack/ai-react` 0.29.3 / `@tanstack/react-ai-devtools` 0.2.71 (phase 2), `@tanstack/react-virtual` (phase 2), `@tanstack/react-form` (already present, used from phase 3), `@shadcn/helpers` (phase 2).

Already present and used unchanged by renderer-next: `tailwindcss` / `@tailwindcss/vite` 4.3.3, `tw-animate-css` 1.4.0 (F5), `class-variance-authority`, `clsx`, `tailwind-merge`, `react-resizable-panels` (registry `resizable`), `@fontsource-variable/inter`, `@fontsource-variable/jetbrains-mono`, `i18next`/`react-i18next` (F9), `@testing-library/react`, `jsdom`.

### 3.2 Remove

**Nothing is removed in phase 1**: the old renderer still imports `zustand`, `framer-motion`, `react-tourlight`, `@tsparticles/*`, `uuid`, `@dicebear/*`, `@monaco-editor/react`, `monaco-editor`, `katex`, `@lobehub/icons-static-svg`, `sonner`. They are banned *inside* renderer-next by lint (§3.4) and removed at cut-over (phase 7), when knip confirms no consumers. The `@aceternity` registry entry is dropped from `components.json` now (§5.1); the old renderer has no code that re-runs the CLI.

### 3.3 Build configuration

**Second Vite input.** `vite.config.ts` gains:

```ts
build: {
  outDir: "dist/renderer",
  sourcemap,
  rolldownOptions: {
    input: { main: resolve(root, "index.html"), next: resolve(root, "index-next.html") },
  },
},
```

`apps/desktop/index-next.html` is a copy of `index.html` with the same CSP `<meta>` (verbatim; `renderer-csp.ts:1-3` says to keep them in sync, and the header only covers `app://`), `<meta name="color-scheme" content="light dark">`, `<html data-titlebar="overlay-pending">`, and `<script type="module" src="/src/renderer-next/main.tsx">`. Both HTML files land at the root of `dist/renderer`, so the experience bundle (`scripts/build-experience.js:21,33`) carries both without change.

**Plugins, in order** (order matters: the router plugin must run before the React transform):

```ts
import { tanstackRouter } from "@tanstack/router-plugin/vite";
import react from "@vitejs/plugin-react";

// vite.shared.ts (included by tsconfig.vite.json, imported by vite.config.ts and vitest.config.ts)
export const NEXT_SRC = /[\\/]src[\\/]renderer-next[\\/]/;                           // whole tree (exclusions)
export const NEXT_MODULES = /[\\/]src[\\/]renderer-next[\\/].*\.[cm]?[jt]sx?$/;        // JS/TS modules only (compiler)
export const NODE_MODULES = /[\\/]node_modules[\\/]/;

plugins: [
  devServerHandle,
  tanstackRouter({
    target: "react",
    routesDirectory: "./src/renderer-next/routes",
    generatedRouteTree: "./src/renderer-next/routeTree.gen.ts",
    routeFileIgnorePrefix: "-",
    autoCodeSplitting: true,
    quoteStyle: "double",
  }),
  tailwindcss(),
  // Order matters: the compiler instance first, the plain instance second.
  react({ include: NEXT_MODULES, compiler: { logDiagnostics: true } }),  // renderer-next JS/TS: React Compiler (oxc) + its own Fast Refresh
  react({ exclude: [NODE_MODULES, NEXT_SRC] }),                        // old renderer: unchanged transform + Fast Refresh
  ...electron(/* unchanged */),
]
```

**Why two instances, in this order** (verified 30 Sep 2026 in a scratch project: `vite@8.2.1`, `@vitejs/plugin-react@6.1.1`, `oxc-transform-react@0.145.0`, `react@19.3.0`, one file under `src/next/` and one under `src/old/`, checked with `server.transformRequest` for `react/compiler-runtime` and `$RefreshReg$`, and with `build()` for memo cache code):

| Configuration | old: compiled | old: Fast Refresh | next: compiled | next: Fast Refresh |
|---|---|---|---|---|
| `react()` only | no | yes | no | yes |
| **`react({ include: NEXT, compiler: true })`, then `react({ exclude: [node_modules, NEXT] })`** | **no** | **yes** | **yes** | **yes** |
| same two, reversed order | no | **no** | yes | yes |
| compiler instance with the directory-only `include: NEXT_SRC` | no | yes | yes | yes, but **`src/next/s.css` fails with "Unexpected token"** (the compiler plugin receives CSS; Codex r1 #1) |
| **compiler instance with `include: NEXT_MODULES`** (the spec) | no | yes | yes (also `B.jsx?tsr-split=component`) | yes; CSS passes through untouched |
| single `react({ include: NEXT, compiler: true })` | no | **no** | yes | yes |

A directory-only `include` replaces the plugin's default `/\.[tj]sx?$/` (`@vitejs/plugin-react@6.1.1 dist/index.js:57-61`), so the compiler instance must carry the extension itself; ids with a query (router split modules `?tsr-split=…`) still match because the plugin wraps filters with `makeIdFiltersToMatchWithQuery`. Each instance's `config` hook sets `oxc.jsx.refresh` (`!opts.compiler`) and `jsxRefreshInclude/Exclude`; Vite merges plugin configs in order, so the plain instance must come last for `refresh: true` to win, and its `exclude` keeps renderer-next files out of oxc's refresh pass (the compiler instance's transform, `enforce: "pre"`, already emitted JSX-free code with refresh registration for them). Both instances inject the refresh preamble into HTML (the preamble appears twice, measured); it is idempotent, and the acceptance list checks that an edit hot-reloads in both renderers.

- `autoCodeSplitting: true` splits each route's `component`/`pendingComponent`/`errorComponent`/`notFoundComponent` into lazy chunks; loaders and `beforeLoad` stay in the main chunk. Chunks load from `file://` and `app://` like today's locale chunks (`i18n.ts:15-26`).
- `routeTree.gen.ts` is committed (TanStack's recommendation; it is also what the type-checker and the route-tree snapshot test read) and ignored by oxfmt/oxlint (§3.4).
- **Aliases:** add `"#next": resolve(root, "src/renderer-next")` and `"#locales": resolve(root, "src/renderer/locales")` to `resolve.alias` (and to `vitest.config.ts`'s `alias`), and to `package.json` `imports`:

```json
"#next/*": ["./src/renderer-next/*.tsx", "./src/renderer-next/*.ts", "./src/renderer-next/*/index.tsx", "./src/renderer-next/*/index.ts", "./src/renderer-next/*"],
"#locales/*": ["./src/renderer/locales/*"]
```

  `#locales/*` is the only sanctioned path from renderer-next into the old tree (§9). The shadcn CLI resolves `#next/ui` etc. from these `imports` entries (F3).
- **React Compiler config:** `compiler: { logDiagnostics: true }`, otherwise defaults (`compilationMode: "infer"`, target React 19 → `react/compiler-runtime`, which the plugin pre-bundles via `optimizeDeps.include`). Recoverable compiler diagnostics are printed as Vite warnings; fatal ones fail the transform (`dist/index.js`, `result.fatal` → `this.error`). Components the compiler skips are also caught by the oxlint compiler rules (§3.4). The compiler only runs for client environments (`consumer !== "server"`), which is every renderer module here.
- **Dev entry:** `vite` serves `/index-next.html` at the dev server root; main builds the URL (§3.6). New script `"dev:next": "ABACUSBOT_RENDERER_GENERATION=wco vite"` (the env override is dev-only, §3.6).

### 3.4 Keeping the two renderers apart (types, lint, knip)

**TypeScript.** New `tsconfig.renderer-next.json`, added to `tsconfig.json` `references`:

```json
{
  "extends": "@abacus-ai/config/typescript/react",
  "compilerOptions": {
    "types": ["vite/client"],
    "strict": true,
    "noUncheckedIndexedAccess": true,
    "noImplicitOverride": true,
    "composite": true,
    "tsBuildInfoFile": "../../node_modules/.tmp/desktop.renderer-next.tsbuildinfo"
  },
  "include": ["src/renderer-next", "src/shared"]
}
```

- No `"electron"` in `types` and no `src/preload/*.d.ts`: `window.api` does not exist for renderer-next at the type level. `src/renderer-next/env.d.ts` declares only `window.abacusHost?: { getPathForFile(file: File): string }` (spec 00 A.4.4) and `ImportMetaEnv.VITE_UI_GALLERY`.
- `tsconfig.renderer.json` is unchanged: its `include` of `src/renderer` does not match `src/renderer-next` (different directory name), so neither project sees the other's files.
- `src/shared` compiles under both; spec 00 already requires the contract to compile under strict.
- Locale JSON reached through `#locales/*` is typed by `resolveJsonModule` from the base config (the old renderer already imports JSON, `i18n.ts:5`).

**oxlint.** One new `overrides` entry for `apps/desktop/src/renderer-next/**/*.{ts,tsx}` in `oxlint.config.ts` (next to the existing renderer block at `:17-40`), plus one for the old tree:

| Rule | renderer-next | old renderer |
|---|---|---|
| `react/rules-of-hooks`, `react/jsx-key`, `react/no-children-prop` | error | error (unchanged) |
| React Compiler rules `react/set-state-in-effect`, `react/refs`, `react/purity`, `react/preserve-manual-memoization` | **error** (the compiler is on) | off (unchanged) |
| `react-hooks/exhaustive-deps` | error | warn (unchanged) |
| `no-restricted-imports` paths | `electron`, `framer-motion`, `zustand`, `sonner`, `react-tourlight`, `katex`, `monaco-editor`, `@monaco-editor/react`, `uuid`, `@lobehub/icons-static-svg`; `react` importNames `useMemo`, `useCallback`, `memo`, `forwardRef` (compiler + React 19) | `#next/*` |
| `no-restricted-imports` patterns | `#renderer/*`, `**/renderer/**` (except `#locales/*`), `@dicebear/*`, `@tsparticles/*`, `@radix-ui/*`, `@base-ui/react/*` | `**/renderer-next/**` |
| `no-restricted-syntax` | member `window.api`, `ipcRenderer` | — |

A narrower override for `src/renderer-next/ui/**` re-allows `@base-ui/react/*` (registry output is the only place Base UI is imported, PLAN L70) and turns off `react/preserve-manual-memoization` there (registry code may memoise; `ui/` is never edited). A third override for `src/renderer-next/routes/**` allows default exports only there (PLAN "no default exports except route files" — file routes export `Route`, so in practice this is a guard against adding `export default` elsewhere: `import/no-default-export` error outside `routes/`).

**Formatter/lint ignores.** Add `"**/routeTree.gen.ts"` to the shared ignore list in `packages/config/build-output-ignores.ts` (both oxlint and oxfmt import it). `src/renderer-next/ui/**` stays formatted (the CLI output is formatted by oxfmt after every `add`, so diffs stay reviewable) but is excluded from `check:i18n` (§9.4).

### 3.5 knip

Root `knip.json`, scoped to renderer-next only until cut-over (so the old tree never produces noise):

```json
{
  "workspaces": {
    "apps/desktop": {
      "entry": ["src/renderer-next/main.tsx", "src/renderer-next/routes/**/*.tsx", "src/renderer-next/**/*.test.{ts,tsx}"],
      "project": ["src/renderer-next/**/*.{ts,tsx}"],
      "ignore": ["src/renderer-next/routeTree.gen.ts", "src/renderer-next/ui/**"]
    }
  }
}
```

Script `"check:knip-next": "knip --workspace apps/desktop --include files,exports,types,duplicates"` (dependencies are excluded until the old renderer is gone, because knip would report every old-renderer-only package). Added to the root `check` pipeline.

### 3.6 Main process: choosing the entry

Two small main changes, both behind the existing generation switch (window-chrome spec §11 ships native chrome and renderer consumers together; that is exactly this switch):

1. `renderer-generation.ts` keeps `export const RENDERER_GENERATION` but computes it: `resolveRendererGeneration(process.env, app.isPackaged)` returns `"wco"` only when the constant default says so **or** when `ABACUSBOT_RENDERER_GENERATION=wco` is set and the app is **not packaged** (dev and screenshot runs). Packaged builds ignore the env var. Unit test in `main`.
2. `loadAppContent` (`index.ts:678-695`) and the swap target in `RendererHost` (`renderer-host.ts:201`) go through one helper `rendererEntry(base)`: entry file `index-next.html` when the generation is `"wco"`, else `index.html`; dev → `new URL(entry, VITE_DEV_SERVER_URL)`, experience → `new URL(entry, rendererUrl(version))`, packaged file → `join(import.meta.dirname, "../renderer", entry)`. Test: the three bases × two generations.

Also required from phase 0 (listed in §15): the contract gains `window.chrome` (query) and `window.events` `{ type: "chrome", chrome }` so renderer-next never calls `ipcMain.handle("window:chrome")` (which is not reachable without `window.api` anyway).

### 3.7 Vitest project `renderer-next`

Added to `vitest.config.ts` `projects`:

```ts
{
  plugins: [react({ include: NEXT_MODULES, compiler: true })],   // test what ships: compiled components
  resolve: { alias },                                   // alias gains #next and #locales
  test: {
    name: "renderer-next",
    environment: "jsdom",
    ...ciTimeouts,
    include: ["src/renderer-next/**/*.test.{ts,tsx}"],
    setupFiles: ["./src/renderer-next/test-support/setup.ts"],
  },
}
```

`vite.shared.ts` sits beside the two configs and is added to `tsconfig.vite.json`'s `include` (today exactly `["vite.config.ts", "vitest.config.ts"]`, `tsconfig.vite.json:10`), because that project is `composite` and every imported file must be listed (Codex r1 #22).

`test:unit` becomes `--project shared --project main --project renderer --project renderer-next`. `coverage.exclude` gains `src/renderer-next/routeTree.gen.ts` and `src/renderer-next/ui/**`. The new setup file copies the jsdom shims from `src/renderer/test-support/setup.ts:17-77` (it may not import from the old tree) but replaces the `matchMedia` stub with a **controllable** one (`setMediaMatches({ "(prefers-color-scheme: dark)": true, "(min-width: 1100px)": false, ... })`) and adds `document.startViewTransition` absence (jsdom has none; React skips view transitions gracefully) plus a stub `navigator.windowControlsOverlay` factory.

---

## 4. Folder shape

```
apps/desktop/index-next.html
apps/desktop/src/renderer-next/
├─ main.tsx                 boot: styles, theme pre-paint, i18n, router, createRoot (§8.6)
├─ env.d.ts
├─ router.tsx               createAppRouter(), RouterContext, routeMasks, Register, StaticDataRouteOption
├─ routeTree.gen.ts         generated, committed
├─ routes/                  §6 (composition + loaders only; never import another feature)
├─ ui/                      shadcn registry output, never edited (§5)
├─ components/              molecules used by ≥2 features
│  ├─ empty-state/          EmptyState = registry Empty + area glyph + i18n copy
│  ├─ nav-list/             NavList.* rows for every sidebar (registry Item/Button/Badge/Skeleton/Collapsible)
│  └─ app-icon/             duotone sprite (<svg><symbol>) + <AppIcon name/>
├─ features/
│  ├─ shell/                rail/ top-bar/ sidebar-slot/ side-panel/ breakpoints.ts occlusion.ts readiness.tsx
│  │                        shell-store.ts hotkeys.tsx command-menu.tsx layout.ts (pure)
│  ├─ bots/                 bots-sidebar.tsx, bots-strip.tsx (88px), bots-empty.tsx
│  ├─ sessions/             sessions-sidebar.tsx, sessions-empty.tsx
│  ├─ routines/             routines-sidebar.tsx
│  ├─ artifacts/            artifacts-sidebar.tsx (filters placeholder)
│  ├─ library/              library-sidebar.tsx (static nav)
│  ├─ settings/             settings-sidebar.tsx (static nav), appearance-theme.tsx (theme switch, the one real control)
│  ├─ onboarding/           onboarding-empty.tsx
│  └─ gallery/              the /__ui organism (§10)
├─ data/
│  ├─ transport/            spec 00 A.7, re-homed (F12)
│  ├─ collections/          ipcCollectionOptions + one file per table + index.ts (registry)
│  ├─ queries/              system.ts window.ts settings.ts invalidation.ts live.ts
│  └─ query-client.ts
├─ lib/
│  ├─ bootstrap.ts          transport + system.info + prefs before the router (§8.6)
│  ├─ cn.ts                 shadcn `utils` alias target
│  ├─ hooks/                shadcn `hooks` alias target (registry use-mobile lands here)
│  ├─ i18n/                 boot, languages, keys (§9)
│  ├─ motion.ts  sound.ts  theme.ts  platform.ts
│  ├─ window-chrome/        use-titlebar-area.ts, chrome-state.ts, overlay-slots.ts
│  └─ navigation/           use-app-navigate.ts, transition-types.ts, nav-type.ts
├─ styles/
│  ├─ app.css               Tailwind entry written by `shadcn init` (tokens live here)
│  └─ tokens.css            our layout tokens, title-bar vars, no-drag rule, VT CSS (§5.3, §6.7)
└─ test-support/            setup.ts, fake-table.ts, render-route.tsx, fixtures/home/ (seed data)
```

Rules (PLAN L205, restated as checks): routes never import another route or feature internals beyond the feature's `index.ts`; features import `components/`, `ui/`, `data/`, `lib/`, never each other (oxlint `no-restricted-imports` pattern `#next/features/*/!(index)` from other features, enforced per feature folder by a small script test in §11 because oxlint patterns cannot express "other feature"); `ui/` diffs are rejected in review and by `check:ui-registry` (§5.4).

---

## 5. shadcn: init, atoms, tokens

### 5.1 Init procedure (verified against the CLI source, F3/F4)

`shadcn init` never runs inside `apps/desktop` (F4, Codex r1 #3). It runs once in a throwaway package whose layout the CLI infers without help; this package then gets a hand-written `components.json`, and only `add` (which reads the existing config and infers nothing) touches it.

1. **Scratch init.** `scripts/shadcn-next-init.mjs` creates `<scratch>/shadcn-init/` from the CLI's own Vite template shape: `package.json` (`react`, `react-dom` 19.3.0, `tailwindcss`, `@tailwindcss/vite`, `vite` from the catalog), `tsconfig.json` with `compilerOptions.paths: { "@/*": ["./src/*"] }`, `vite.config.ts`, `src/index.css` containing `@import "tailwindcss";`. It runs `pnpm dlx shadcn@4.21.0 init --base base --preset mira --yes` there (no existing config, so no backup/force path; if the CLI still prompts, the script fails rather than answering blindly). Then it asserts, before copying anything: `components.json` has `style: "base-mira"`, `aliases.ui: "@/components/ui"`, `tailwind.css: "src/index.css"`; the only written files are `components.json`, `src/index.css`, `src/lib/utils.ts`, `package.json` (+ lockfile).
2. **Transplant** (the script, into this package): `src/index.css` → `src/renderer-next/styles/app.css`; `src/lib/utils.ts` → `src/renderer-next/lib/cn.ts`; the dependency names init added to the scratch `package.json` are printed and must already be in §3.1 (the script fails on anything new, e.g. hugeicons, which is not installed because the config says lucide).
3. **Hand-written `apps/desktop/components.json`** (kept as a constant in the script and written verbatim):

```json
{
  "$schema": "https://ui.shadcn.com/schema.json",
  "style": "base-mira",
  "rsc": false,
  "tsx": true,
  "tailwind": { "config": "", "css": "src/renderer-next/styles/app.css", "baseColor": "neutral", "cssVariables": true, "prefix": "" },
  "iconLibrary": "lucide",
  "rtl": false,
  "aliases": {
    "components": "#next/components",
    "utils": "#next/lib/cn",
    "ui": "#next/ui",
    "lib": "#next/lib",
    "hooks": "#next/lib/hooks"
  },
  "menuColor": "default-translucent",
  "menuAccent": "subtle",
  "registries": {}
}
```

   `#next/*` resolves through the `package.json` `imports` array; the CLI takes its first `./` target (`./src/renderer-next/*.tsx`) and strips the extension for directory aliases (`utils/get-config.ts:145-160`), which is exactly how today's `#renderer/components/ui` config resolves (`components.json:16-21`, `package.json:22-28`). `rtl: false` matches the preset: none of the 11 shipped locales is right-to-left (`i18n.ts:15-26`).
4. **Write gate for every `add`.** `scripts/shadcn-next.mjs add <items…>` first runs `shadcn add <items…> --dry-run` (`commands/add.ts:64`) and parses the planned file list; it aborts unless every path is under `src/renderer-next/{ui,lib,components}` and no dependency outside §3.1 is planned. Only then does it run the real `add` (against the pinned registry snapshot, §5.4). `pnpm exec shadcn info --json` must report `resolvedPaths.ui = src/renderer-next/ui`, `tailwindCss = src/renderer-next/styles/app.css`, `iconLibrary = lucide`; `git status src/renderer` stays clean.
5. **Post-edit `styles/app.css`** (ours, not registry-owned): first line `@import "tailwindcss" source(none);` plus `@source "../";`, so Tailwind scans only renderer-next; `@import "./tokens.css";` after the shadcn imports. Keep what init produced: `@import "tw-animate-css"`, `@import "shadcn/tailwind.css"`, `@import "@fontsource-variable/inter"`, `@custom-variant dark (&:is(.dark *))`, `@theme inline`, the `:root`/`.dark` neutral values, the `@layer base` block. The script re-checks these lines on every run.

### 5.2 Initial `add` list

One command (step 14 of §14), in this order so dependencies resolve once:

`button dialog alert-dialog sheet drawer tabs dropdown-menu context-menu popover tooltip hover-card combobox command resizable scroll-area kbd field label input input-group textarea item empty spinner skeleton separator badge avatar toggle toggle-group switch select native-select toast message-scroller message bubble attachment marker questionnaire collapsible`

Notes per item:
- `toast` replaces sonner (F6). `alert-dialog`, `hover-card`, `label`, `collapsible` are added beyond the brief's list because the overlay-slot list (§7.6) names their slots and the gallery must render them, and `field` depends on `label`.
- **`sidebar` is deliberately not added** (deviation from the brief's list, Codex r1 #8). Its `SidebarProvider` installs a window `keydown` listener for `b` + Ctrl/Meta that ignores Alt/Shift and editable targets (`refs/ui/apps/v4/registry/bases/base/ui/sidebar.tsx:96-109`), writes a cookie, and its `useIsMobile` (max-width 767 px) flips the layout under zoom (800 px window at 125% is 640 CSS px); `SidebarMenuButton` requires that provider. Sidebar rows are built from `item`, `button`, `badge`, `skeleton` and `collapsible` instead (§7.3); nothing in phase 1 needs the registry sidebar's own collapse logic, which the shell replaces.
- `resizable` wraps `react-resizable-panels` (already a dependency).
- `message-scroller`, `message`, `bubble`, `attachment`, `marker`, `questionnaire`: added now so the gallery and the a11y smoke cover them; not wired to chat until phase 2.
- With `sidebar` gone, no registry hook is installed; `lib/hooks/` exists only as the alias target.

### 5.3 Tokens

**Source of truth:** the neutral `:root` and `.dark` blocks written by init into `styles/app.css` (base-mira neutral: `--background`, `--foreground`, `--card`, `--popover`, `--primary`, `--secondary`, `--muted`, `--accent`, `--destructive`, `--border`, `--input`, `--ring`, `--chart-1..5`, `--sidebar*`, `--radius`). They are registry-owned in spirit: we do not hand-tune them. The old renderer's magenta primary (`assets/base.css:92,107`) is **not** carried over; the per-bot accent covers colour identity.

**Canvas surfaces → shadcn tokens (no parallel colour tokens).** The canvas uses its own dark values; they map by role, and the light theme follows automatically from the same roles:

| Canvas role (dark value) | Where on the canvas | shadcn token | Tailwind class |
|---|---|---|---|
| chrome `#1c1c1e` | window background, title bar, rail, pinned sidebar | `--sidebar` | `bg-sidebar text-sidebar-foreground` |
| panel `#131314` | content pane (inset `margin: 0 8px 8px`, radius 12), side panel | `--background` | `bg-background` |
| raised `#242427` | composer, active tab chip, bot bubble, drawer tab | `--muted` (surfaces), `--secondary` (buttons) | `bg-muted`, `variant="secondary"` |
| selected `#303034` | active rail item pill, active sidebar row | `--sidebar-accent` | `bg-sidebar-accent` |
| edge `#36363b` | floating sidebar border, dividers | `--sidebar-border` / `--border` | `border-sidebar-border` |
| text `#f2f2f3` / muted `#8e8e93` | primary and secondary text | `--foreground` / `--muted-foreground` | |
| menu `#242427` + shadow | popovers, menus | `--popover` with `menuColor: default-translucent` | registry-owned |
| scrim `rgba(0,0,0,.45)` + blur 2px | drawer at 1000 | registry `drawer-overlay` (registry default is `bg-black/80`, `style-mira.css:492-494`) | scoped override in `tokens.css` (§5.3), unlayered so it beats the utility |
| bot accent `#4ade80` etc. | user bubble, send button | `--bot-accent` (below) | `bg-(--bot-accent)` |

The ordering matches neutral dark (`--background` L 0.145 is darker than `--sidebar` L 0.205, and `--muted` L 0.269 is lighter), which is exactly the canvas's panel < chrome < raised. The screenshot comparison (§12) checks role and contrast, not hex equality.

**`styles/tokens.css`** (ours) holds only non-colour tokens, the title-bar contract and cross-cutting CSS:

```css
@theme inline {
  --breakpoint-shell-sm: 800px;   /* minimum band */
  --breakpoint-shell-md: 900px;
  --breakpoint-shell-lg: 1000px;
  --breakpoint-shell-xl: 1100px;
}
:root {
  color-scheme: light;
  /* window chrome contract, spec 00-window-chrome §6 */
  --titlebar-x: env(titlebar-area-x, 0px);
  --titlebar-end: calc(100vw - env(titlebar-area-x, 0px) - env(titlebar-area-width, 100vw));
  --toolbar-h: 40px;                         /* overwritten from window.chrome density */
  /* shell geometry (canvas) */
  --rail-w: 56px;
  --sidebar-w: 280px;
  --sidebar-strip-w: 88px;
  --side-panel-min: 360px;
  --side-panel-drawer-w: 356px;
  --pane-inset: 8px;
  --pane-radius: 12px;
  /* density (window chrome density drives --toolbar-h; row density follows) */
  --row-h: 32px;
  --bot-accent: var(--primary);
  --bot-accent-foreground: var(--primary-foreground);
}
.dark { color-scheme: dark; }
html[data-density="compact"] { --toolbar-h: 32px; --row-h: 28px; }
.titlebar-drag { app-region: drag; }
.titlebar-nodrag { app-region: no-drag; }
/* OVERLAY_SLOTS, generated list (lib/window-chrome/overlay-slots.ts); a test keeps them equal */
[data-slot="dialog-content"], [data-slot="alert-dialog-content"], /* … §7.6 … */ [data-slot="toast-viewport"] { app-region: no-drag; }
/* canvas scrim for the side-panel drawer only (Codex r1 #9): registry overlay is bg-black/80 + backdrop-blur-xs
   (style-mira.css:492-494); DrawerContent renders its overlay itself (drawer.tsx:99-111), so it is scoped by :has() */
[data-slot="drawer-portal"]:has([data-side-panel]) [data-slot="drawer-overlay"] { background-color: rgb(0 0 0 / .45); backdrop-filter: blur(2px); }
/* view transitions: §6.7 */
```

- **`.dark` class theming** only (shadcn is class-based, `@custom-variant dark`), plus `color-scheme` on `<html>` so native controls, scrollbars and form widgets follow.
- **Per-bot accent:** routes that show a bot set `style={{ "--bot-accent": row.avatarColor, "--bot-accent-foreground": accentForeground(row.avatarColor) }}` on the route's root element. `accentForeground` is a pure function in `lib/theme.ts` (OKLCH lightness ≥ 0.7 → `oklch(0.2 0 0)`, else `oklch(0.985 0 0)`), because `contrast-color()` is not relied upon. Phase 1 only renders it in the gallery and the bots sidebar dots.
- **Density:** `html[data-density]` comes from `window.chrome().density` (spec window-chrome §4); only `--toolbar-h` and `--row-h` react to it in phase 1. The registry's own spacing (mira is the dense style: `text-xs`, `p-2`) is not overridden.

### 5.4 Keeping `ui/` pristine

A CLI pin does not pin registry content (Codex r1 #17): the CLI fetches item JSON from `REGISTRY_URL`, default `https://ui.shadcn.com/r`, overridable by env (`packages/shadcn/src/registry/constants.ts:5-6`). So the registry content is snapshotted:

- `scripts/shadcn-registry-snapshot.mjs` starts a local recording proxy, runs the §5.2 `add` with `REGISTRY_URL=http://127.0.0.1:<port>/r`, and stores every fetched response under `apps/desktop/shadcn-registry/<YYYY-MM-DD>/…` with a `manifest.json` of `{ path, sha256 }` plus the CLI version. The snapshot is committed (a few hundred KB of JSON).
- Every `add` (§5.1 step 4) runs against that snapshot through the same local server in replay mode (offline, no upstream).
- `check:ui-registry` (CI, offline): copies the package to a temp dir, deletes `ui/`, replays the snapshot `add`, runs `oxfmt` with the repo config on the output, and diffs against the committed `ui/`. A diff fails. Upstream updates are a deliberate new snapshot directory in its own commit, reviewed as such.
- `ui/` is never edited; changes are wrappers in `components/`.

---

## 6. Routes

### 6.1 Files

Directory form under `src/renderer-next/routes/`. Group folders `(area)` are organisational only (they appear in route **ids**, not paths: `refs/router/packages/router-generator/tests/generator/route-groups/routeTree.snapshot.ts:28-71`). `/__ui` needs an escaped leading underscore: `[__ui].tsx` (supported, `tests/generator/physical-pathless-layout-escaped-underscore/routes/_layout/[__double].tsx` → path `/__double`).

| File | Path / id | Responsibility |
|---|---|---|
| `__root.tsx` | root | `createRootRouteWithContext<RouterContext>()`. **No async boot work here** (Codex r1 #5): transport, `system.info` and `prefs` are resolved by `bootstrap()` before the router exists (§8.6) and arrive as context. `component`: `<Providers>` (HotkeysProvider, Toaster, Tooltip provider, `<ThemeEffect/>`, `<ChromeEffect/>`, **`<ReadinessReporter/>`**, `<Outlet/>`, dev cockpit). `ReadinessReporter` (`features/shell/readiness.tsx`) runs for **every** entry route, shell or bare (Codex r1 #6): after the first commit it waits for `prefs`, `sessions`, `workspaces` to reach `ready` (spec 00 A.4.6 items 1, 2, 4; item 3 has no thread in phase 1) and calls `window.ready({ barrier: "subscriptions" })` once; if any of them `markError`s it calls `window.ready({ barrier: "failed", reason })`. `errorComponent`: generic error (details in dev). `notFoundComponent`: Empty "Not found" + link to `/bots/new`. |
| `_shell.tsx` | pathless `/_shell` | `validateSearch: ShellSearch`; `search.middlewares: [stripSearchParams(SHELL_DEFAULTS)]`; `loader`: `Promise.all([collections.sessions.preload(), collections.workspaces.preload()])` (both `startSync: true`, spec 00 B.3 step 10). Component: `<ShellLayout>` (§7). Readiness is not reported here (root does it). |
| `_shell/index.tsx` | `/` | `beforeLoad: () => { throw redirect({ to: "/bots/new", replace: true }) }`. |
| `_shell/(bots)/bots.tsx` | `/bots` layout | `staticData: { area: "bots", sidebar: "bots" }`; `loader`: `collections.bots.preload()`; component `<Outlet/>` wrapped by the pane transition (§6.7). |
| `_shell/(bots)/bots.index.tsx` | `/bots/` | redirect → `/bots/new`. |
| `_shell/(bots)/bots.new.tsx` | `/bots/new` | Empty "Make a bot" (canvas `BotsEmpty`/`BotNew` copy keys). |
| `_shell/(bots)/bots.$botId.tsx` | `/bots/$botId` | `params.parse: v.parser(BotIdParams)`; `validateSearch: BotSearch`; `loader`: bot from `collections.bots` (`notFound()` if missing after preload); sets `--bot-accent`; Empty "Chat arrives in phase 2"; `<Outlet/>` for the masked pop-ups. |
| `_shell/(bots)/bots.$botId.details.tsx` | `/bots/$botId/details` | Masked pop-up (registry `Sheet`, side right), empty body. Close/Escape = `router.history.back()`. |
| `_shell/(bots)/bots.$botId.edit.tsx` | `/bots/$botId/edit` | Full page placeholder (not masked; PLAN route tree). |
| `_shell/(sessions)/sessions.tsx` | `/sessions` layout | `staticData: { area: "sessions", sidebar: "sessions" }`; `search.middlewares: [retainSearchParams(["view"])]` (PLAN L173; `tab` is retained only within one session, see `SessionSearch`). |
| `_shell/(sessions)/sessions.index.tsx` | `/sessions/` | redirect → `/sessions/new`. |
| `_shell/(sessions)/sessions.new.tsx` | `/sessions/new` | `validateSearch: NewSessionSearch`; Empty "New session" (canvas `Main` copy). |
| `_shell/(sessions)/sessions.$sessionId.tsx` | `/sessions/$sessionId` | `validateSearch: SessionSearch`; `loaderDeps: ({ search }) => ({ view: search.view })`; loader: row from `collections.sessions` or `notFound()`; Empty. |
| `_shell/(sessions)/sessions.$sessionId.review.tsx` | `/sessions/$sessionId/review` | placeholder. |
| `_shell/(routines)/routines.tsx` | `/routines` layout | `staticData: { area: "routines", sidebar: "routines" }`; loader `collections.routines.preload()`; `<Outlet/>`. |
| `_shell/(routines)/routines._list.tsx` | pathless `/_shell/(routines)/routines/_list` | Renders the **routines page body** (phase 1: Empty "No routines yet", canvas `RoutineStates`) **and** an `<Outlet/>`, so a pop-up child renders over a background that stays mounted (Codex r1 #18: `index` and `new` are siblings, so the index would unmount). |
| `_shell/(routines)/routines._list.index.tsx` | `/routines/` | Renders `null` (the body is the parent's). |
| `_shell/(routines)/routines.$routineId.tsx` | `/routines/$routineId` | `validateSearch: RoutineSearch`; placeholder. |
| `_shell/(routines)/routines._list.new.tsx` | `/routines/new` | Masked sheet (registry `Sheet`) over the `_list` body; mask → `/routines` (§6.6). A masked reload keeps the sheet and its background (mask state lives in the history entry). |
| `_shell/(artifacts)/artifacts.tsx` | `/artifacts` layout | `staticData: { area: "artifacts", sidebar: "artifacts" }`. |
| `_shell/(artifacts)/artifacts.index.tsx` | `/artifacts/` | `validateSearch: ArtifactsSearch`; `loaderDeps` on it; `collections.artifacts.preload()`; Empty "Nothing made yet" (canvas `ArtifactsStates`). |
| `_shell/(library)/library.tsx` | `/library` layout | `staticData: { area: "library", sidebar: "library" }`. |
| `_shell/(library)/library.index.tsx` | `/library/` | redirect → `/library/connectors`. |
| `_shell/(library)/library.connectors.tsx` | `/library/connectors` | `validateSearch: ConnectorsSearch` (`connector?`); the sheet opens when `connector` is set; masked (below). |
| `_shell/(library)/library.messaging.tsx`, `library.mcp.tsx`, `library.skills.tsx` | | placeholders. |
| `_shell/(library)/library.tools.index.tsx`, `library.tools.$toolsetId.tsx` | `/library/tools`, `/library/tools/$toolsetId` | placeholders; `$toolsetId` parsed against `TOOLSETS_BY_ID` keys (`#shared/toolsets`). |
| `_shell/settings.tsx` | `/settings` layout | `staticData: { area: "settings", sidebar: "settings" }` (settings take over the sidebar, canvas `SettingsInPlace`). |
| `_shell/settings.index.tsx` | `/settings/` | redirect → `/settings/general`. |
| `_shell/settings.{general,appearance,notifications,memory,usage,account,models,environment,about}.tsx` | nine pages | Empty per page; `settings.appearance.tsx` renders the real theme control (light/dark/system writes `prefs.theme`), the only interactive setting in phase 1, because the theme gate needs it. |
| `_bare.tsx` | pathless `/_bare` | `loader`: nothing extra (readiness is root-owned, so a direct launch into `/onboarding/*` or `/__ui` still reports). No chrome: a `WindowDragRegion` strip of `height: var(--toolbar-h)` with `titlebar-drag`, padded by `--titlebar-x`/`--titlebar-end`, `z-10`; `<Outlet/>`. |
| `_bare/onboarding.index.tsx` | `/onboarding/` | redirect → `/onboarding/welcome`. |
| `_bare/onboarding.$step.tsx` | `/onboarding/$step` | `params.parse: v.parser(v.object({ step: v.picklist(ONBOARDING_STEPS) }))` with `ONBOARDING_STEPS = ["welcome","connect","connected","models","connectors","first-bot","done"]` (canvas page 11); Empty. |
| `_bare/[__ui].tsx` | `/__ui` | Gallery (§10). `beforeLoad`: `throw notFound()` unless `import.meta.env.DEV || import.meta.env.VITE_UI_GALLERY === "1"`. `validateSearch: GallerySearch`. |

Route files contain only `createFileRoute(...)` options and a thin component that composes feature exports (`<BotsSidebar/>` never appears in a route; the shell picks sidebars by `staticData`, §7.3).

### 6.2 Search schemas (valibot, next to each route; shared atoms in `lib/navigation/search.ts`)

Every field is `v.optional(v.fallback(schema, undefined))` or `v.optional(v.fallback(schema, default), default)` so a bad or stale URL never throws; `stripSearchParams(defaults)` keeps defaults out of the URL.

```ts
export const SidePanelTab = v.picklist(["changes","terminal","files","browser","memory","details","agent"]);
export const ShellSearch = v.object({
  tab: v.optional(v.fallback(SidePanelTab, undefined)),   // side panel open on this tab; absent = closed
});
export const BotSearch = v.object({
  tab: v.optional(v.fallback(v.picklist(["memory","files","browser","details"]), undefined)),
});
export const NewSessionSearch = v.object({ workspace: v.optional(v.fallback(WorkspaceId, undefined)) });
export const SessionSearch = v.object({
  view: v.optional(v.fallback(v.picklist(["split","full"]), "split"), "split"),
  tab: v.optional(v.fallback(v.picklist(["changes","terminal","files","browser"]), undefined)),
  agent: v.optional(v.fallback(v.string(), undefined)),
});
export const RoutineSearch = v.object({ run: v.optional(v.fallback(SessionId, undefined)) });
export const ArtifactsSearch = v.object({
  type: v.optional(v.fallback(v.picklist(["document","deck","image","code","other"]), undefined)),
  from: v.optional(v.fallback(v.picklist(["bots","sessions"]), undefined)),
  q: v.optional(v.fallback(v.pipe(v.string(), v.maxLength(200)), undefined)),
  item: v.optional(v.fallback(v.string(), undefined)),
});
export const ConnectorsSearch = v.object({ connector: v.optional(v.fallback(v.string(), undefined)) });
export const GallerySearch = v.object({
  section: v.optional(v.fallback(v.picklist(GALLERY_SECTIONS), undefined)),
  theme: v.optional(v.fallback(v.picklist(["app","light","dark"]), "app"), "app"),
});
```

`WorkspaceId`/`SessionId`/`BotId` are imported from `#shared/contract/ids` (spec 00 A.1) so URLs and procedure inputs share one id rule. Child routes that redeclare `tab` narrow it (a bot route cannot hold `tab=terminal`: the fallback drops it). `validateSearch` takes the valibot object directly (Standard Schema; `refs/router/docs/router/guide/search-params.md:286-309`).

### 6.3 `staticData` typing

```ts
// router.tsx
export type Area = "bots" | "sessions" | "routines" | "artifacts" | "library" | "settings";
export type SidebarId = Area;   // one sidebar per area in phase 1; the strip is a variant, not an id
declare module "@tanstack/react-router" {
  interface StaticDataRouteOption { area?: Area; sidebar?: SidebarId }
  interface Register { router: ReturnType<typeof createAppRouter> }
}
```

Limited to `{ area, sidebar }` (PLAN L176); `titleKey`/`backTo` are banned (PLAN L47). `useShellMatch()` reads the deepest match that defines each key (`useMatches({ select })`), so leaf routes inherit from their area layout. A test asserts every leaf under `_shell` resolves both.

### 6.4 Router context

```ts
export interface RouterContext {
  queryClient: QueryClient;
  transport: Transport;              // resolved by bootstrap() before the router is created (§8.6)
  system: SystemInfo;                // system.info, also seeded into the query cache
  collections: Collections;          // module singletons (data/collections/index.ts)
  t: TFunction;                      // i18next.getFixedT(null) — for loaders/notFound copy
}
```

Chat client factory joins the context in phase 2. `createAppRouter(boot)`:

```ts
createRouter({
  routeTree,
  history: createHashHistory(),
  context: { queryClient, transport: boot.transport, system: boot.system, collections, t: i18n.getFixedT(null) },
  routeMasks,
  defaultPreload: "intent",
  defaultPreloadStaleTime: 0,           // Query/DB own staleness (PLAN L174)
  defaultPendingMs: 150, defaultPendingMinMs: 200,
  scrollRestoration: true,
  defaultViewTransition: undefined,     // React owns view transitions (PLAN L23)
  defaultStructuralSharing: true,
})
```

`declare module "@tanstack/react-router" { interface HistoryState { navIntent?: { id: string; type: NavType } } }` types the intent carried in history state (§6.7).

### 6.5 Loaders

- `context.queryClient.ensureQueryData(opts)` for Query data (only `window.chrome` in `_shell` in phase 1; `system.info` is fetched by `bootstrap()`).
- `collection.preload()` for DB: `prefs` (`bootstrap()`, before the router, §8.6), `sessions` + `workspaces` (`_shell`), `bots` (`bots.tsx`), `routines` (`routines.tsx`), `artifacts` (`artifacts.index.tsx`). Loaders never read collection rows into loader data except to throw `notFound()`; components read with `useLiveQuery` so updates flow.
- `loaderDeps` only where the loader depends on search (`sessions.$sessionId`, `artifacts.index`).

### 6.6 Masks

`createRouteMask`'s `from` is a route **full path** (`RouteMask.from: RoutePaths<TRouteTree>`, `refs/router/packages/router-core/src/route.ts:1589-1596`), and masks are matched against the next location's **pathname** (`router-core/src/router.ts:2185-2195`, `findFlatMatch(next.pathname, …)`), where pathless layouts and groups never appear (Codex r1 #2). `router.tsx`:

```ts
export const routeMasks = [
  createRouteMask({ routeTree, from: "/bots/$botId/details", to: "/bots/$botId", params: (p) => p, search: (s) => s }),
  createRouteMask({ routeTree, from: "/routines/new", to: "/routines" }),
  createRouteMask({ routeTree, from: "/library/connectors", to: "/library/connectors",
                    search: ({ connector: _c, ...rest }) => rest }),
];
```

- Masking a route onto its own path while stripping `connector` is the documented "hide a search param" case (`refs/router/docs/router/guide/route-masking.md`, first list). Reload keeps the mask (default `unmaskOnReload: false`), which is what we want for a local app.
- Every pop-up closes with `router.history.back()` (Escape and the close button), per PLAN L175. A pop-up opened from a deep link with no history entry closes by navigating to the mask target instead (`router.history.canGoBack()` check).
- R1-T1 navigates to each masked route in a memory-history router and asserts `location.maskedLocation.pathname`, the rendered background, and the state after `router.history.back()`; a reload is simulated by re-creating the router from the same history.

### 6.7 Navigation and view transitions

**Intent travels with the navigation (Codex r1 #7).** `useAppNavigate()` (`lib/navigation/use-app-navigate.ts`) returns `(opts: NavigateOptions & { transition?: NavType | "none" }) => Promise<void>`. When `transition` is given it calls `router.navigate({ ...opts, state: (prev) => ({ ...prev, navIntent: { id: crypto.randomUUID(), type: opts.transition } }) })`; the intent is part of **that history entry**, so a cancelled, blocked or superseded navigation simply never commits it, and two rapid navigations cannot overwrite each other's intent (there is no module-global slot). `<AppLink>` (a `createLink` wrapper) does the same from a `transition` prop.

**The seam (F7).** `installTransitionTypes(router)` (`lib/navigation/transition-types.ts`) runs once before `<RouterProvider>` mounts:

```ts
let inner: StartTransitionFn = router.startTransition;
let lastCommittedKey: string | undefined;
Object.defineProperty(router, "startTransition", {
  configurable: true,
  get: () => (fn, expected) => {
    const isCommit = expected.every((m) => m.status !== "pending");            // offerPending passes one "pending" match (load-client.ts:1524-1530)
    const loc = router.latestLocation;                                          // the location being committed
    const key = loc.state.__TSR_key;
    const types = isCommit && key !== lastCommittedKey ? navTypesFor(router, loc) : [];
    if (isCommit) lastCommittedKey = key;                                       // once per history entry, not on invalidate/reload commits
    return inner(() => { for (const t of types) addTransitionType(t); fn(); }, expected);   // inside React.startTransition
  },
  set: (next) => { inner = next },                                            // Transitioner reassigns on every render (Transitioner.tsx:31)
});
```

A superseded navigation returns before calling `commit` (`load-client.ts:1863-1869`), so it never reaches the seam with its location.

**`navTypesFor(router, next)`** (pure core `inferNavType(from, to, direction)`, tested as a table):

1. **History direction first.** Compare `next.state.__TSR_index` with the resolved location's index (`@tanstack/history`, `stateIndexKey = "__TSR_index"`, `refs/router/packages/history/src/index.ts:60,97`): a lower index is a back traversal → `nav-back`, whatever intent the entry carries; a higher index on an entry whose key was committed before is a forward traversal → the entry's own `navIntent` if present, else inference.
2. **Explicit intent** (`next.state.navIntent.type`) for new entries.
3. **Semantic inference** from the route relationship table `ROUTE_RANK` in `lib/navigation/nav-type.ts` (not path prefixes, Codex r1 #20): per area, rank 0 = area root/list/new (`/bots/new`, `/sessions/new`, `/routines`, `/artifacts`, library and settings pages), rank 1 = entity (`/bots/$botId`, `/sessions/$sessionId`, `/routines/$routineId`, `/library/tools/$toolsetId`), rank 2 = sub-page (`/sessions/$sessionId/review`, `/bots/$botId/edit`). Different area → `nav-lateral`; into/out of `settings` → `settings-in`/`settings-out`; same area, higher rank → `nav-forward`, lower → `nav-back`, equal rank (sibling entities, settings page to settings page) → `nav-lateral`; search-only change or a masked pop-up opening/closing → none. So `/bots/new` → `/bots/<id>` (a creation) is `nav-forward` by rank, and callers may still pass `transition` explicitly.

**Type names** (exported as `NavType` from `lib/motion.ts`): `nav-lateral`, `nav-forward`, `nav-back`, `settings-in`, `settings-out`. Shared-element names reserved for later phases: `bot-identity-${botId}` (transcript → title bar, 420 ms), `welcome-parade`.

**Where `<ViewTransition>` sits.** Two boundaries in `ShellLayout`, both persistent parents with a keyed VT inside, placed before any DOM node of the swapped subtree:

```tsx
<main className="pane"><ViewTransition key={leafKey} enter="pane" exit="pane" default="none"><Outlet/></ViewTransition></main>
<aside className="sidebar-slot"><ViewTransition key={sidebarId} enter="sidebar" exit="sidebar" default="none"><Sidebar/></ViewTransition></aside>
```

`leafKey` = leaf route id + params (search changes do not re-key). `default="none"` keeps Suspense reveals and background updates from cross-fading (skill guidance).

**CSS** (in `tokens.css`), keyed on the active type:

```css
::view-transition-group(*) { animation-timing-function: cubic-bezier(.2,.8,.2,1); }
html:active-view-transition-type(nav-lateral)::view-transition-old(.pane),
html:active-view-transition-type(nav-lateral)::view-transition-old(.sidebar) { animation: 200ms vt-fade-out both; }
html:active-view-transition-type(nav-lateral)::view-transition-new(.pane),
html:active-view-transition-type(nav-lateral)::view-transition-new(.sidebar) { animation: 200ms vt-fade-in both; }
html:active-view-transition-type(nav-forward)::view-transition-old(.pane) { animation: 200ms vt-slide-out-start both; }  /* −12px + fade */
html:active-view-transition-type(nav-forward)::view-transition-new(.pane) { animation: 200ms vt-slide-in-end both; }    /* +12px → 0 */
html:active-view-transition-type(nav-back)::view-transition-old(.pane)    { animation: 200ms vt-slide-out-end both; }
html:active-view-transition-type(nav-back)::view-transition-new(.pane)    { animation: 200ms vt-slide-in-start both; }
html:active-view-transition-type(settings-in)::view-transition-new(.sidebar),
html:active-view-transition-type(settings-out)::view-transition-new(.sidebar) { animation: 200ms vt-fade-in both; }
@media (prefers-reduced-motion: reduce) { ::view-transition-group(*), ::view-transition-old(*), ::view-transition-new(*) { animation-duration: 120ms !important; animation-name: vt-fade-in !important; } }
html[data-reduce-motion="on"] ::view-transition-old(*), html[data-reduce-motion="on"] ::view-transition-new(*) { animation: 120ms vt-fade-in both !important; }
```

Values are PLAN's motion table (cross-fade 200 ms, drill-in slide 12 px) and live once in `lib/motion.ts` as numbers; the CSS mirrors them and a test compares the two. Directional slides use physical `translate` (no RTL locale ships).

---

## 7. Shell components (`features/shell/`)

Composition over flags (vercel-composition-patterns): `TopBar` and `SidePanel` are compound components with slots, not boolean-prop components; shared state lives in a provider/store, not in props drilled through the layout.

### 7.1 Layout and width bands

`layout.ts` (pure, fully unit-tested) turns `(width, area, prefs.sidebar.pinned, search.tab)` into a `ShellLayoutState`:

| Band | Width | Sidebar | Side panel (`tab` set) | Title bar |
|---|---|---|---|---|
| `xl` | ≥1100 | pinned per prefs (in layout, 280) | in layout, resizable, min 360 | identity + status text; actions; panel tabs |
| `lg` | 1000–1099 | pinned per prefs | **drawer**: 356 wide over a 45% scrim (+ blur 2px), chat keeps its width; Escape or scrim closes (clears `tab`) | as `xl` |
| `md` | 900–999 | pinned per prefs | drawer | status text hidden (avatar, name, dot stay) |
| `sm` | 800–899 (minimum) | **bots:** 88px avatar strip (name on hover, unread dot, working face); **sessions:** unpinned (floats on hover), prefs untouched; others: pinned per prefs | drawer | actions fold into ⋯ (registry `DropdownMenu`); details and panel open as sheets |

Values are from canvas `WidthRules` and `BW1000/BW900/BW800/W900/W800`. `effectivePinned` never writes prefs: growing the window restores the user's choice. `useShellWidth()` (`breakpoints.ts`) is `useSyncExternalStore` over three `matchMedia("(min-width: …px)")` queries, so it is exact at the boundaries and testable with the controllable stub; `ShellLayout` mirrors the band to `html[data-band]` (read by the screenshot script and tests); CSS uses the `shell-*` breakpoints for purely visual differences.

`ShellLayout` markup (widths and paddings from the canvas):

```
<div data-slot="shell" class="bg-sidebar text-sidebar-foreground h-dvh grid grid-rows-[var(--toolbar-h)_1fr]">
  <TopBar.Root> …slots… </TopBar.Root>
  <div class="flex min-h-0">
    <Rail/>                                          56
    <SidebarSlot/>                                   280 | 88 | 0 (floating)
    <main class="pane bg-background rounded-(--pane-radius) m-[0_var(--pane-inset)_var(--pane-inset)_0] …">
    <SidePanel/>                                     in layout (xl) | drawer (lg, md, sm)
  </div>
</div>
```

### 7.2 Rail

- Items (top): Bots, Sessions, Routines, Artifacts, Library (F11); bottom: Settings, Account (initials avatar, registry `Avatar`). Each top item is a 48×48 button with a 36×30 pill (radius 10) behind a 20px duotone icon and a 10px label; active pill `bg-sidebar-accent`, active text `text-sidebar-foreground`, idle `text-muted-foreground` (canvas `Rail.dc.html`).
- Icons: `components/app-icon/sprite.tsx` renders one hidden `<svg>` with `<symbol id="icon-bots">` etc. The paths are copied verbatim from the canvas board's `items` (fill path at `opacity .22` + stroke path, `stroke-width 1.6`); Library uses the canvas "Connectors" glyph, Settings the canvas gear. `<AppIcon name="bots" />` uses `<use href="#icon-bots"/>`. Lucide stays the icon set for everything else.
- Each item is an `<AppLink to=… transition="nav-lateral">` to the area's last visited location (kept in `shellStore.lastLocationByArea`, ephemeral) or its index.
- Hovering the rail while the sidebar is not pinned opens the floating sidebar (§7.3) after 120 ms hover intent; `aria-current="page"` on the active item; the rail is a `<nav aria-label={t("shell.rail.label")}>`.
- A "Needs you" group above the sidebar sections (PLAN L248) is phase 3 (it needs AG-UI state); the slot exists and renders nothing.

### 7.3 SidebarSlot

- Chooses the sidebar by `useShellMatch().sidebar` from a static map `{ bots: BotsSidebar, sessions: SessionsSidebar, routines: RoutinesSidebar, artifacts: ArtifactsSidebar, library: LibrarySidebar, settings: SettingsSidebar }` (features export them; the map lives in `features/shell/sidebars.ts`, the one place allowed to import several features' public sidebar exports).
- **Pinned:** in layout, 280 wide, `bg-sidebar`, no border (canvas). **Floating:** absolutely positioned at `left: calc(var(--rail-w) + 4px); top: calc(var(--toolbar-h) + 4px)`, 280×(100% − 8), radius 12, 1px `border-sidebar-border`, shadow `0 24px 64px rgb(0 0 0 / .6)` in dark (lighter in light), over the content, which never reflows (canvas `HoverSidebar`). Open on rail hover-intent; close on pointer leave (300 ms grace), Escape, or navigation. Enter/exit is `motion/react` `AnimatePresence` with the shared spring `springs.sidebar = { type: "spring", stiffness: 500, damping: 40 }` (PLAN motion table), `x: -8 → 0` + opacity; reduced motion → cut.
- **Pinned ↔ unpinned** animates the column width with `motion` `layout` on the slot (spring 500/40); the pane follows via the same layout animation. No reflow of the pane's content while floating.
- **Row atoms (no registry `sidebar`, §5.2).** A sidebar is `components/nav-list/` (a molecule shared by all six sidebars): `NavList.Root` (`<nav>` with `aria-label`), `NavList.Group` (label + optional `Collapsible` for workspace groups), `NavList.Item` (registry `Item` rendered as an `<AppLink>` via its `render` prop, `data-active`, `aria-current="page"`), `NavList.Action` (icon `Button` revealed on hover/focus), `NavList.Badge` (registry `Badge`), `NavList.Skeleton` (registry `Skeleton` rows). Height `var(--row-h)`, active row `bg-sidebar-accent`. Pinned state is owned by prefs and toggled only by the app's own shortcut handler (§7.9) and the title-bar toggle.
- **Live sidebars (phase 1 data):**
  - `BotsSidebar`: `useLiveQuery(q => q.from({ b: collections.bots }).orderBy(({ b }) => b.updatedAt, "desc"))`, pinned bots (`prefs.pinned.botIds`) first. Row = colour dot (`avatarColor`) standing in for BotAvatar + name + `title` + relative time from `updatedAt`. Header "Bots" + New (→ `/bots/new`). Strip variant (`sm`, `bots-strip.tsx`): 56×56 tiles with the dot, `title` attribute = name, New button on top (canvas `BW800`). Empty: registry `Empty` with "No bots yet" + "Make a bot".
  - `SessionsSidebar`: sessions where `!botOwned && editorFor == null && routineId == null`, joined to `workspaces` (excluding `kind === "routine" | "bot"`), grouped by workspace (label), pinned group from `prefs.pinned.sessionIds`, sorted by `updatedAt` desc; expanded state from `prefs.workspaceExpanded`. Row shows `label` and a status dot from `turn?.isBusy`. Header "Sessions" + New (→ `/sessions/new`).
  - `RoutinesSidebar`: names and `enabled` state from `collections.routines`; stats and auto-replies are phase 5.
  - `ArtifactsSidebar`: static type/source filter list writing `ArtifactsSearch` (no data).
  - `LibrarySidebar`, `SettingsSidebar`: static nav lists (canvas `SettingsInPlace` groups: Personal — General, Appearance, Notifications, Memory, Usage, Account; Capabilities → Library; Models, Environment, About).
  - Loading: `NavList.Skeleton` × 6 while the collection `status !== "ready"`; error: inline "Couldn't load" + Retry (`collection.utils.resync()`).

### 7.4 TopBar

Height `var(--toolbar-h)`, `titlebar-drag`, `padding-left: var(--titlebar-x)`, `padding-right: var(--titlebar-end)`; every interactive child `titlebar-nodrag` (window-chrome §6 rules 1–3). No platform branches in layout code (`--titlebar-x` is the traffic-light cluster on macOS; `--titlebar-end` the caption buttons on Windows and on Linux-with-buttons).

Compound API:

```tsx
<TopBar.Root>
  <TopBar.Leading>          {/* back, forward, sidebar toggle; app name when pinned */}
  <TopBar.Identity>         {/* route-provided: bot identity or breadcrumb (portal target) */}
  <TopBar.Actions>          {/* route-provided actions; fold into ⋯ at sm */}
  <TopBar.PanelTabs>        {/* only when search.tab is set */}
  <TopBar.PanelToggle/>
</TopBar.Root>
```

- **Leading segment width:** when the sidebar is effectively pinned, `Leading` spans `calc(var(--rail-w) + var(--sidebar-w))` so `Identity` starts over the content pane (canvas: app name block 182 px after three 28 px buttons on a 1280 board). The app name ("AbacusAI Bot", i18n `shell.appName`) shows only when pinned and truncates first if `--titlebar-x` is wide. When not pinned, `Leading` is content-sized with a 10 px gap (canvas `TopBar` `gap` prop).
- **Identity / Actions** are filled by routes through a portal slot (`TopBar.Identity` renders a `<div id>`; routes use `<TopBarSlot name="identity">` which `createPortal`s into it). This keeps TopBar free of area knowledge. Phase 1: bots routes show a colour dot + bot name; sessions show the session label; other areas show the area title.
- **Status text** (`md` and below hide it) is a child with `data-slot="topbar-status"` and a `shell-lg:` visibility class.
- **PanelTabs** render registry `Tabs` (`TabsList` with the area's tab set) bound to `search.tab`; `PanelToggle` opens/closes the panel (`tab` ⇄ undefined) with `aria-expanded`.
- **Back/Forward:** `router.history.back()/forward()` with `canGoBack()`; disabled state from `useCanGoBack()`.
- **Capability state:** `data-titlebar` on `<html>` from `window.chrome().mode` (`overlay`, `overlay-pending`, `native-frame`, `overlay-unavailable`; window-chrome §6 "Capability state"). In `native-frame` the reservations are 0 through the env fallbacks and the bar sits below the system title bar (canvas `TitleLinux`); in dev, `overlay-unavailable` shows a registry `Badge` "Title bar geometry missing" in the bar (release-blocking per that spec).
- `useTitlebarArea()` (`lib/window-chrome/use-titlebar-area.ts`) is the spec's JS hook (`navigator.windowControlsOverlay.getTitlebarAreaRect()` + `geometrychange`, fallback `{x:0,end:0,height:toolbarHeight,overlayVisible:false}`), used only by the toast viewport offset (`toolbarHeight + 10`) and the floating sidebar's top.

### 7.5 SidePanel

- Compound: `SidePanel.Root` (reads layout band + `search.tab`), `SidePanel.Content tab="…"` children supplied by the area route (phase 1: an `Empty` per tab).
- `xl`: registry `ResizablePanelGroup orientation="horizontal"` (the registry wrapper forwards `react-resizable-panels` v4 props; v4 names the prop `orientation`, `node_modules/react-resizable-panels/dist/react-resizable-panels.d.ts:138-140`) holding the pane and the panel. **Numbers are pixels in v4** (`d.ts:293-300`; strings without a unit are percentages), so the panel is `<ResizablePanel id="side-panel" minSize={360} defaultSize={prefs.panes["side-panel"] ?? 400}>` and the pane gets `minSize={480}` (Codex r1 #4). `onResize(size)` receives `{ asPercentage, inPixels }` (`d.ts:355,375-378`); `size.inPixels` is persisted, debounced 300 ms (react-pacer), to `prefs.panes["side-panel"]`.
- `lg`/`md`/`sm`: registry `Drawer` with `swipeDirection="right"`; `DrawerContent` gets `data-side-panel` and `className="[--drawer-content-width:var(--side-panel-drawer-w)] [--drawer-inset:var(--pane-inset)] rounded-(--pane-radius)"` (the registry popup reads `--drawer-content-width`/`--drawer-inset`, `refs/ui/apps/v4/registry/bases/base/ui/drawer.tsx:116-126`). `DrawerContent` renders its own overlay (`drawer.tsx:109-112`), whose registry style is an 80% scrim (`style-mira.css:492-494`); the canvas's 45% + 2 px blur comes from the scoped `:has([data-side-panel])` rule in `tokens.css` (§5.3, Codex r1 #9). Opening/closing sets/clears `tab`; `onOpenChange(false)` navigates with `transition: "none"`.
- Switching `xl` ⇄ `lg` while open animates with `motion` layout + presence (PLAN motion table: "side panel ↔ drawer at 1000px").
- Tabs live in the title bar (`TopBar.PanelTabs`), never inside the panel (canvas `BotChatPanel`, `SplitView`); the drawer at `lg` shows its own tab row (canvas `BW1000`) because the title bar region under a scrim is not interactive.
- Verified in the real app (acceptance): dragging the handle at a 1100 px window stops at 360 px panel / 480 px pane; the drawer's computed overlay `background-color` is `rgba(0, 0, 0, 0.45)` and `backdrop-filter` `blur(2px)`.

### 7.6 Native-surface occlusion watcher

`lib/window-chrome/overlay-slots.ts` keeps **three separate lists** (Codex r1 #23):

```ts
// 1. Portaled surfaces installed in phase 1 that can cover a native view or the title bar.
export const OCCLUDER_SLOTS = [
  "dialog-content", "dialog-overlay", "alert-dialog-content", "alert-dialog-overlay",
  "sheet-content", "sheet-overlay", "drawer-popup", "drawer-overlay",
  "popover-content", "dropdown-menu-content", "dropdown-menu-sub-content",
  "context-menu-content", "context-menu-sub-content",
  "select-content", "combobox-content", "hover-card-content", "tooltip-content",
  "toast",                                     // each visible toast root, not the viewport (Codex r1 #10)
] as const;                                    // CommandDialog renders dialog-content
// 2. Reserved: slots of registry overlays not installed yet (window-chrome §6 list); covered by CSS so adding them later is safe.
export const RESERVED_OCCLUDER_SLOTS = ["menubar-content", "menubar-sub-content", "navigation-menu-content"] as const;
// 3. Title-bar no-drag only: containers that never occlude by themselves but must not be drag regions.
export const NO_DRAG_ONLY_SLOTS = ["toast-viewport"] as const;
export const NO_DRAG_SELECTOR = [...OCCLUDER_SLOTS, ...RESERVED_OCCLUDER_SLOTS, ...NO_DRAG_ONLY_SLOTS].map((s) => `[data-slot="${s}"]`).join(",");
export const OCCLUDER_SELECTOR = [...OCCLUDER_SLOTS, ...RESERVED_OCCLUDER_SLOTS].map((s) => `[data-slot="${s}"]`).join(",");
```

- Explicit lists, never `[data-slot$="-content"]` (the registry has 40+ `*-content` slots such as `message-scroller-content`, `card-content`, `item-content`; grep of `refs/ui/apps/v4/registry/bases/base/ui`).
- **Toasts:** Base UI keeps `toast-viewport` mounted with no toasts (registry `Toaster` always renders `ToastViewport`, `toast.tsx:244-258`), and its box does not describe its absolutely positioned toasts (`toast.tsx:20-45`). So the watcher measures each `[data-slot="toast"]` root instead; an empty viewport publishes nothing.
- **Watcher** (`features/shell/occlusion.ts`): a `MutationObserver` on `document.body` (`childList`, `subtree`, attributes `data-open`, `data-starting-style`, `data-ending-style`, `style`, `hidden`, `class`) finds candidates. A candidate occludes from insertion until removal, including while `data-ending-style` is present. Its rectangle is ignored when empty (`width` or `height` 0) or not rendered (`checkVisibility({ opacityProperty: false, visibilityProperty: true })` false).
- **Geometry stays current** (Codex r1 #11): each candidate gets a `ResizeObserver`; `window` `resize` and capture-phase `scroll` invalidate all rects; while any candidate has `data-starting-style`/`data-ending-style` or `element.getAnimations({ subtree: true })` returns running animations, a `requestAnimationFrame` loop re-measures every frame and stops when they settle. Publishes are deduplicated (rounded rects) to `shellStore.occlusion = { any, rects }`.
- Phase 1 has no native surface to hide (browser view is phase 4); the gallery's `occlusion` section draws the published rects.
- `tokens.css` carries `NO_DRAG_SELECTOR` as the `app-region: no-drag` rule (§5.3); R1-T9 keeps the CSS and the constant equal.

### 7.7 Theme effect

`lib/theme.ts`:

- `resolveTheme(pref: "system"|"light"|"dark", systemDark: boolean): "light"|"dark"` (pure).
- `applyTheme(doc, resolved)`: `classList.toggle("dark", resolved === "dark")`, `style.colorScheme = resolved`.
- **Startup theme is decided in main, before the window exists** (Codex r1 #14). When the generation is `wco`, main reads `prefs.json` through `PrefsStore` (spec 00 B.2) before `new BaseWindow` and sets `nativeTheme.themeSource = prefs.theme`; the window's initial `backgroundColor` uses the resolved scheme (the window-chrome options module already takes `dark`, `window-chrome-options.ts`). Chromium derives `prefers-color-scheme` from `nativeTheme.themeSource`, so from the first frame the renderer's media query already equals the stored choice, not the OS one. `index-next.html` then needs no script: `app.css` sets `html { background: var(--background) }` under `@media (prefers-color-scheme: dark)` → dark tokens, and `main.tsx`'s first statement applies `resolveTheme("system", matchMedia(…).matches)`, which is the stored theme by construction. The window is revealed on `did-finish-load` as today, after that paint.
- `<ThemeEffect/>` (in `__root`): live prefs row + `matchMedia("(prefers-color-scheme: dark)")` changes → `applyTheme`; writes `html[data-reduce-motion]` from `prefs.motion.reduce`.
- **Changing the theme:** the renderer writes only `prefs.theme` (`updatePrefs`); main sets `nativeTheme.themeSource` as the prefs side effect (spec 00 B.2) and re-runs `applyWindowChrome` (window-chrome §5). No `window.api.setThemeSource` (old path `hooks/use-theme.ts:59-66`).
- `<ChromeEffect/>`: `useQuery(windowChromeQuery(transport.orpc))` + `window.events` (via `data/queries/live.ts`) → `html[data-titlebar]`, `html[data-density]`, `--toolbar-h`.
- Test: main unit test that `createWindow` sets `themeSource` from prefs before constructing the window (opposite stored/OS themes); R1-T7 renderer side; acceptance checks a launch with stored `dark` on a light OS (and the reverse) with a transport delayed by 2 s: no light frame is captured (CDP screencast from launch).

### 7.8 Motion and sound modules (shaped, mostly empty)

`lib/motion.ts`:

```ts
export const durations = { crossFade: 200, drill: 200, sharedElement: 420, layout: 240, childFade: 120, reduced: 120 } as const;
export const easings = { standard: [0.2, 0.8, 0.2, 1], notch: [0.22, 1, 0.36, 1] } as const;
export const springs = { sidebar: { type: "spring", stiffness: 500, damping: 40 }, panel: { type: "spring", stiffness: 500, damping: 40 } } as const;
export const offsets = { drill: 12 } as const;
export type NavType = "nav-lateral" | "nav-forward" | "nav-back" | "settings-in" | "settings-out";
export function useMotionPreference(): "full" | "reduced";   // prefs.motion.reduce ⊕ prefers-reduced-motion
export function motionFor<T>(pref, full: T, reduced: T): T;
```

Every `motion` usage takes its transition from here; `prefers-reduced-motion` collapses every entry to a 120 ms fade and every layout animation to a cut (PLAN L237).

`lib/sound.ts` (no audio in phase 1, API fixed so phase 3 only fills synthesis):

```ts
export type Cue = "sent" | "received" | "needs-you" | "done" | "failed" | "routine-fired";
export interface SoundContext { isThreadVisible(threadId: string): boolean; isWindowFocused(): boolean; prefs(): PrefsRow["sounds"]; now(): number }
export function createSoundPlayer(ctx: SoundContext): { play(cue: Cue, opts?: { threadId?: string }): void; unlock(): void; dispose(): void };
```

Rules implemented now (they are pure and testable): never when the causing thread is visible and the window focused; a burst within 400 ms coalesces to one cue; per-event switches from `prefs.sounds.perEvent`; `enabled` master switch. `play` ends in a no-op `synth(cue)` in phase 1. One `AudioContext` created lazily on `unlock()` (first pointerdown).

### 7.9 Keyboard

**One app-owned handler** (Codex r1 #8): `features/shell/hotkeys.tsx`, mounted once in `__root` under `HotkeysProvider` (`@tanstack/react-hotkeys`), is the only keyboard listener for app shortcuts; no registry atom installs a global one (the registry `sidebar` is not used, §5.2). Every binding is exact: `@tanstack/hotkeys` matches the modifier set of the binding, and letter keys fall back to `event.code`, so macOS Option+B (`∫`) still matches `Mod+Alt+B` (`@tanstack/hotkeys@0.10.1 dist/match.d.ts`). R1-T14 asserts `Mod+Alt+B` never fires the `Mod+B` handler and vice versa.

| Keys | Action | Editable targets |
|---|---|---|
| `Mod+K` | open the command menu (registry `CommandDialog`; areas, settings pages, bots and sessions from collections, "Toggle theme") | fires (`ignoreInputs: false`) |
| `Mod+N` | new in the current area: `/bots/new`, `/sessions/new`, `/routines/new` (masked sheet); elsewhere `/sessions/new` | fires |
| `Mod+B` | toggle `prefs.sidebar.pinned` | fires in `input`/`textarea`; **skipped inside `[contenteditable]` and `[data-hotkeys="text"]`** (rich-text bold) |
| `Mod+Alt+B` | toggle the side panel (`tab` ⇄ last tab for the area) | same as `Mod+B` |
| `Mod+,` | `/settings/general` with `transition: "settings-in"` | fires |
| `Escape` | closes the floating sidebar | registry overlays handle their own Escape; this one registers `{ enabled: floatingOpen }` |

The contenteditable guard is a small wrapper (`useAppHotkey`) that checks `event.target.closest('[contenteditable="true"],[data-hotkeys="text"]')` before calling the handler, because `ignoreInputs` is one boolean for all input-like targets (`hotkey-manager.d.ts:18-19`). `Mod` = ⌘ on macOS, Ctrl elsewhere, with the platform passed explicitly from `system.info.platform` (`HotkeyOptions.platform`). Labels come from `useHotkeyHint`.

### 7.10 Devtools cockpit

`lib/devtools.tsx`, imported only as `import.meta.env.DEV ? lazy(() => import("#next/lib/devtools")) : null` so production strips it:

```tsx
<TanStackDevtools plugins={[
  { name: "Router", render: <TanStackRouterDevtoolsPanel router={router} /> },
  { name: "Query", render: <ReactQueryDevtoolsPanel client={queryClient} /> },
  { name: "Collections", render: <CollectionsPanel collections={collections} /> },   // F10: status, rows, epoch, receivedSeq/appliedSeq, resync button
  { name: "Hotkeys", render: <HotkeysDevtoolsPanel /> },
  { name: "Pacer", render: <PacerDevtoolsPanel /> },
]} />
```

No `@tanstack/devtools-vite` event-bus server: it listens on another port, which the CSP `connect-src 'self'` (`renderer-csp.ts:4-7`) blocks; the in-page plugins need no bus. AI devtools join in phase 2.

---

## 8. Data layer

### 8.1 Transport

`data/transport/` exactly as spec 00 A.7 (types, `connectMessagePortTransport`, `createWebSocketTransport`, `createMemoryTransport`, `getTransport()` singleton stored on `globalThis[Symbol.for("abacus.transport")]` for HMR), with the path change F12. The client link: `new RPCLink({ port, customJsonSerializers: [uint8ArraySerializer] })` from `@orpc/client/message-port`, `port.start()`, `createORPCClient<AppClient>(link)`, `createTanstackQueryUtils(client)`. `getPathForFile` from `window.abacusHost` when present. `useTransport()` = `useRouteContext({ from: "__root__", select: (c) => c.transport })`.

### 8.2 Query client

`data/query-client.ts`:

```ts
new QueryClient({ defaultOptions: {
  queries: {
    networkMode: "always",              // local IPC: navigator.onLine must not pause queries
    staleTime: 30_000,
    refetchOnWindowFocus: false,        // main pushes invalidations (§8.4)
    retry: (n, e) => isDefinedError(e) && e.code === "UNAVAILABLE" && n < 3,   // spec 00 A.5
  },
  mutations: { networkMode: "always", retry: false },
}})
```

`isDefinedError` from `@orpc/client` narrows spec 00's `COMMON_ERRORS`.

### 8.3 Collections registry

`data/collections/ipc-collection-options.ts` is spec 00 B.3 verbatim (re-homed). One file per table: `prefs.ts`, `sessions.ts`, `workspaces.ts`, `bots.ts`, `routines.ts`, `routine-runs.ts`, `artifacts.ts`, `memories.ts`, `git-state.ts`, each:

```ts
export const botsCollection = createCollection(ipcCollectionOptions<BotRow, string>({
  id: "bots",
  table: async () => (await getTransport()).client.db.bots,
  getKey: (row) => row.id,
  toInsertInput: (row) => ({ ...row }),                          // client id passes through (spec 00 B.2)
  toUpdateInput: (id, changes) => ({ id, patch: changes }),
  toDeleteInput: (id) => ({ id }),
}));
```

`index.ts` exports `collections = { prefs, sessions, workspaces, bots, routines, routineRuns, artifacts, memories, gitState }` and `type Collections`. `startSync: true` for `prefs`, `sessions`, `workspaces` (spec 00 B.3 step 10); others are lazy (`preload()` from loaders). Row types come from `#shared/contract/rows`.

**Provenance and legacy sync are prerequisites** (Codex r1 #12). Phase 1 depends on spec 00 r2's `PrefsStore` behaviour, not only on the table: `update` marks touched fields `user`, the one-time import and the **live legacy sync** (`RendererStateStore.set` → `prefsStore.importLegacy`, spec 00 C.4 items 1–2) mark `legacy` and never overwrite `user` fields. The renderer never sees provenance. The foundation PR does not merge before spec 00 C's live sync (C-T5, C-T8) is green, and R1-T19 (main) switches generations repeatedly: legacy write → next sees it; next write → a later legacy write of the same field does not override it; legacy-only field changes keep flowing.

**Prefs helpers** (`prefs.ts`): `usePrefs()` (live query of the single `"app"` row, returns the row or `DEFAULT_PREFS` while loading), `updatePrefs(recipe)` → `prefsCollection.update("app", recipe)` (optimistic; resolves on the echoed seq; valibot `PrefsPatch` rejects unknown keys server-side). Pane widths and other high-frequency writes go through a pacer debouncer (300 ms) before `updatePrefs`.

### 8.4 Query-options modules (skeleton)

`data/queries/`:

- `system.ts`: `systemInfoQuery = (orpc) => orpc.system.info.queryOptions({ input: {}, staleTime: Infinity })`.
- `window.ts`: `windowChromeQuery = (orpc) => orpc.window.chrome.queryOptions({ input: {} })` (needs the §15 contract addition).
- `settings.ts`: placeholder exports for phase 5 (no calls).
- `invalidation.ts`: the `eventType → queryKey[]` table that replaces the old 393-line refresh map (PLAN L110). Phase 1 entries: `window.events` `chrome` → `windowChromeQuery` key; `settings.events` `credentials-changed` → `settings.keys.listProviders`, `account.*`, `models.list` (spec 00 L382). A `useInvalidationBridge()` in `__root` subscribes to the notice iterators it needs and calls `queryClient.invalidateQueries`.
- `live.ts`: the single wrapper around `experimental_liveOptions` / raw iterators for low-rate notices (spec 00 A.12), so the experimental API is referenced once.

### 8.5 TanStack Store slices (ephemeral shell UI)

`features/shell/shell-store.ts`:

```ts
export const shellStore = new Store({
  floating: { open: false, reason: null as null | "hover" | "peek" },
  commandOpen: false,
  lastLocationByArea: {} as Partial<Record<Area, string>>,
  occlusion: { any: false, rects: [] as DOMRectReadOnly[] },
});
```

Actions are plain functions (`openFloating`, `closeFloating`, `setOcclusion`, …) exported next to it; components read with `useStore(shellStore, selector)`. Nothing here is persisted (PLAN "no state in two places": pinned lives in prefs, tab in the URL).

### 8.6 Boot order (`main.tsx`)

Transport, system facts and prefs are resolved by **`bootstrap()` outside the router** (Codex r1 #5): route loading captures errors into error matches rather than rejecting `router.load()`, so boot must not depend on a rejection.

1. `import "./styles/app.css"` (which imports `tokens.css`).
2. `applyTheme(document, resolveTheme("system", matchMedia("(prefers-color-scheme: dark)").matches))` (the stored theme, §7.7).
3. Global error listeners (copy of `src/renderer/main.tsx:25-30`).
4. `await initI18n()` with `en-US` (static bundle; §9.2).
5. `const boot = await bootstrap()` (`lib/bootstrap.ts`), each step with its own timeout and typed failure:
   - `transport = await getTransport()` (spec 00 A.7, 5 s) → `TransportUnavailableError`;
   - `system = await queryClient.fetchQuery(systemInfoQuery(transport.orpc))` (3 s);
   - `await collections.prefs.preload()` raced against 5 s and `markError` → `PrefsUnavailableError`.
   On failure: render `<BootFailure reason />` (a static React tree: no router, no collections, Reload button) and, if a transport exists, call `transport.client.window.ready({ barrier: "failed", reason })`; without a transport main's swap timeout covers it (spec 00 A.4.6). Stop.
6. `applyTheme` from prefs (a no-op when main already applied it); `await changeLanguage(resolveLanguage(prefs.language))` (§9.2).
7. `const router = createAppRouter(boot); installTransitionTypes(router);` then `createRoot(#root, { onUncaughtError }).render(<QueryClientProvider client><RouterProvider router/></QueryClientProvider>)`.
8. **After boot:** a lost port (window reload aside) closes every iterator; collections keep their last rows and retry (spec 00 B.3 step 7), and a `transport.onClose` listener shows a registry `toast` "Reconnecting…" and, after 10 s, the root error component with Reload. R1-T18 covers: transport never answers, `system.info` rejects, prefs snapshot rejects, port closes during `prefs.preload()`, port closes after mount.

Not carried over from the old boot: `installLogCollector`, `installActivityBeacon`, `installUiContinuity` (`src/renderer/main.tsx:14-21`) — their replacements are contract procedures in later phases; the activity beacon is needed before renderer swaps can target renderer-next (listed in §13).

---

## 9. i18n

### 9.1 Shared locale files

renderer-next reads the **same** JSON files as the old renderer through the `#locales/*` alias (`import enUS from "#locales/en-US.json"`; lazy `import("#locales/de-DE.json")`), so translators keep one set of 11 files and `sync-locales` keeps working on one directory. The files do not move in phase 1 (moving them would edit the old renderer's `i18n.ts:5,16-25`).

### 9.2 Boot

`lib/i18n/index.ts` is a copy of the old module's logic without `durableStorage`: `LOADERS` for the 10 lazy locales, `matchSupportedLanguage` (copied with its tests from `i18n.ts:34-67` into `lib/i18n/languages.ts`; the old copy stays until cut-over), `initI18n()` with `en-US` only, `changeLanguage(code)` loads the bundle and sets `lang`/`dir`.

**Explicit "system" language** (Codex r1 #13): `PrefsRow.language` becomes `"system" | SupportedLanguage`, default `"system"` (spec 00 amendment, §15). `resolveLanguage(pref)` = `pref === "system" ? matchSupportedLanguage(navigator.languages) ?? "en-US" : pref`. So a user who picks English gets `"en-US"` stored and keeps it; an unset preference follows the OS. The legacy import (spec 00 C.4) maps `abacusai-bot-language` to the stored code when present and leaves `"system"` otherwise. Settings › General (phase 5) offers "System (…)" as the first option. `t` is on the router context as `i18n.getFixedT(null)`.

### 9.3 Key organisation (no deletions in phase 1)

- New keys are grouped by **area**, matching `Area` plus shared groups: `common.*`, `shell.*` (rail labels, title bar, sidebar toggle, command menu, app name, capability badge), `bots.*`, `sessions.*`, `routines.*`, `artifacts.*`, `library.*`, `settings.*`, `onboarding.*`, `gallery.*` (dev only, English only, excluded from sync), `errors.*`.
- Where an area object already exists (`bots`, `sessions`, `routines`, `artifacts`, `onboarding`), new keys are added **inside it** under sub-objects that do not exist yet (`bots.empty.*`, `bots.sidebar.*`, `sessions.empty.*`, …). A test asserts no new key path equals an existing leaf or turns an existing leaf into an object.
- Reorganisation of old keys is data, not edits: `scripts/locale-keymap.json` maps `newKey → oldKey` for every string the new renderer reuses. `sync-locales` gains `--apply-keymap`: when a `newKey` is missing in a locale, it copies that locale's `oldKey` translation, so reused strings arrive translated in all 11 locales. Old keys are deleted only at cut-over, when `check:i18n` and the keymap show no consumer.
- Phase 1 strings: rail/sidebar/title-bar labels, the nine settings page titles, empty-state title + description + action per route, capability badge, command-menu group names, error screens. Estimated ~90 keys, most mapped from existing ones (`sidebarNav.*`, `theme.*`, `common.*`).

### 9.4 Checks extended

- `check-jsx-i18n.js`: `SCAN_DIRS = ["src/renderer", "src/renderer-next"]`, excluding `src/renderer-next/ui/**` (registry output; its few sr-only English strings, e.g. dialog "Close", are passed translated labels at the call site where the atom accepts them, otherwise tracked in the risk list) and `features/gallery/**`.
- `sync-locales.js`: key-usage scan covers both source dirs (`SOURCE_DIR` becomes a list); `--apply-keymap` as above.
- Test (renderer-next): every route's `staticData.area` has `shell.rail.<area>`; every `_shell` leaf's empty state keys exist in `en-US.json`; every settings page title key exists.

---

## 10. `/__ui` gallery and screenshots

### 10.1 Gallery route

`_bare/[__ui].tsx` → `features/gallery/`. Enabled in dev and in builds made with `VITE_UI_GALLERY=1` (the screenshot build); otherwise `notFound()`.

- **One theme at a time, applied to the whole document** (Codex r1 #21): `GallerySearch.theme` is `"app" | "light" | "dark"` (default `"app"`, the app's own theme). A non-`app` value overrides `.dark`/`color-scheme` on `<html>` while the gallery is mounted (restored on unmount), so tokens, portals and overlays all render in the same theme without duplicating token blocks for a nested scope. Side-by-side comparison is the screenshot contact sheet's job (§10.2), not the page's.
- Sections (`GALLERY_SECTIONS`):
  - `tokens`: every colour token as a swatch with its value and contrast against its foreground; radius scale; `--toolbar-h`, shell geometry tokens.
  - One section per `ui/` file (all of §5.2): every exported part, every `variant` × `size`, and prop-driven states: disabled, `aria-invalid`, loading (`Spinner`), empty, long text/truncation. Overlays render **open** (`defaultOpen`/`open`) with their portal `container` set to a bounded frame so they stay inside the section; toasts are added with `toastManager.add` on mount.
  - `shell`: Rail × each active item; TopBar × {pinned, collapsed} × {no panel, panel open with tabs} × simulated chrome {mac-like `--titlebar-x: 70px`, windows-like `--titlebar-end: 138px`, native-frame, fullscreen: both 0} (canvas page 5 geometry, inline custom properties on the frame); SidebarSlot × {pinned, floating, strip, loading, empty, error}; SidePanel × {in layout, drawer}; EmptyState per area.
  - `occlusion`: a popover, a dialog and a toast over a fake "native surface" box, outlining `shellStore.occlusion.rects`.
  - `motion`: buttons that trigger each `NavType` between two dummy panes.
- Chat parts (`message-scroller`, `bubble`, …) render static sample content only; scripted fixtures are phase 2.

### 10.2 Screenshot script

`apps/desktop/scripts/screenshots-next.mjs` (node, no Playwright; the isolated-profile CDP recipe):

1. `VITE_UI_GALLERY=1 pnpm exec vite build`.
2. Seed a scratch home from `src/renderer-next/test-support/fixtures/home/` (bots.json with the five canvas bots and colours, local-code.json with the canvas sessions/workspaces, cronjobs.json with two routines, prefs.json with `theme: "system"`).
3. For each width `W` in `[1280, 1000, 900, 800]`: launch Electron (per-platform binary from `electron`'s `path.txt`) with `ABACUSAI_BOT_HOME`, `ABACUSAI_BOT_USERDATA=<scratch>/ud-W`, `ABACUSBOT_RENDERER_GENERATION=wco`, `ABACUSBOT_DEV_CONTENT_SIZE=Wx800` (dev-only, honoured only when `!app.isPackaged`: main calls `setContentSize(W, 800)`, i.e. the **content** size, not outer bounds, and resets the renderer zoom to 1; Codex r1 #16), `--remote-debugging-port=9333`. Before any capture the script asserts `window.innerWidth === W`, `devicePixelRatio`-independent CSS width, and `document.documentElement.dataset.band` equal to the band §7.1 expects; a mismatch fails the run. The same launch also resizes to `W−1` and `W` for 1100/1000/900 and asserts the band flips exactly there (no screenshot).
4. Per theme in `["light","dark"]` (`Emulation.setEmulatedMedia` `prefers-color-scheme`, prefs theme is `system`), per route in `["/bots/new", "/bots/<first>", "/sessions/new", "/sessions/<first>?tab=terminal", "/routines", "/routines/new", "/artifacts", "/library/connectors", "/settings/general", "/settings/appearance", "/onboarding/welcome", "/__ui?section=shell"]`: call `await window.__abacusDev.navigateAndSettle(href)` (exposed only when `VITE_UI_GALLERY=1`). It resolves only after (Codex r1 #15): the router's `onResolved` for **that** href with no pending matches; `document.activeViewTransition?.finished` (or none active); `document.getAnimations()` all finished or idle; `document.fonts.ready`; collections required by the route `ready`; two animation frames. Then `Page.captureScreenshot`.
5. Extra states on the 1280 run: sidebar collapsed via `__abacusDev.setPinned(false)`, then `Input.dispatchMouseEvent` over the rail and `navigateAndSettle`-style settling on the floating sidebar's `onAnimationComplete` (canvas `HoverSidebar`).
6. axe in the page (`Runtime.evaluate` injecting `axe-core/axe.min.js`, `axe.run(document, { runOnly: ["wcag2a","wcag2aa"] })`) per route and theme; contrast violations fail the script.
7. Output: `.build/screenshots/<git-sha>/<route-slug>@<W>-<theme>.png` + `axe.json` + an `index.html` contact sheet grouped by canvas board, light and dark side by side (PLAN L43).

macOS runs also capture page 5's fullscreen case: the script sends Ctrl+Cmd+F through `Input.dispatchKeyEvent` (the app menu's `viewMenu` role includes `togglefullscreen`, `src/main/index.ts` `Menu.setApplicationMenu`) and waits for `geometrychange`. Linux runs are repeated with `ABACUSBOT_NATIVE_FRAME=1` (window-chrome §3) so the bands are also checked under the native-frame fallback. Windows and Linux captures run on those machines (CI where a display exists).

---

## 11. Tests (vitest project `renderer-next` unless noted)

| Id | File | What it proves |
|---|---|---|
| R1-T1 | `router.test.ts` | Route tree snapshot: walks `routeTree` and snapshots `[{ id, fullPath }]` sorted; every `_shell` leaf resolves `staticData.area` and `sidebar` through its ancestors; `/`, `/bots`, `/sessions`, `/library`, `/settings`, `/onboarding` redirect to their §6.1 targets (memory history); **every `routeMasks[].from` is a `fullPath` in the tree** (not an id); masked navigation to `/bots/<id>/details`, `/routines/new`, `/library/connectors?connector=x` shows the mask target as `maskedLocation`, renders the expected background (routines `_list` body stays mounted), survives a simulated reload (router re-created on the same history) and closes with `history.back()`; `/__ui` is `notFound` with the gallery off. |
| R1-T2 | `lib/navigation/search.test.ts` | Each schema: valid input round-trips; invalid values fall back (bad `tab`, bad `view`, over-long `q`, unknown keys dropped); defaults stripped from built links; `retainSearchParams(["view"])` keeps `view` across sessions; a bot route cannot carry `tab=terminal`; `GallerySearch.theme` values. |
| R1-T3 | `data/collections/ipc-collection-options.test.ts` | Spec 00 B-T1 (all cases) with the fake table client (`test-support/fake-table.ts`). Plus `usePrefs()` defaults then row; `updatePrefs` optimistic and settles on the echo. |
| R1-T4 | `features/bots/bots-sidebar.test.tsx`, `features/sessions/sessions-sidebar.test.tsx` | Live sidebars over a real `createCollection` + fake table: order (pinned first), change batches update the DOM without remount, filtered sessions never render, workspace grouping, skeleton while loading, error + Retry after `markError`. |
| R1-T5 | `features/shell/layout.test.ts` | `layout.ts` table: every band × area × pinned × tab (boundaries 799/800, 899/900, 999/1000, 1099/1100). |
| R1-T6 | `features/shell/shell-layout.test.tsx` | Controllable `matchMedia`: side panel in layout at xl (`orientation="horizontal"`, panel `minSize` 360 and `defaultSize` from prefs in **pixels**, `onResize` persists `inPixels` after the debounce) and a drawer below with `data-side-panel`; bots strip at sm; sessions unpinned at sm without writing prefs; status text hidden at md; actions fold at sm; `html[data-band]` follows. |
| R1-T7 | `lib/theme.test.ts` | `resolveTheme` table; `<ThemeEffect/>` applies `.dark` + `color-scheme` for light/dark/system, follows the media query only for `system`, writes `data-reduce-motion`; the appearance control writes `prefs.theme`. |
| R1-T8 | `features/gallery/a11y.test.tsx` | axe-core over every gallery section in jsdom (`color-contrast`, `region` off) with zero violations, run once with `theme=light` and once with `theme=dark` while the app theme is the opposite. |
| R1-T9 | `lib/window-chrome/overlay-slots.test.ts` | (a) every `OCCLUDER_SLOTS` entry exists in some installed `ui/*.tsx`; (b) every installed `data-slot` matching `/-(content|overlay|popup|viewport)$/` or equal to `toast` is in exactly one of `OCCLUDER_SLOTS`, `NO_DRAG_ONLY_SLOTS`, or the explicit `NON_OCCLUDING` list (`card-content`, `message-scroller-content`, `message-scroller-viewport`, `scroll-area-viewport`, `tabs-content`, `item-content`, `drawer-viewport`, …) so a new registry overlay forces a decision; (c) `RESERVED_OCCLUDER_SLOTS` are absent from `ui/` (else they must move to `OCCLUDER_SLOTS`); (d) the `tokens.css` no-drag selector equals `NO_DRAG_SELECTOR`. |
| R1-T10 | `features/shell/occlusion.test.ts` | Idle `Toaster` (mounted viewport, no toasts) publishes `any: false`; two stacked toasts publish two rects; a candidate keeps occluding during `data-ending-style`; zero-size and `checkVisibility() === false` elements are ignored; a `resize`/`scroll` event and a `ResizeObserver` callback re-measure; while `getAnimations()` reports running animations a rAF loop re-measures and stops afterwards (fake timers + stubbed rects); `message-scroller-content` ignored. |
| R1-T11 | `lib/navigation/transition-types.test.ts` | Real router (memory history) with `installTransitionTypes`, `addTransitionType` observed through a spy on the module wrapper: (1) a loader delayed past `defaultPendingMs` → the pending **offer** adds nothing, the commit adds the intent; (2) a blocked navigation (`useBlocker`) → nothing added, next navigation unaffected; (3) two rapid navigations → only the second commits, with its own intent; (4) `invalidate()` re-commit of the same entry adds nothing; (5) back/forward use `__TSR_index` direction; (6) `inferNavType` rank table incl. `/bots/new` → `/bots/<id>` = `nav-forward`, sibling sessions = `nav-lateral`, settings in/out, search-only = none. Motion constants equal the durations in `tokens.css`. |
| R1-T12 | `lib/window-chrome/use-titlebar-area.test.ts` | Window-chrome §10 renderer cases, against renderer-next. |
| R1-T13 | `lib/sound.test.ts` | Gating, coalescing, per-event switches, master switch. |
| R1-T14 | `features/shell/hotkeys.test.tsx` | Each binding fires its action once; `Mod+Alt+B` never triggers the `Mod+B` handler and vice versa; `Mod+B` in a `textarea` toggles, inside `[contenteditable]` does not; macOS Option+B (`key: "∫"`, `code: "KeyB"`) matches `Mod+Alt+B`; no other `keydown` listener on `window`/`document` besides the hotkey manager (spy on `addEventListener` during a full shell render). |
| R1-T15 | `guards.test.ts` | Static scan of `src/renderer-next/**`: no `electron`, `window.api`, `ipcRenderer`, `#renderer/` (except `#locales/`), `framer-motion`, `zustand`, `sonner`; `@base-ui/react` only under `ui/`; features do not import other features' internals; routes import only feature `index` files. |
| R1-T16 | `lib/i18n/i18n.test.ts` | `matchSupportedLanguage`; `resolveLanguage("system")` follows `navigator.languages`, explicit `"en-US"` stays English with a German OS; new keys exist; no new key collides with an existing leaf; `--apply-keymap` fills a missing key. |
| R1-T17 (main) | `src/main/renderer-generation.test.ts`, `src/main/renderer-entry.test.ts` | Env override only unpackaged; entry URL for dev/experience/file × legacy/wco; `ABACUSBOT_DEV_CONTENT_SIZE` ignored when packaged. |
| R1-T18 | `lib/bootstrap.test.ts` | `bootstrap()` with the memory transport: transport never answers → `BootFailure` (transport); `system.info` rejects; prefs snapshot rejects (`markError`); port closed during `prefs.preload()`; port closed after mount → reconnect toast then error. The router is never created on failure. |
| R1-T19 (main) | `src/main/services/config/prefs-store.generations.test.ts` | Repeated generation switching over one `prefs.json` + `renderer-state.json` (spec 00 C.4 live sync): legacy write visible to next; next (`user`) write not overridden by a later legacy write of the same field; legacy-only fields keep flowing; startup `themeSource` comes from prefs before window creation (with a fake `BaseWindow` recording call order). |
| R1-T20 | `features/shell/readiness.test.tsx` | `window.ready({ barrier: "subscriptions" })` is called exactly once for a direct launch into `/bots/new`, `/onboarding/welcome` and `/__ui`, only after `prefs`, `sessions`, `workspaces` are ready; `failed` when one `markError`s; not repeated on navigation or HMR. |

The old `renderer` project must stay green on React 19.3 and Base UI 1.8 (acceptance item).

---

## 12. Acceptance checklist

**Build and coexistence**
- [ ] `pnpm --filter @abacus-ai/desktop typecheck` builds five projects (main, preload, renderer, renderer-next, vite); renderer-next has no `electron` types.
- [ ] `pnpm lint`, `pnpm format:check`, `check:knip-next`, `check:i18n`, `check:locales` green; `pnpm test:unit` green including `renderer` (old) and `renderer-next`.
- [ ] `vite build` emits `dist/renderer/index.html` and `dist/renderer/index-next.html`; the experience bundle contains both.
- [ ] React Compiler scope: the built renderer-next chunks import `react/compiler-runtime`, the old renderer's chunks do not; in `pnpm dev`, editing a component in each renderer hot-reloads it without a full page reload (Fast Refresh kept in both, §3.3).
- [ ] With `RENDERER_GENERATION = "legacy"` the app behaves exactly as before (manual smoke + old suites). The PR's diff under `apps/desktop/src/renderer` touches **only `src/renderer/locales/*.json`**, and there only adds keys (Codex r1 #24): a script compares each locale file with its base-branch version and fails if any existing key was removed or its value changed.
- [ ] `shadcn info --json` resolves `ui` → `src/renderer-next/ui`, icon library lucide; `check:ui-registry` (offline, snapshot replay, formatted) shows no diff.
- [ ] Importing a `.css` file and an asset from a renderer-next component builds and hot-reloads (compiler scoped to JS/TS, §3.3).

**Canvas page 1 — Navigation** (`BotChat`, `BotChatScrolled`, `HoverSidebar`, `SessionRunning`, `Routines`, `RoutineCreate`, `RoutineStates` as shells only)
- [ ] Rail: five items with the canvas duotone icons and labels, active pill on the current area, Settings + Account at the bottom; switching areas cross-fades pane and sidebar in 200 ms (`nav-lateral`), drilling `/sessions/new` → `/sessions/<id>` slides 12 px (`nav-forward`), browser back plays `nav-back`.
- [ ] Sidebars are live: creating, renaming and deleting a bot or a session **through the same main process** (the dev WebSocket transport script `scripts/rpc-ws-smoke.mjs mutate …`, spec 00 A.8, which calls `db.bots.*`/`db.sessions.*`; Codex r1 #19) shows up in renderer-next within one frame of the change batch. A second app process on the same home is not a supported scenario (no cross-process feed).
- [ ] Collapsed: hovering the rail floats the area's sidebar over content (280, border, shadow, radius 12) without reflowing the pane; leaving closes it; ⌘B pins/unpins with the spring, ⌘⌥B toggles only the side panel; the app name appears in the title bar only when pinned.
- [ ] `/routines/new` opens as a sheet over `/routines` with the URL masked to `/routines`; Escape goes back. Same for `/bots/<id>/details` and `/library/connectors?connector=x`.
- [ ] Every top-level area and every settings page renders its empty state with the right sidebar; `/` lands on `/bots/new`.

**Canvas page 5 — Title bar by platform** (`TitleMac`, `TitleMacFullscreen`, `TitleWindows`, `TitleLinux`)
- [ ] macOS: traffic lights inside the 40 px bar; back/forward/toggle start right of them with no literal inset (`--titlebar-x`); fullscreen removes the gap with no JS; compact density gives 32 px in and out of fullscreen.
- [ ] Windows: caption buttons on the right, bar content ends before them (`--titlebar-end`), no content under the buttons; theme switch in Settings › Appearance recolours the symbols live.
- [ ] Linux X11 overlay: buttons in the bar; Linux native-frame: system title bar above the 40 px app bar, reservations 0, `data-titlebar="native-frame"`.
- [ ] The whole bar drags the window except its buttons/tabs; a popover and a dialog opened over the bar are clickable and dismissable (no-drag rule), also on `/__ui` (`_bare`).
- [ ] `overlay-unavailable` (forced by the window-chrome test hook) shows the dev badge.

**Canvas page 6 — Window widths** (`WidthRules`, `BW1000`, `BW900`, `BW800`, `W900`, `W800`)
- [ ] 1280/1100+: sidebar pinned 280, side panel in layout (min 360) when `tab` is set, identity + status in the title bar.
- [ ] 1000: side panel is a 356 drawer over a 45% scrim with 2 px blur (computed style checked); Escape or scrim closes it and clears `tab`.
- [ ] 1100+: dragging the panel handle stops at 360 px panel and 480 px pane; the width persists across restart.
- [ ] 900: status text leaves the title bar; avatar/name/dot stay.
- [ ] 800: bots sidebar is the 88 px strip; sessions sidebar unpins (floats on hover) and comes back pinned when the window grows; title-bar actions fold into ⋯.
- [ ] 4 widths × 2 themes screenshots produced by `screenshots-next.mjs`, reviewed side by side with the canvas boards; axe (real layout) reports no contrast violations.

**Theme and data**
- [ ] Light, dark, system: `.dark` + `color-scheme` on `<html>`; with stored `dark` on a light OS (and the reverse) and a transport delayed 2 s, a CDP screencast from launch contains no frame in the wrong theme (main sets `themeSource` before the window exists, §7.7); system changes followed live when `system`; the choice persists and native controls recolour.
- [ ] `window.ready({ barrier: "subscriptions" })` is called once after prefs/sessions/workspaces are ready, for any entry route including `/onboarding/*` and `/__ui`; an experience swap to a renderer-next build flips only after it (spec 00 A.4.6).
- [ ] Unavailable transport at launch shows the boot failure screen with Reload; the router is never created.
- [ ] Devtools cockpit opens in dev with Router, Query, Collections, Hotkeys, Pacer; nothing of it is in the production bundle (grep the built JS for `TanStackDevtools`).

---

## 13. Risks

- **Native React Compiler is experimental** (plugin-react README; oxc blog 2026-08-18). Mitigation: exact pins of `@vitejs/plugin-react` 6.1.1 and `oxc-transform-react` 0.145.0; `logDiagnostics: true`; the acceptance check above. The two-instance ordering relies on how Vite merges the instances' `config` results, so a plugin-react bump re-runs that check. Fallback, if the Rust compiler miscompiles something: drop `compiler` (the app stays correct without it; only memoisation is lost), not a switch back to Babel.
- **Router seam (F7).** `installTransitionTypes` relies on `router.startTransition` being an instance property that `Transitioner` reassigns, and on offer calls carrying a `pending` match. Mitigation: exact router pin; R1-T11 runs the real router through delayed, blocked, superseded and invalidated navigations, so a router bump that changes either fact fails loudly. Fallback: no types (plain cross-fade via a bare `<ViewTransition>`), never a second transition.
- **Phase 0 not landed.** Phase 1 cannot render sidebars before spec 00 A + B (contract, tables, `ipcCollectionOptions`) and the `window.chrome` addition (§15) land. Mitigation: build shell and gallery against `createMemoryTransport` + fake tables first (tests already require them), switch to the MessagePort transport when 00b merges.
- **React 19.3 / Base UI 1.8 for the old renderer.** Minor bumps, but they land in the shared package. Mitigation: old suites in the gate; revert path is the catalog line.
- **Registry drift.** Mitigated by the committed registry snapshot and offline replay (§5.4); refreshing it is a reviewed commit.
- **No registry `sidebar`.** Rows are a small `NavList` molecule over registry atoms; if a later phase wants the registry sidebar, it must not mount `SidebarProvider` while the app handler owns ⌘B.
- **Tailwind source scoping.** `source(none)` + `@source "../"` must be re-applied if a future `shadcn init` rewrites `app.css`; the verification script (§5.1 step 4) checks for it.
- **Registry sr-only English.** A few atoms carry hard-coded English sr-only text; tracked, and wrapped with translated labels where the API allows.
- **Screenshot determinism.** WCO geometry differs by OS, font rendering by machine. Comparisons are by role/structure against the canvas, not pixel diffs; the contact sheet is for humans.
- **Old boot services not yet ported** (log collector, activity beacon, UI continuity). Experience swaps targeting renderer-next need the activity beacon's replacement first; until then `RENDERER_GENERATION` stays `"legacy"` in shipped builds (it does anyway until phase 7).
- **CSP and dev tools.** Anything needing another origin (devtools event bus, remote fonts) is blocked by design; keep it that way.
- **Two prefs sources during transition.** Handled by spec 00's provenance-aware live legacy sync (legacy → prefs), a hard prerequisite (§8.3, R1-T19). The reverse direction (new-renderer choices written back into `renderer-state.json`) is **not** done: spec 00 keeps `renderer-state.json` read-only until cut-over for downgrade safety, and shipped builds never switch generation (the override is dev-only). A developer switching back to legacy sees legacy's last own values.
- **Startup theme in main.** Reading `prefs.json` before window creation adds a synchronous file read to startup (small, atomic-written file); a corrupt file falls back to `system` and logs.

---

## 14. Scaffold commands, in order

Run from the repo root unless noted; each numbered step is a commit on a `rewrite/01-foundation` branch stacked on `rewrite/00b-db-tables`.

1. Bump the catalog in `pnpm-workspace.yaml`: `react: ^19.3.0`, `react-dom: ^19.3.0`, `@types/react: ^19.3.0`, `@types/react-dom: ^19.3.0`, `@vitejs/plugin-react: 6.1.1`.
2. `pnpm --filter @abacus-ai/desktop add -D @tanstack/react-router@1.170.40 @tanstack/router-plugin@1.168.41 @tanstack/react-router-devtools@1.167.2 @tanstack/db@0.9.2 @tanstack/react-db@0.4.1 @tanstack/react-query@^5.104.0 @tanstack/react-query-devtools@5.104.0 @tanstack/react-store@^0.11.2 @tanstack/react-devtools@0.10.13 @tanstack/react-hotkeys@0.12.1 @tanstack/react-hotkeys-devtools@0.9.1 @tanstack/react-pacer@0.24.0 @tanstack/react-pacer-devtools@0.9.0 motion@^13.4.6 shadcn@4.21.0 @shadcn/react@^0.3.1 lucide-react@^1.49.0 oxc-transform-react@0.145.0 axe-core@4.13.0` (the `@orpc/*` and `valibot` entries come from 00a) and `pnpm add -Dw knip@6.38.0`; `pnpm install`; `pnpm --filter @abacus-ai/desktop test -- --project renderer` (old renderer green on React 19.3).
3. Add `#next/*` and `#locales/*` to `apps/desktop/package.json` `imports`; aliases in `vite.config.ts` and `vitest.config.ts`.
4. Create `apps/desktop/tsconfig.renderer-next.json`, reference it from `apps/desktop/tsconfig.json`; create `src/renderer-next/env.d.ts`, `main.tsx` (renders "hello"), `index-next.html`.
5. `vite.config.ts`: `rolldownOptions.input`, `tanstackRouter(...)`, the two `react()` instances (§3.3); create `src/renderer-next/routes/__root.tsx` with an `<Outlet/>`; `pnpm --filter @abacus-ai/desktop exec vite build` (generates `routeTree.gen.ts`; commit it).
6. `src/main/renderer-generation.ts` (`resolveRendererGeneration`), `rendererEntry()` in `index.ts` and `renderer-host.ts`, `ABACUSBOT_DEV_CONTENT_SIZE`; tests R1-T17; add `"dev:next"` script. `pnpm --filter @abacus-ai/desktop dev:next` shows "hello" inside the WCO window.
7. `vite.shared.ts` + `tsconfig.vite.json` include; `oxlint.config.ts` overrides, `packages/config/build-output-ignores.ts` (`**/routeTree.gen.ts`), `knip.json`, `check:knip-next`; `vitest.config.ts` project `renderer-next` + `test-support/setup.ts`; `test:unit` includes it.
8. shadcn: `node apps/desktop/scripts/shadcn-next-init.mjs` (scratch-package init + transplant + canonical `components.json`, §5.1 steps 1–3), then `node apps/desktop/scripts/shadcn-registry-snapshot.mjs --record` (§5.4), then `pnpm --filter @abacus-ai/desktop exec shadcn info --json` (check paths) and `git status apps/desktop/src/renderer` (must be clean).
9. Edit `styles/app.css` (§5.1 step 5) and create `styles/tokens.css` (§5.3).
10. `node apps/desktop/scripts/shadcn-next.mjs add button dialog alert-dialog sheet drawer tabs dropdown-menu context-menu popover tooltip hover-card combobox command resizable scroll-area kbd field label input input-group textarea item empty spinner skeleton separator badge avatar toggle toggle-group switch select native-select toast message-scroller message bubble attachment marker questionnaire collapsible` (dry-run gate, then snapshot-replayed `add`, §5.1 step 4), then `pnpm format`; commit `ui/` and the snapshot alone.
11. `data/`: transport (from 00a, re-homed), `query-client.ts`, collections registry + prefs helpers, queries skeleton; R1-T3.
12. `lib/`: theme, motion, sound, platform, window-chrome, navigation (search atoms, `use-app-navigate`, `transition-types`), i18n; R1-T7, R1-T11, R1-T12, R1-T13, R1-T16.
13. `router.tsx` + all route files of §6.1 (placeholders); regenerate the tree; R1-T1, R1-T2.
14. `features/shell/` (layout, rail + icon sprite, sidebar slot, top bar, side panel, occlusion, store, hotkeys, command menu, devtools) and area sidebars; R1-T4 … R1-T6, R1-T9, R1-T10, R1-T14, R1-T15.
15. i18n keys + `scripts/locale-keymap.json` + script changes (`check-jsx-i18n.js`, `sync-locales.js --apply-keymap`); `pnpm --filter @abacus-ai/desktop sync:locales -- --apply-keymap`; `check:i18n`, `check:locales`.
16. `features/gallery/` + `_bare/[__ui].tsx`; R1-T8; fixtures home; `scripts/screenshots-next.mjs`; run it on macOS (and Windows/Linux where available); attach the contact sheet to the PR.
17. `docs/rewrite/PROGRESS.md` row for phase 1; `pnpm check`.

---

## 15. Amendments this spec requires elsewhere

1. **Spec 00 transport (A.7, A.9, A-T7, A.11, A.12, L382, L428):** `src/renderer/data/**` → `src/renderer-next/data/**` (F12). The old renderer does not import the transport in phase 0–6.
2. **Spec 00 B.3, B.5:** `renderer/data/collections/**` → `renderer-next/data/collections/**`; `@tanstack/db` **0.9.2** / `@tanstack/react-db` **0.4.1** until 0.10.0/0.4.2 are on npm (F2); cited source lines are from the 0.10.0 clone and hold for 0.9.2's `commit()` receipt API.
3. **Spec 00 A.2 `window.*` rows:** add `window.chrome` (Q, `{ mode: ChromeCapability, fullScreen, density, toolbarHeight }`, served by the same `chromeState` main uses for `ipcMain.handle("window:chrome")`, `index.ts:1221`) and `window.events` variant `{ type: "chrome", chrome }` (emitted on capability, fullscreen and density changes).
4. **Spec 00 B.2 `PrefsRow.language`:** `"system" | SupportedLanguage`, default `"system"`; C.4 maps `abacusai-bot-language` to the explicit code when present. Spec 00 C (live legacy sync, C-T5, C-T8) is a merge prerequisite of this phase. Main reads `prefs.theme` at startup (before `new BaseWindow`) when the generation is `wco`.
5. **PLAN.md:** remove `tw-animate-css` from "Nuked" (F5); `motion` 13.x (F8); Rail's fifth item is Library with the Connectors glyph (F11); DB versions (F2); React Compiler via plugin-react's native `compiler` option + `oxc-transform-react`, no Babel (F1); toast is registry `toast`, not sonner (F6); the registry `sidebar` is not used (§5.2).
6. **Spec 00 window chrome §6/§10:** `src/renderer/lib/tokens.css` and the renderer tests are realised in renderer-next (`styles/tokens.css`, `lib/window-chrome/*`); the old renderer keeps its constants until cut-over, which is consistent with its §11 (the switch is `RENDERER_GENERATION`).

---

## Review responses (r1)

Source: `docs/rewrite/specs/reviews/01-renderer-foundation.codex-r1.md` (24 findings). The reviewer could not reach npm; version claims were re-checked here against the registry on 30 Sep 2026 and against installed/packed packages. The earlier post-r1 correction (React Compiler through `react({ compiler })` + `oxc-transform-react`, no Babel) is kept.

| # | Sev. | Verdict | Evidence checked | What changed |
|---|---|---|---|---|
| 1 | Blocker | **Accepted** | Reproduced: a CSS import under the compiler instance's directory-only `include` fails with "Unexpected token"; plugin default include is `/\.[tj]sx?$/` (`plugin-react@6.1.1 dist/index.js:57-61`). With `NEXT_MODULES` (JS/TS only) CSS passes, `?tsr-split=` ids still compile, old renderer keeps Fast Refresh. | §3.3 (`vite.shared.ts`: `NEXT_SRC`, `NEXT_MODULES`), verification table rows, §3.7, §12 (CSS/asset import check). |
| 2 | Blocker | **Accepted** | `RouteMask.from: RoutePaths<…>` (`router-core/src/route.ts:1589-1596`); masks matched on `next.pathname` (`router.ts:2185-2195`). | §6.6 masks use `/bots/$botId/details`, `/routines/new`, `/library/connectors`; R1-T1 asserts fullPaths and real masked navigation + reload. |
| 3 | Blocker | **Accepted** | `init` with a preset backs up the config and infers aliases (`init.ts:540-560`, `get-project-info.ts:524-560`); `add` with an existing config does not (`get-project-info.ts:530-540`). | §0 F3/F4, §5.1 rewritten: init only in an isolated scratch package, transplant CSS/`cn`, hand-written `components.json`, `add` behind a `--dry-run` path gate. §14 step 8. |
| 4 | Major | **Accepted** | `react-resizable-panels` 4.12.3 d.ts: `orientation` (`:138-140`), numbers are pixels (`:293-300`), `onResize` gives `{ asPercentage, inPixels }` (`:355,375-378`); registry wrapper forwards props. | §7.5: `orientation="horizontal"`, `minSize={360}`, pane `minSize={480}`, `defaultSize` px, persist `inPixels`; R1-T6; §12 drag check. |
| 5 | Major | **Accepted** | Router captures load errors into matches. | §8.6: `bootstrap()` resolves transport, `system.info`, prefs before the router exists; static `BootFailure`; post-mount port loss handled; §6.4 context carries `transport`/`system`; R1-T18. |
| 6 | Major | **Accepted** | `_bare` routes never render `_shell`. | §6.1 `__root` owns `<ReadinessReporter/>` for every entry route; `_shell`/`_bare` rows updated; R1-T20; §12. |
| 7 | Major | **Accepted** | Offer call passes a `pending` match (`load-client.ts:1524-1530`); commit at `:1870-1881`; superseded tx returns before commit (`:1863-1869`). | §6.7: intent in history state (`navIntent {id,type}`), seam adds types only on commit calls, once per `__TSR_key`; §6.4 `HistoryState` augmentation; R1-T11 uses the real router (delayed, blocked, rapid, invalidate, back/forward). |
| 8 | Major | **Accepted** (deviates from the brief's add list) | Registry `SidebarProvider` binds `b`+Ctrl/Meta on `window` without Alt/Shift/editable checks (`sidebar.tsx:96-109`); `useIsMobile` 767 px flips under zoom. | §5.2 drops `sidebar`; §7.3 rows via `components/nav-list/` (registry `Item`, `Button`, `Badge`, `Skeleton`, `Collapsible`); §7.9 single app-owned handler with exact modifiers and a contenteditable guard; R1-T14. |
| 9 | Major | **Accepted** | `style-mira.css:492-494` `bg-black/80` + `backdrop-blur-xs`; `DrawerContent` renders its own overlay (`drawer.tsx:109-112`). | §5.3 scoped unlayered rule `[data-slot="drawer-portal"]:has([data-side-panel]) [data-slot="drawer-overlay"]`; §7.5; canvas mapping table; §12 computed-style check. |
| 10 | Major | **Accepted** | `Toaster` always renders `ToastViewport` (`toast.tsx:244-258`); toasts are absolutely positioned (`toast.tsx:33-45`). | §7.6: occlusion measures `[data-slot="toast"]` roots; viewport is no-drag only; empty/unrendered rects ignored; R1-T10. |
| 11 | Major | **Accepted** | — | §7.6: `ResizeObserver` per candidate, `resize`/capture `scroll` invalidation, rAF loop while `data-starting/ending-style` or running animations; R1-T10. |
| 12 | Major | **Accepted in part** | Spec 00 r2 already specifies provenance and live legacy → prefs sync (`00-transport-db-migration.md` B.2 "Provenance", C.4 items 1–2, C-T8). | §8.3 makes spec 00 C's live sync a merge prerequisite; R1-T19 covers repeated generation switching; §15.4. **Rebutted:** writing new-renderer choices back into `renderer-state.json` — spec 00 keeps that file untouched until cut-over for downgrade safety, and shipped builds never switch generation (override is unpackaged-only). §13 states this. |
| 13 | Major | **Accepted** | Provenance is private to main, so the row alone cannot tell explicit `en-US` from unset. | §9.2: `PrefsRow.language = "system" \| SupportedLanguage`, default `"system"`, `resolveLanguage`; §15.4 amends spec 00; R1-T16. |
| 14 | Major | **Accepted** | Chromium's `prefers-color-scheme` follows `nativeTheme.themeSource`. | §7.7: main reads `prefs.theme` and sets `themeSource` + background before `new BaseWindow`; renderer boot follows the media query, so the first frame is already right; §13 risk; §15.4; R1-T19; §12 screencast check with delayed transport. |
| 15 | Major | **Accepted** | — | §10.2: `__abacusDev.navigateAndSettle(href)` waits for that href's `onResolved`, view transition `finished`, animations, fonts, route collections, 2 frames. |
| 16 | Major | **Accepted** | — | §10.2: `ABACUSBOT_DEV_CONTENT_SIZE` → `setContentSize` + zoom 1; asserts `innerWidth` and `data-band`, checks both sides of each boundary; Linux repeated under native frame. |
| 17 | Major | **Accepted** | `REGISTRY_URL` env override (`packages/shadcn/src/registry/constants.ts:5-6`). | §5.4: committed registry snapshot with hashes, offline replay for `add` and `check:ui-registry`, formatted comparison. |
| 18 | Major | **Accepted** | `index` and `new` are sibling matches. | §6.1: pathless `routines._list.tsx` renders the page body + `<Outlet/>`; `_list.index` renders null; `_list.new` is the masked sheet; R1-T1 checks the mounted background. |
| 19 | Major | **Accepted** | Table feeds are per main process (spec 00 B.4). | §12: mutations go through the same main process via the dev WebSocket transport; two processes on one home declared unsupported. |
| 20 | Minor | **Accepted** | `/bots/new` and `/bots/<id>` are siblings by path. | §6.7: `ROUTE_RANK` relationship table + history direction from `__TSR_index`; creation → detail is `nav-forward`; R1-T11 cases. |
| 21 | Minor | **Accepted** | Portaled overlays escape a nested `.dark` container; `:root` light tokens do not re-apply under a dark `<html>`. | §10.1: one theme per page, applied to `<html>` while the gallery is mounted; side-by-side lives in the contact sheet; §6.2 `GallerySearch.theme`; R1-T8 runs both. |
| 22 | Minor | **Accepted** | `tsconfig.vite.json:10` includes only the two configs and is `composite`. | §3.3/§3.7 `vite.shared.ts` added to its `include`; §14 step 7. |
| 23 | Minor | **Accepted** | Menubar/navigation-menu are not installed; drawer adds `drawer-viewport`, toast adds `toast`. | §7.6 three lists (occluders, reserved, no-drag-only); R1-T9 asserts existence, classification of every installed slot, reserved absence, CSS equality separately. |
| 24 | Minor | **Accepted** | §9 adds keys to `src/renderer/locales/*.json`. | §12: the legacy diff may touch only locale JSON, additions only; a script fails on removed or changed keys. |

Nothing was rejected outright. The one disagreement is the reverse prefs sync in #12, for the reason given in that row.
