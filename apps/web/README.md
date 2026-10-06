# @abacus-ai/web

The browser build of the renderer. `vite build` here writes `index.html` and
its assets to `dist/` with `/bot/` URLs; the desktop app builds the same
source tree for Electron from `apps/desktop`. See
[docs/architecture.md](../../docs/architecture.md) for how the two builds
share `src/`.

## Deployment overlay

A deployment can extend the served HTML and the Content Security Policy at
build time, for things such as analytics, consent banners, fonts or extra
backend origins, without a fork of this repository. The open-source build has
no overlay: nothing in this repository sets the variable, and the HTML and
policy ship exactly as `index.html` and `vite.renderer.ts` define them.

Set `ABACUS_WEB_OVERLAY` to the absolute path of an ES module when running
`vite build` or `vite` (the dev server applies it too, so a deployment can be
previewed locally). The browser build alone reads it; the Electron build never
does. The module's default export is an overlay object, or a function
`({ mode, command, env }) => overlay` (sync or async) that receives Vite's
mode, `"build"` or `"serve"`, and the build's environment variables.

The overlay's shape is the `WebOverlay` type exported from `vite.renderer.ts`:

| Field           | Effect                                                                                                                                              |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------- |
| `csp`           | Sources appended to the named directives of the base policy, for example `{ "connect-src": ["https://api.example"] }`.                              |
| `head`, `body`  | Vite `HtmlTagDescriptor`s injected into the document; each tag's `injectTo` defaults to `head` or `body` by field.                                  |
| `transformHtml` | `(html) => html`, applied after the tags, for anything the tag API cannot express.                                                                  |
| `define`        | Merged into Vite's `define`; values are JSON-encoded, as Vite expects.                                                                              |

The directives `csp` accepts: `default-src`, `script-src`, `style-src`,
`img-src`, `font-src`, `connect-src`, `frame-src`, `media-src`, `worker-src`,
`object-src`, `base-uri`, `form-action`. Sources merge into the existing
directive, deduplicated, never as a second copy of it; a directive the base
policy lacks is created once, seeded with the sources it fell back to; a
directive set to `'none'` keeps `'none'` unless the overlay lists sources for
it; an empty list changes nothing. The result stays one line.

Inline `<script>` and `<style>` tags with text `children` are hashed: the
SHA-256 of the exact text is appended to `script-src` or `style-src` as
`'sha256-<base64>'`, so inline snippets run without `'unsafe-inline'`. A
directive that already allows `'unsafe-inline'` (the base `style-src` does)
gets no hash, since a hash would make browsers ignore that keyword. External
`<script src>` origins are not added automatically; declare them in `csp`.

```js
// overlay.mjs
export default ({ command }) => ({
  csp: {
    "script-src": ["https://scripts.example"],
    "connect-src": ["https://api.example"],
  },
  head: [
    {
      tag: "script",
      attrs: { async: true, src: "https://scripts.example/tag.js" },
    },
    { tag: "script", children: "window.exampleConfig = { id: 'EXAMPLE_ID' };" },
  ],
  define: { __EXAMPLE_PREVIEW__: JSON.stringify(command === "serve") },
});
```

```sh
ABACUS_WEB_OVERLAY=/path/to/overlay.mjs pnpm --filter @abacus-ai/web build
```

A malformed overlay fails the build with an error naming the field;
`vite.overlay.ts` holds the loader and the merge, and `vite.overlay.test.ts`
covers them, including a build with a fixture overlay.
