# @abacus-ai/agent

The agent: the session, the tools, the permission gate and the harness that the
desktop app runs. Private to this repository and not published — the desktop
release is the only thing it ships in.

## The two entry points

**As a library.** `src/index.ts` exports the session and everything around it.
The desktop's main process imports from here.

**As a process.** `src/main.ts` is the same session wrapped in the NDJSON
protocol (see `src/host.ts`). The desktop spawns it, one per session, with the
workspace as cwd. It is a separate entry point because it is a separate
*process*, not a separate agent.

Running it standalone is the fastest way to exercise the agent without launching
Electron:

```bash
echo '{"type":"send","message":"list the files here"}' | node dist/main.js
```

An agent started that way has no MCP server and no composed config, which is a
supported state rather than a broken one — the tools that do not need a host are
registered here directly.

## Working on it

```bash
pnpm --filter @abacus-ai/agent run build       # tsdown; dist/ is what the app copies
pnpm --filter @abacus-ai/agent run vendor      # fetch the rg/fd binaries into vendor/
pnpm --filter @abacus-ai/agent run test
```

The suite is split in two: `unit` for everything pure, and `e2e` for the files
that spawn a process or bind a socket, which run one at a time. `run test:unit`
is the fast half.

`dist/` belongs to tsdown, not tsc — see the note in `tsconfig.json` before
changing what either emits.

## Documentation

- [Architecture](../../docs/architecture.md) — layout and the agent protocol
- [The harness](../../docs/harness.md) — the ten layers, and why they exist
- [Permissions and command execution](../../docs/permissions.md)
- [Capabilities](../../docs/capabilities.md) — tools, skills, MCP
