# Troubleshooting

## The source build does not start

Use Node.js 22 or later and rerun `pnpm install`. Electron, native search tools,
Android mirroring, and messaging assets download during setup. A proxy or an
offline connection can leave one of them missing.

If pnpm blocks a newly added dependency script, review it before adding the
package to `allowBuilds` in `pnpm-workspace.yaml`.

## A provider or model is unavailable

Check Settings, then Models. A non-empty environment variable overrides the key
saved in the app, so an old shell value can shadow a newer saved key. Provider
quotas and model catalogs can also change independently of an app release.

## The agent cannot use a tool

Check the tool group on the Capabilities page. Most built-in tool changes need a
new agent process. Start a new session or relaunch when the page asks for it.

## A turn appears stuck

Look for a permission request in the conversation. The model loop pauses inside
the tool call until you answer or the request expires. Also check background
processes and MCP logs for a tool that is still running.

## Shell commands on Windows

`bash` on Windows runs in a POSIX shell the app ships (busybox-w32's ash), so
pipes, redirects, heredocs and the usual coreutils work without Git Bash or
WSL. It is not GNU bash: arrays and `**` globs are missing, and busybox's
tools lack some GNU flags. Paths are native Windows paths, written with
forward slashes. Installed programs on PATH — node, python, git, `npm.cmd` —
run as themselves. The shell is installed on first use under
`%LOCALAPPDATA%\abacusai-bot\posix-shell`; delete that directory to reset it.

## Docker execution fails

Run `docker info` and confirm that the daemon is available through the same
login shell that launched the app. Docker execution is not available on
Windows. If Docker becomes unavailable, the app selects local execution and
shows that change in the Capabilities page.

## Browser or device control is unavailable

Browser control needs an active browser view for the session. Device control
must be enabled and requires Android platform tools or Xcode. Confirm that the
emulator or simulator is already booted and visible on the Devices page.

## Collect diagnostics

Open Settings, then About, then Dump logs. Review the archive and remove
credentials, prompts, paths, and private file content before sharing it.

The app also automatically sends transcripts, logs, and diagnostic snapshots
to Abacus.AI for troubleshooting and product improvement when an Abacus.AI key
is saved. Exporting an archive is a separate action. See [Privacy](privacy.md).
