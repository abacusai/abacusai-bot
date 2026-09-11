# Getting started

## Download

Official builds are published on the
[releases page](https://github.com/abacusai/abacusai-bot/releases).

| Platform | File |
| --- | --- |
| macOS, Apple Silicon | `abacusai-bot-<version>-arm64.dmg` |
| macOS, Intel | `abacusai-bot-<version>-x64.dmg` |
| Windows, x64 | `abacusai-bot-<version>-x64-setup.exe` |
| Windows, ARM64 | `abacusai-bot-<version>-arm64-setup.exe` |
| Linux, x64 or ARM64 | AppImage or DEB for the matching architecture |

macOS builds are notarized and Windows builds are signed. Installed builds
download updates in the background and offer to relaunch when an update is
ready.

## First run

On a fresh install, onboarding:

1. Opens Abacus.AI sign-in or free account creation in your browser. The app
   receives its own API key and never receives your password.
2. Offers WhatsApp, Telegram, Discord, Gmail, and the rest of the connector
   catalog. You can skip every connector and add one later.
3. Shows the free model options. A free Abacus.AI account starts with 2,000
   credits and a selection of free models. OpenRouter and Google AI Studio add
   other free options. Paid plans skip this screen because their model catalog
   is already available.
4. Opens a guided tour of Bots, Connectors, Capabilities, Routines, Memory,
   Artifacts, Changes, and permissions.
5. Creates a Chief of Staff bot when the install has no bots. You can edit or
   delete it like any other bot. Its template contains a weekday-morning job.
   When the bot's first chat starts, it may create that routine. A routine
   created by a bot runs once immediately.

The app automatically uploads transcripts, logs, and diagnostics to Abacus.AI
for product improvement and troubleshooting when an Abacus.AI key is saved.
See [Privacy](privacy.md) for upload contents and redaction limits.

Keys can also come from the environment. Environment values take precedence
over keys saved by the app.

```bash
export ANTHROPIC_API_KEY=... # or OPENAI_API_KEY, OPENROUTER_API_KEY, GEMINI_API_KEY
```

The app creates an empty default workspace for the tour and bot chats. A
supervised session can use another folder. Read [permissions](permissions.md)
before using Auto-Accept, Bypass, bots, routines, or unattended remote work.

## Create and connect a bot

Open Bots, choose a template or name a bot, then edit its instructions and
persona. More options set its model and scheduled check-in. The bot keeps its
own chat, memory, app-managed folder, and model. It uses the capabilities
enabled in the app. Bot chats run with full tool permissions and do not have
the session mode picker.

Open Connectors to add WhatsApp, Telegram, Discord, service accounts, or MCP
servers. The built-in Abacus.AI flow connects services such as Gmail, Drive,
Calendar, Slack, Outlook, Jira, and Confluence in the browser. A bot may ask for
a missing connector while it works.

WhatsApp, Telegram, and Discord let you reach a bot from another device. Merely
connecting a messaging account does not start automatic replies. Choose the
bot, enable responses, and approve senders first. Remote tool calls cannot show
an approval dialog to the sender. Unattended remote tools are on by default and
run with full permissions once inbound responses are enabled. Turn that setting
off if risky tools should wait for approval in the desktop app. Read [Bots,
routines, and messaging](messaging.md) before enabling them.

## Main areas

- Bots are standing agents with their own instructions, model, memory, folder,
  and chats.
- Connectors link messaging apps, work services, model providers, and MCP
  servers.
- Routines run bots on a schedule, on demand, or through a webhook.
- Capabilities controls built-in tools and installed skills.
- Sessions handle one-off supervised work.
- Usage groups local token and cost records by day and model.

## Build from source

You need Git, Node.js 22 or later, and pnpm through Corepack.

```bash
git clone https://github.com/abacusai/abacusai-bot.git
cd abacusai-bot
corepack enable
pnpm install
pnpm dev
```

The first run downloads pinned native search tools plus assets used for Android
mirroring and messaging. An offline or filtered connection can stop that setup.
Run `pnpm install` again after restoring access.

Build the workspace before packaging a desktop application:

```bash
pnpm build
pnpm --filter @abacus-ai/desktop package:win # or package:mac, package:linux
pnpm --filter @abacus-ai/desktop check:packaged
```

Local packages are unsigned. The packaging step generates third-party notices
and includes them beside the app license.
