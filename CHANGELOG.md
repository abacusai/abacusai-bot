# Changelog

<!-- One section per version: `## 1.0.62 — 2026-09-09`. Write freely under
     it — prose, ### headings, bullets. Notes for the next release go under
     `## Unreleased`. Sections here are kept as written; a release nobody
     wrote up says "Bug fixes, improvements in quality and speed." -->

## Unreleased

A routine set up for a folder now runs entirely inside it: the prompt names
that folder as the working directory, and the routine's own notes and run
history live inside it too (under `.abacusai-bot/routines/`, ignored by git)
instead of in the app's home. Before, the prompt pointed the model at the
app's folder and its output landed there.

Under Full access the file tools no longer refuse a path outside the
workspace, and a folder the app pre-allows (a routine's own) is never
refused. The refusal only sent the model to the shell, which is not fenced.

Every connector on the Connectors page can be connected from the chat: ask
the agent for one and it puts up the Connect button, whether that is an
account connector, GitHub (the button opens the same personal-access-token
dialog as the GitHub card), a chat app, or a tool server such as Playwright,
Notion or Hugging Face. Before, the agent knew only a hand-kept few by name
and answered "Playwright isn't a connector" for the rest; now one registry
lists them all, and every screen — Connectors, onboarding, the chat card and
the MCP summary — reads which are connected from the same place.

A file link written with `~`, such as a screenshot on the Desktop, now opens
in the preview pane's file reader instead of reporting the file missing. A
file outside the workspace says so, rather than "not found". A link whose
name has spaces, which markdown writes as `%20`, opens too: the preview was
asking for a file literally named with the escapes. And a file whose name the
agent transcribed with an ordinary space where the disk has an invisible one
(macOS screenshots have a narrow no-break space before "AM") now opens, where
before every screenshot link the agent wrote reported the file missing. The
files card finds such a file the same way, and lists it under its real name.

The Capabilities page now lists `disconnect_connector` under Connectors, with
a description for both connector tools.

When the sandbox refuses something a command tried, a card now lists it and
"Allow" runs the command again with that access, instead of the agent working
around the refusal. Google Fonts is on the allow list, and Node tools are told
to use the proxy.

The kernel sandbox is now on by default and applies in Bypass mode too, which
the app starts in; Settings > Capabilities switches it off. Bypass still asks
about a hidden credential store a command names and a host not on the allow
list.

On macOS and Linux the kernel sandbox now runs on Anthropic's sandbox
runtime. A sandboxed command's outbound connections go through its proxies:
package registries and code hosts are allowed, any other host asks first and
the connection waits for the answer. `ABACUSAI_BOT_SANDBOX_HOSTS` pre-approves
hosts. Linux needs `bubblewrap` and `socat`.

The kernel sandbox now runs on Windows 11 24H2 and newer, through a Microsoft
process container. The Settings toggle says so on an older Windows instead of
claiming the whole platform is unsupported.

The kernel sandbox now hides credential stores from shell commands: SSH and
GPG private keys, cloud CLI credential caches, browser profiles, the macOS
keychain files and the app's own settings. Configuration beside them stays
readable. A command that names one of the developer stores asks first, and
the approval card lists the paths; "Always" keeps them readable for the
session. `ABACUSAI_BOT_SANDBOX_READABLE` exempts a path without a prompt.

Telegram no longer creates an assistant bot of its own through BotFather.
Messages to you arrive from the shared Abacus AI bot, which the Telegram setup
links; the connected account still reads chats and messages other people. The
optional bot-token field is gone, and a token the app minted earlier is removed
from disk on the next launch. Sending files on Telegram is not available for
now.

## 1.0.61 — 2026-09-08

Bug fixes, improvements in quality and speed.

## 1.0.60 — 2026-09-07

Bug fixes, improvements in quality and speed.

## 1.0.59 — 2026-09-07

Bug fixes, improvements in quality and speed.

## 1.0.58 — 2026-09-04

Bug fixes, improvements in quality and speed.

## 1.0.57 — 2026-09-04

Bug fixes, improvements in quality and speed.

## 1.0.55 — 2026-09-03

Bug fixes, improvements in quality and speed.

## 1.0.54 — 2026-09-03

Bug fixes, improvements in quality and speed.

## 1.0.53 — 2026-09-02

Bug fixes, improvements in quality and speed.

## 1.0.52 — 2026-09-02

Bug fixes, improvements in quality and speed.

## 1.0.51 — 2026-09-02

Bug fixes, improvements in quality and speed.

## 1.0.49 — 2026-09-02

Bug fixes, improvements in quality and speed.

## 1.0.48 — 2026-09-02

Bug fixes, improvements in quality and speed.

## 1.0.47 — 2026-09-02

Bug fixes, improvements in quality and speed.

## 1.0.46 — 2026-09-01

Bug fixes, improvements in quality and speed.

## 1.0.45 — 2026-09-01

Bug fixes, improvements in quality and speed.

## 1.0.44 — 2026-09-01

Bug fixes, improvements in quality and speed.

## 1.0.43 — 2026-09-01

Bug fixes, improvements in quality and speed.

## 1.0.42 — 2026-09-01

Bug fixes, improvements in quality and speed.

## 1.0.41 — 2026-09-01

Bug fixes, improvements in quality and speed.

## 1.0.40 — 2026-09-01

Bug fixes, improvements in quality and speed.

## 1.0.39 — 2026-08-31

Bug fixes, improvements in quality and speed.

## 1.0.38 — 2026-08-31

Bug fixes, improvements in quality and speed.

## 1.0.37 — 2026-08-31

Bug fixes, improvements in quality and speed.

## 1.0.36 — 2026-08-31

Bug fixes, improvements in quality and speed.

## 1.0.35 — 2026-08-31

Bug fixes, improvements in quality and speed.

## 1.0.32 — 2026-08-31

Bug fixes, improvements in quality and speed.

## 1.0.31 — 2026-08-31

Bug fixes, improvements in quality and speed.

## 1.0.30 — 2026-08-31

Bug fixes, improvements in quality and speed.

## 1.0.29 — 2026-08-31

Bug fixes, improvements in quality and speed.

## 1.0.28 — 2026-08-31

Bug fixes, improvements in quality and speed.

## 1.0.27 — 2026-08-31

Bug fixes, improvements in quality and speed.

## 1.0.26 — 2026-08-31

Bug fixes, improvements in quality and speed.

## 1.0.25 — 2026-08-28

Bug fixes, improvements in quality and speed.

## 1.0.24 — 2026-08-28

Bug fixes, improvements in quality and speed.

## 1.0.23 — 2026-08-28

Bug fixes, improvements in quality and speed.

## 1.0.22 — 2026-08-28

Bug fixes, improvements in quality and speed.

## 1.0.20 — 2026-08-28

Bug fixes, improvements in quality and speed.

## 1.0.19 — 2026-08-27

Bug fixes, improvements in quality and speed.

## 1.0.18 — 2026-08-27

Bug fixes, improvements in quality and speed.

## 1.0.15 — 2026-08-27

Bug fixes, improvements in quality and speed.

## 1.0.14 — 2026-08-26

Bug fixes, improvements in quality and speed.

## 1.0.13 — 2026-08-25

Bug fixes, improvements in quality and speed.

## 1.0.12 — 2026-08-25

Bug fixes, improvements in quality and speed.

## 1.0.10 — 2026-08-24

Bug fixes, improvements in quality and speed.

## 1.0.9 — 2026-08-24

Bug fixes, improvements in quality and speed.

## 1.0.8 — 2026-08-23

Bug fixes, improvements in quality and speed.

## 1.0.7 — 2026-08-21

Bug fixes, improvements in quality and speed.

## 1.0.6 — 2026-08-21

Bug fixes, improvements in quality and speed.

## 1.0.5 — 2026-08-21

Bug fixes, improvements in quality and speed.

## 1.0.4 — 2026-08-21

Bug fixes, improvements in quality and speed.

## 1.0.3 — 2026-08-21

Bug fixes, improvements in quality and speed.

## 1.0.0 — 2026-08-19

Bug fixes, improvements in quality and speed.
