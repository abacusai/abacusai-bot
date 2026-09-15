# Bots, routines, and messaging

Bots are the main unit of ongoing work in AbacusAIBot. You can chat with one in
the desktop app or reach it through WhatsApp, Telegram, and Discord. A routine
wakes it on a schedule or through a webhook. Sessions remain available for
one-off work you supervise directly.

## Bots

A bot has a name, mission, persona, model, memory, and persistent chat. It uses
the capabilities enabled in the app. Its chat runs in the app-managed bot
directory. Bots can create and manage their own routines when their tools allow
it.

A bot chat runs with full tool permissions and has no session mode picker.
Review its instructions, model, capabilities, and connected services before
giving it work. Deleting a bot removes its bot-managed sender
conversations. Routines remain visible until you delete them, but no longer
name the deleted bot as their creator.

## Routines

A routine wakes a bot on a schedule or when its webhook receives a request.
Each run gets its own conversation record. You can disable, rename, edit, or
delete the routine from the Routines page.

Routine runs use full permissions as the operating-system user. Their
instructions name the routine folder and every workspace registered in the app.
Creating a routine fires its first run unless the creation flow says otherwise.

Scheduled times use the local configuration shown in the app. A sleeping or
closed desktop cannot run local work. With an Abacus.AI key, webhook routines
get public URLs through Abacus.AI's relay. The relay receives and queues
payloads; the desktop app polls for them and runs the routine locally.

Triggers skip a routine while a run is active. Runs stop after 30 minutes, and
three consecutive failed runs pause the routine. Inspect its run history
before resuming it.

## Messaging

WhatsApp, Telegram, and Discord can carry bot messages. Slack is a service
connector and exposes Slack tools, but it is not a messaging transport in this
part of the app.

By default, a connected messaging account records incoming messages and allows
agent-initiated reads and sends. Incoming messages do not start an agent turn.
Enable responses to incoming messages and approve senders to let a bot answer
them.

When messaging delivers to a bot, each approved sender gets a separate
conversation under that bot. Messages written in that conversation go to the
sender. The bot's private setup chat does not. Without a bot assignment, each
sender gets a standalone remote session.

The "Run remote turns unattended" setting is on by default. Once inbound
responses are enabled, approved senders can use any tool on the machine. Turn
the setting off to run remote conversations in Auto-Accept mode. File edits in
the selected workspace proceed, while risky tools wait for approval in the
desktop app. Configure the workspace, sender list, and this setting before
relying on remote access.

### WhatsApp

WhatsApp opens WhatsApp Web in a separate app partition and asks you to scan its
QR code. The agent acts as the linked account. Messages look like messages sent
by that account.

The connector waits for the service acknowledgement before reporting a send as
successful. If the bundled bridge cannot attach after a WhatsApp Web change, it
falls back to browser control. Automating a personal account may conflict with
WhatsApp's terms. Use a separate account if that risk is unacceptable.

### Telegram

Telegram opens its web app for sign-in and keeps the session in a separate app
partition. The connected account reads its chats and messages other people.
Messages to you arrive from the shared Abacus AI bot, which the setup links as
well; that bot is also how you reach the agent from another device. The app
does not create a Telegram bot of its own.

### Discord

Discord uses its web sign-in flow and keeps the connected session in a separate
app partition. Approved incoming conversations can reach a bot when remote
responses are enabled. The shared Abacus AI bot provides the direct-message
route back to your agent.

## Files and recipients

Messaging tools can read attachments into the active workspace and send files
produced by the agent. Recipient resolution uses the contacts and conversations
visible to the connected account. If a name matches more than one recipient,
the tool asks for a more specific target rather than guessing.

Messaging activity can appear in transcripts and logs uploaded to Abacus.AI.
Shared bot traffic also passes through Abacus.AI's messaging service. See
[Privacy](privacy.md).
