#!/usr/bin/env bash
set -euo pipefail
# Isolated archives only; never creates or changes a worktree.
export PATH="$(npm prefix -g)/bin:$PATH"
repo=$(git rev-parse --show-toplevel)
baseline_dir=$(mktemp -d /tmp/web-split-baseline.XXXXXX)
deps_dir=$(mktemp -d /tmp/web-split-baseline-deps.XXXXXX)
git -C "$repo" archive 99f20795 | tar -x -C "$baseline_dir"
git -C "$repo" archive 6f9b4c10 | tar -x -C "$deps_dir"
printf '%s  %s\n' 0c5f8fc01514231647828025d3e0ef6c62276b7158f7db3e0cbb1f8caef9cfcd "$deps_dir/pnpm-lock.yaml" | sha256sum -c -
(cd "$deps_dir" && env -u NODE_ENV -u CI pnpm install --frozen-lockfile && pnpm --filter @abacus-ai/connectors build && env -u ABACUS_RELEASE -u ABACUS_BUILD_COMMIT GIT_DIR="$repo/.git" GIT_WORK_TREE="$deps_dir" pnpm --filter @abacus-ai/agent build)
ln -s "$deps_dir/node_modules" "$baseline_dir/node_modules"
ln -s "$deps_dir/apps/desktop/node_modules" "$baseline_dir/apps/desktop/node_modules"
# Keep real repository provenance while all build writes go to the archive.
(cd "$baseline_dir/apps/desktop" && env -u NO_COLOR -u NODE_ENV -u ABACUS_RELEASE -u ABACUS_BUILD_COMMIT -u VITE_UI_GALLERY -u VITE_NEXT_DB_FIXTURES -u VITE_CONNECT_SRC \
  GIT_DIR="$repo/.git" GIT_WORK_TREE="$baseline_dir" node --input-type=module - "$deps_dir/node_modules/vite/dist/node/index.js" <<'JSBUILD'
import { pathToFileURL } from 'node:url';
const { createBuilder } = await import(pathToFileURL(process.argv[2]).href);
const builder = await createBuilder();
await builder.build(builder.environments.client);
JSBUILD
)
node --input-type=module - "$baseline_dir/apps/desktop/dist/renderer" <<'JS'
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
const directory = process.argv[2];
const result = { commit: '99f20795', chunks: 0, bytes: 0, gzipBytes: 0 };
for (const file of readdirSync(directory, { recursive: true }).filter(file => file.endsWith('.js'))) {
  const bytes = readFileSync(resolve(directory, file));
  result.chunks++;
  result.bytes += bytes.length;
  result.gzipBytes += gzipSync(bytes).length;
}
console.log(JSON.stringify(result, null, 2));
JS
printf 'Source archive: %s\nDependency archive: %s\n' "$baseline_dir" "$deps_dir"
