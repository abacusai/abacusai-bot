# Cutover tooling policy

The removed-dependency checker parses TS and JS imports, exports and require calls, CSS package directives, workspace manifests and pnpm patch/build entries. The lint ban remains in place.

Knip's dependency exceptions have actual consumers: `@testing-library/dom` is a peer of React Testing Library; Inter, JetBrains Mono, Tailwind CSS and tw-animate-css are CSS imports in `styles/app.css`. Registry output and generated route trees retain their existing exclusion. Executable script entries match package scripts, CI and packaging hooks.

C5's committed size measurements set gzip limits at +5%. `measure:size` resolves each final build's hashed resources without changing those limits. CI checks the limits after the production build. The baseline is immutable; new measurements go to `07-size-current.json`.

`unsafe-eval` stays until packaged dictation and experience-swap tests establish that narrowing to `wasm-unsafe-eval` works. No packaged dictation evidence was collected during implementation. The 4096 MiB build heap stays pending a measured peak-heap run. ConnectorMark still carries licensed Exa, Firecrawl and Tavily SVG paths, so their license records stay.
