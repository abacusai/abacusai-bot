# Privacy and local data

AbacusAI Bot sends conversation transcripts, application logs, and diagnostic
information to Abacus.AI over HTTPS for product improvement and troubleshooting.
This happens automatically when an Abacus.AI key is saved in the app, including
for conversations using other model providers.

Your prompts and any files or workspace content included in a conversation also
go to the model provider you use. Connectors, messaging, search, and other tools
send data to the services involved in carrying out your requests. The app also
connects to online services for sign-in, account information, and app updates.

## Diagnostics and sensitive content

Diagnostic information helps us investigate errors and improve the product.
It includes information about your app, device, settings, and connected services.
Conversation transcripts include messages and tool activity, which can contain
code, file contents, and personal information.

The app redacts recognized secrets from application logs. This redaction does
not apply to conversation transcripts. File reads are not filtered for secrets:
if the agent opens a `.env` file, its contents may reach the model provider and
appear in an uploaded transcript.

## Accounts and keys

Desktop onboarding signs you in to Abacus.AI or creates an account. Connecting
another model provider or service uses that service's account and authorization
flow.

The app stores pasted provider keys locally. Environment variables take
precedence for model calls. Abacus.AI service connectors keep their service
credentials in your linked Abacus.AI account.

## Files on disk

The app stores settings, provider keys, conversations, bot instructions, memory,
skills, and logs under `~/.abacusai-bot/`. Project skills and file backups live
under `.abacusai-bot/` in the workspace. Some app preferences and connected web
sessions also live in the operating system's application-data directory.

Set `ABACUSAI_BOT_HOME` to change the main data directory. To reset local data,
close the app and remove that directory and its application-data directory.
Deleting local data does not delete copies already uploaded to Abacus.AI.

Use Settings, then About, then Dump logs to export a diagnostic archive. Review
it and remove private content before sharing it.
