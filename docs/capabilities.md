# Capabilities

The Capabilities page controls the tools and instructions available to an
agent. A disabled tool group is left out of the model's tool list.

Most sessions start with workspace files, terminal and process control, task
planning, browser automation, web access, deliverables, memory, skills,
delegation, and document tools enabled. Device control, media generation, smart
home access, and other tools that need extra software or credentials start off.
The page in the installed app shows the current defaults.

Most built-in tool changes apply when the next agent process starts. Memory,
skills, task planning, web search, MCP, and newly connected services can refresh
in a running session.

## Browser and web

Browser automation opens pages in the app, reads rendered content, clicks,
types, and captures screenshots. A browser task runs in a separate agent and
returns a report to the parent conversation. Its browser remains attached to
the conversation that created it.

Web search uses a configured model provider or a dedicated search backend.
`web_fetch` reads an HTTP or HTTPS URL and rejects embedded credentials,
link-local addresses, oversized responses, unsupported binary data, and
cross-origin redirects. Localhost remains available for testing a local server.

X search reads X's own index through your Abacus.AI account, billed per
request. Without an Abacus.AI key it uses a configured web-search provider and
restricts results to X domains.

## Devices

Device tools can build, install, launch, inspect, tap, type, and capture Android
apps and iOS apps. Android requires the platform tools and an emulator or
device. iOS requires macOS, Xcode, and a simulator. This group starts disabled.

## Files and deliverables

File tools read, search, create, and edit workspace files. Document, deck,
design, image, audio, and video tools may start specialist agents or call a
configured generation provider. Completed files appear as links and in the
Artifacts view.

Generation tools do not reuse a model key unless their implementation supports
that provider. The Capabilities page names missing credentials.

## Memory and instructions

Memory contains entries the agent saves about its work and about the user. You
can inspect and delete each entry. New memory reaches future agent processes,
not the middle of the current model turn.

Custom instructions live in `~/.abacusai-bot/INSTRUCTIONS.md`. They are appended
to each conversation prompt and take effect on the next message. They affect
agent behavior, not permission enforcement.

## Skills

A skill is a directory with a `SKILL.md` procedure and optional supporting
files. Store a project skill in `<workspace>/.abacusai-bot/skills/` and commit it
with the project. Store a personal skill in `~/.abacusai-bot/skills/` to make it
available in every workspace.

The app can install skills from skills.sh or add one from a URL. Review a skill
before installing it. Its instructions become part of the agent's operating
rules, and included scripts can run with the agent's permissions.

## MCP

Add a Model Context Protocol server from the MCP section or import a compatible
configuration. The page shows the server's tools, connection state, and logs.
Changes refresh active sessions when the agent supports a live refresh.

Treat an MCP server like installed software. It can receive tool input and can
return instructions or content that affects the model's next action.

## Service connectors

Connectors add tools for external accounts. Some store an API key locally. The
Abacus.AI connector flow opens the provider's site and keeps the service token
in the Abacus.AI account. The local MCP configuration refers to the saved key by
name rather than copying it into the file.

Connecting a service does not grant the agent permission to use every action
without review. The session mode and each tool's permission rule still apply.
