# Headless host

`@abacus-ai/host` composes the desktop's main services under Node, without Electron.
The supervisor supplies `ABACUSAI_BOT_HOST_OWNER`, `ABACUSAI_BOT_HOST_ORG`,
`ABACUSAI_BOT_HOST_SECRET_FILE`, and `ABACUSAI_BOT_HOST_ORIGINS`. The secret file
contains exactly 64 lowercase hexadecimal UTF-8 characters, without a newline;
the host only reads it. Production origins follow the same-origin deployment amendment (`https://apps.abacus.ai`).
`ABACUSAI_BOT_HOST_PORT` defaults to 7777. `ABACUSAI_BOT_ABACUS_HOST` selects an
HTTPS Abacus endpoint for staging. The entry removes the pod's `ABACUS_API_KEY`
before importing services.

Build and independently verify a Linux bundle from the repository root:

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
pnpm --filter @abacus-ai/host bundle
node apps/host/scripts/verify-host-bundle.mjs apps/host/dist/host-linux-x64.tar.gz
```

The bundle script uses the current Linux architecture (x64 or arm64), downloads
SHA256-pinned Node 22.22.0, and verifies native dependencies and an actual host
before succeeding. Extract with `--strip-components=1`; run
`bin/abacusai-bot-host`, or pass `--verify` to check the installed runtime.
The wrapper supplies `ABACUSAI_BOT_RESOURCES`. Persistent host workspace metadata
lives in `<botHome>/host-userdata`, separately from `<botHome>/config.json`.
With the same identity environment, `pnpm --filter @abacus-ai/host dev` builds,
verifies and extracts a fresh bundle, starts its wrapper, and removes the
extracted runtime on exit; it forwards arguments such as `--verify`.

## Local browser against the host

The development proxy terminates HTTPS, injects the owner, Origin and short-lived
HMAC credentials for HTTP and WebSocket requests, and supplies local responses
for the four host bootstrap/lease services. Other API requests, including the
real web credential handoff, go to the configured apps origin. It requires Node,
OpenSSL, Chromium and permission to bind local port 443. This proxy is a local
development tool and must not be exposed to other machines.

From the repository root, after building the bundle above, configure a temporary
home and extract it. Keep these environment variables in each of the host and
proxy terminals:

```bash
export ABACUSAI_BOT_HOME="$(mktemp -d /tmp/abacus-host-dev.XXXXXX)"
export ABACUSAI_BOT_HOST_OWNER=local-owner
export ABACUSAI_BOT_HOST_ORG=local-org
export ABACUSAI_BOT_HOST_ORIGINS=https://apps.abacus.ai
export ABACUSAI_BOT_HOST_SECRET_FILE="$ABACUSAI_BOT_HOME/host-secret"
umask 077
openssl rand -hex 32 | tr -d '\n' > "$ABACUSAI_BOT_HOST_SECRET_FILE"
mkdir "$ABACUSAI_BOT_HOME/runtime"
tar -xzf apps/host/dist/host-linux-x64.tar.gz \
  --strip-components=1 -C "$ABACUSAI_BOT_HOME/runtime"
"$ABACUSAI_BOT_HOME/runtime/bin/abacusai-bot-host"
```

In a second terminal, start Vite:

```bash
export PATH="$(npm prefix -g)/bin:$PATH"
pnpm --filter @abacus-ai/web exec vite --host 127.0.0.1 --port 5173
```

In a third terminal with the same host identity and secret-file environment:

```bash
node apps/host/scripts/dev-proxy.mjs
```

Launch Chromium with a temporary browser profile, a DNS mapping for both local
origins, and the proxy's temporary self-signed certificate:

```bash
chromium --user-data-dir="$(mktemp -d /tmp/abacus-host-browser.XXXXXX)" \
  --ignore-certificate-errors \
  --host-resolver-rules="MAP apps.abacus.ai 127.0.0.1, MAP local.preview.apps.abacus.ai 127.0.0.1" \
  https://apps.abacus.ai/bot/
```

`/bot/` is the same-origin deployment entry.
For staging, set `ABACUSAI_BOT_HOST_ORIGINS=https://staging-apps.abacus.ai` and
`ABACUSAI_BOT_ABACUS_HOST=https://staging-apps.abacus.ai` in host/proxy terminals,
set `VITE_ABACUS_ENV=staging` in the Vite terminal, and map/open
`staging-apps.abacus.ai` in the browser command. The browser needs a valid apps
login to complete the real handoff. The proxy does not fake an LLM credential.

`HOST_PROXY_TARGET`, `HOST_PROXY_VITE` and `HOST_PROXY_PORT` override the proxy's
upstream endpoints and listening port. A nonstandard port also changes the
allowed Origin and browser URL; set them consistently.

## Files and socket limits

`GET /files?hostRoot=<workspace>&path=<file>` streams downloads without the
WebSocket size limit. It uses the same Bearer connect token, exact Origin and
proxy owner checks as uploads. `/upload` requires
`workspaceId` and `sessionId`, resolves the session workspace on the server,
ignores `baseFolder`, and gives attachment names unique prefixes.

Host RPC replies and iterator snapshots are capped below 1 MiB and return the
defined `PAYLOAD_TOO_LARGE` error with an HTTP alternative. The transport also
closes any oversized frame with 1009. These limits do not apply to desktop
MessagePorts. Host behavior is selected at build time; the runtime
`ABACUSAI_BOT_HOST_MODE` environment variable cannot change desktop behavior.


Whisper models use `GET /files?whisperUrl=<encoded-original-model-url>` with the
same authentication. Only URLs under
`https://huggingface.co/onnx-community/whisper-base/resolve/main/` are accepted.
The host downloads missing files asynchronously to its model cache, emits
`voice.whisper.progress`, and streams cached bytes with `Content-Length`.
`voice.whisper.fetch` is `UNSUPPORTED` on web hosts; desktop RPC stays available.

PR 1 renderer follow-up: fetch `${host.origin}/files?...` with
`Authorization: Bearer <connect-token>` (the proxy supplies identity headers).
Consume bytes as a Blob/ArrayBuffer for `files.readImageAsDataUrl`, `files.readPptx`,
large transcript exports and Whisper's model fetch hook. Build query strings
with `URLSearchParams`; use the typed error's `data.alternative` for file RPC
fallbacks and `whisperUrl` for model URLs. Render image Blob URLs and revoke them
when disposed; parse deck bytes and transcript text in the renderer. Handle
`PAYLOAD_TOO_LARGE` explicitly, preserving the connection and offering a download
or retry through the HTTP route. Snapshot replies without an exported file still
need paging/chunking; their placeholder alternative is not a ready download.
