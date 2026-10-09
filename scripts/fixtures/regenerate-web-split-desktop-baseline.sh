#!/usr/bin/env bash
set -euo pipefail
# Isolated archives only; never creates or changes a worktree.
#
# Usage: regenerate-web-split-desktop-baseline.sh [source] [deps] [lock-sha256]
# Defaults are the recorded baseline (web-split-desktop-baseline.md): the
# source commit's renderer, built against a fresh frozen-lockfile install of
# the deps commit, whose pnpm-lock.yaml must hash to lock-sha256.
source_commit=${1:-4f71c036}
deps_commit=${2:-$source_commit}
lock_sha=${3:-b43c9084a743b0d1ced0ba0b349a342bf694708fbcc19f27ba5a504a72fead73}
repo=$(git rev-parse --show-toplevel)
git_dir=$(git rev-parse --absolute-git-dir)
baseline_dir=$(mktemp -d /tmp/web-split-baseline.XXXXXX)
deps_dir=$(mktemp -d /tmp/web-split-baseline-deps.XXXXXX)
git -C "$repo" archive "$source_commit" | tar -x -C "$baseline_dir"
git -C "$repo" archive "$deps_commit" | tar -x -C "$deps_dir"
printf '%s  %s\n' "$lock_sha" "$deps_dir/pnpm-lock.yaml" | sha256sum -c -
# Archives have no .git directory; installing repository hooks cannot work here.
# Keep dependency lifecycle scripts enabled for the native build tools.
node --input-type=module - "$deps_dir/package.json" <<'JS'
import { readFileSync, writeFileSync } from 'node:fs';
const path = process.argv[2];
const manifest = JSON.parse(readFileSync(path, 'utf8'));
delete manifest.scripts.prepare;
writeFileSync(path, JSON.stringify(manifest, null, 2) + '\n');
JS
(cd "$deps_dir" && env -u NODE_ENV -u CI pnpm install --frozen-lockfile && pnpm --filter @abacus-ai/connectors build && env -u ABACUS_RELEASE -u ABACUS_BUILD_COMMIT GIT_DIR="$git_dir" GIT_WORK_TREE="$deps_dir" pnpm --filter @abacus-ai/agent build)
ln -s "$deps_dir/node_modules" "$baseline_dir/node_modules"
for workspace in apps/desktop apps/web apps/updater packages/agent packages/contract packages/connectors packages/config packages/test-support; do
  if [ -d "$deps_dir/$workspace/node_modules" ] && [ ! -e "$baseline_dir/$workspace/node_modules" ]; then
    ln -s "$deps_dir/$workspace/node_modules" "$baseline_dir/$workspace/node_modules"
  fi
done
# Keep real repository provenance while all build writes go to the archive.
(cd "$baseline_dir/apps/desktop" && env -u NO_COLOR -u NODE_ENV -u ABACUS_RELEASE -u ABACUS_BUILD_COMMIT -u VITE_UI_GALLERY -u VITE_NEXT_DB_FIXTURES -u VITE_CONNECT_SRC \
  GIT_DIR="$git_dir" GIT_WORK_TREE="$baseline_dir" node --input-type=module - "$deps_dir/node_modules/vite/dist/node/index.js" <<'JSBUILD'
import { pathToFileURL } from 'node:url';
const { createBuilder } = await import(pathToFileURL(process.argv[2]).href);
const builder = await createBuilder();
await builder.build(builder.environments.client);
JSBUILD
)
node --input-type=module - "$baseline_dir/apps/desktop/dist/renderer" "$source_commit" <<'JS'
import { readFileSync, readdirSync } from 'node:fs';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
const directory = process.argv[2];
const result = { commit: process.argv[3], chunks: 0, bytes: 0, gzipBytes: 0 };
for (const file of readdirSync(directory, { recursive: true }).filter(file => file.endsWith('.js'))) {
  const bytes = readFileSync(resolve(directory, file));
  result.chunks++;
  result.bytes += bytes.length;
  result.gzipBytes += gzipSync(bytes).length;
}
console.log(JSON.stringify(result, null, 2));
JS
printf 'Source archive: %s\nDependency archive: %s\n' "$baseline_dir" "$deps_dir"
