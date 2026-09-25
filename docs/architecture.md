# Architecture

The repository contains the Electron desktop app, its private agent process, an
update tool, shared configuration, and test support.

```text
apps/desktop/src/main/       Electron main process and host services
apps/desktop/src/preload/    typed IPC bridge
apps/desktop/src/renderer/   React interface
apps/desktop/src/shared/     contracts shared by main and renderer
apps/updater/                release and experience-update tooling
packages/agent/              model loop, tools, permissions, and harness
packages/config/             shared build and lint configuration
packages/test-support/       test doubles used by agent suites
```

## Runtime processes

The desktop uses three process roles:

1. Electron main owns files, Git, terminals, devices, network services, updates,
   and agent lifetimes.
2. The Chromium renderer displays the interface. It has no direct Node or file
   access and calls main through preload.
3. Main starts one agent child process for each live session. The child exchanges
   newline-delimited JSON events and commands with main over standard I/O.

The child-process boundary lets the app cancel or restart an agent without
sharing Electron's heap or event loop. The protocol is internal and may change
between releases.

## Main-process services

`apps/desktop/src/main/service-host.ts` composes services. The directories under
`services/` group them by owner:

| Directory | Responsibility |
| --- | --- |
| `session/` | Agent processes, turns, transcripts, and delivery |
| `workspace/` | Files, Git, search, terminals, and workspace skills |
| `browser/` | Browser runtimes, pages, and snapshots |
| `device/` | Android and iOS discovery, control, and streams |
| `mcp/` | User MCP servers and app-owned MCP tools |
| `messaging/` | WhatsApp, Telegram, Discord, and remote-turn routing |
| `providers/` | Models, usage data, and execution backends |
| `updates/` | Signed foundation and TUF-verified experience updates |
| `voice/` | Speech model files and microphone access for dictation |
| `config/` | Settings, credentials, and agent environment |
| `agent-tools/`, `pptx/` | Host implementations for specialist tools |

The renderer uses TanStack Query for snapshots owned by main and Zustand for
local interface state. Conversation state is reduced from the agent event
stream. Browser views, terminal processes, and device streams remain owned by
main so switching routes does not destroy them.

## State ownership

- Main writes persistent app data under the configured AbacusAI Bot home.
- Electron Store holds main-process preferences and window state.
- Renderer local storage holds disposable interface preferences.
- Main memory holds live services and runtimes that disappear on restart.
- The agent child owns the active model loop and its in-memory conversation.

See [privacy and local data](privacy.md) for paths visible to users.

## Testing

Desktop tests have separate main, shared, and renderer projects. Main-process
logic should run in Node tests without launching Electron. Agent end-to-end
tests build and start the NDJSON host. Tests that spawn processes or bind ports
run serially where required.

Start with `apps/desktop/src/shared/agent-types.ts`,
`apps/desktop/src/main/service-host.ts`, and `packages/agent/src/session.ts` when
tracing a request through the system.
