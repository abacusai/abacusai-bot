# Security policy

AbacusAIBot is a local desktop agent with access to files, commands, browsers, devices, and connected services. This document defines the supported versions, trust boundaries, and private reporting process.

## Supported versions

| Version | Security fixes |
| --- | --- |
| Latest release | Supported |
| Earlier releases and development snapshots | Not supported |

Security fixes are released in the next available desktop version. We do not maintain backport branches.

## Report a vulnerability

Use [GitHub private vulnerability reporting](https://github.com/abacusai/abacusai-bot/security/advisories/new). If that form is unavailable, email [support@abacus.ai](mailto:support@abacus.ai).

Do not open a public issue for an unpatched vulnerability. Do not include API keys, credentials, private conversations, or user files in a report.

Include:

- a concise description of the vulnerability and its impact;
- the affected release or commit, operating system, and architecture;
- exact reproduction steps or a minimal proof of concept;
- the expected security boundary and how it was crossed;
- the permission mode, model provider, and relevant connector or backend; and
- any conditions required for exploitation.

We may ask you to validate a fix. Coordinate public disclosure with the maintainers so users have time to update.

## Trust model

AbacusAIBot runs as the signed-in operating-system user. Anything that user can access may be reachable by the application after approval or when permissions are bypassed.

- **Supervised sessions:** Default and Auto-Accept modes ask before defined consequential actions. Approval prompts reduce accidental actions but are not an isolation boundary.
- **Bots and routines:** Bot chats and routine runs use full tool permissions without the session mode picker. They run as the operating-system user. Routine instructions name their own folder and every workspace registered in the app, but Bypass mode can reach other user-accessible paths.
- **Command sandbox:** On supported macOS and Linux systems, the optional command sandbox limits shell writes outside allowed paths. It does not confine reads or network access. It is disabled in Bypass Permissions mode. Windows commands are not kernel-confined.
- **Renderer boundary:** The renderer has no direct Node.js access. Privileged work passes through the preload and main-process IPC boundary.
- **Remote requests:** WhatsApp, Telegram, Discord, and the shared Abacus AI bots use configured sender approvals. Inbound responses are off by default. Unattended remote tools are on by default and use full permissions once inbound work is enabled. Turning that setting off makes risky tools wait for approval in the desktop app.
- **Extensions and services:** Skills, MCP servers, model providers, messaging platforms, and other connectors are separate trust domains. Review their code, configuration, and data policies before enabling them.
- **Model output:** Web pages, files, tool results, and messages may contain hostile instructions. Model behavior is untrusted until a permission boundary enforces or a user approves the resulting action.
- **Updates:** Packaged releases use platform signing and update metadata checks. Locally built or modified binaries do not carry the same release assurances.

Read [Permissions and execution](docs/permissions.md) and [Privacy and local storage](docs/privacy.md) for the user-facing controls.

## In scope

Examples of security issues include:

- bypassing a documented approval or Plan mode restriction;
- escaping the command sandbox when it is enabled and documented to apply;
- reaching privileged main-process behavior through unsafe IPC, navigation, or renderer content;
- bypassing a configured messaging sender allowlist;
- leaking credentials or private data to an unrelated destination without approval;
- bypassing release or update integrity checks;
- path traversal or unsafe file permissions in application-managed data; and
- server-side request forgery through application-managed fetch or connector boundaries.

## Out of scope

The following are not vulnerabilities on their own:

- incorrect, low-quality, or unsafe model output that does not cross a security boundary;
- an action the user explicitly approved or allowed through Bypass Permissions;
- actions performed within the documented full-access behavior of a bot chat or routine run;
- behavior performed by a skill, MCP server, provider, or connector the user chose to trust;
- unrestricted Windows command execution already described in the product documentation;
- access gained through a compromised operating-system account, provider account, or third-party service;
- modified, unsigned, or unofficial builds; and
- issues that affect only an unsupported release and are fixed in the latest release.

If an issue falls outside this policy but causes a reproducible product defect, use the [bug report form](https://github.com/abacusai/abacusai-bot/issues/new?template=bug_report.yml).
