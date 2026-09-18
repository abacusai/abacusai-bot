# Permissions and command execution

Supervised sessions have a permission mode. A session keeps its mode when you
move between conversations.

| Mode        | File changes               | Shell commands                          |
| ----------- | -------------------------- | --------------------------------------- |
| Default     | Ask first                  | Ask first, inside the sandbox           |
| Auto-Accept | Apply inside the workspace | Ask first, inside the sandbox           |
| Plan        | Refuse                     | Refuse                                  |
| Auto        | Apply without asking       | Run without asking, inside the sandbox  |
| Full access | Apply without asking       | Run without asking, with no sandbox     |

Plan mode is read-only. The agent can inspect files and prepare a plan, but its
tools reject mutations. Auto and Full access remove the approval gate and
should only be used when the workspace and request are trusted. Auto keeps the
kernel sandbox: shell commands stay bounded to the workspace, credential stores
stay hidden, and the sandbox cards (a hidden store a command names, a host not
on the allow list, something the OS refused) still appear. Full access has
nothing behind it: no prompts and no sandbox. Auto is offered only on a machine
whose sandbox works (see below).

## The default mode

Every session starts in the mode the picker shows, and the picker remembers the
last choice. Bots and routines have no picker; they run in the default mode.
The default is Full access. The Profile page, under Danger zone, can change it
to Auto for new sessions, bots and routines; the picker follows. The choice is
shown only on a machine whose sandbox works.

## Bots, routines, and remote messages

Bot chats run in the default mode. They do not show the session mode picker. A
bot can use enabled tools, connected accounts, and any files available to the
operating-system user without asking for each action.

Routine runs also use the default mode. Their instructions give them the
routine folder and every workspace registered in the app. Full access can reach
other paths available to the operating-system user. New routines normally run
once when created, then follow their saved schedule or webhook trigger.

Messaging accounts record incoming messages but do not start agent turns by
default. If you enable inbound responses, only approved senders can start a
turn. "Run remote turns unattended" is on by default and gives those turns the
default mode. Turn it off to use Auto-Accept instead. Workspace edits then
proceed, while shell commands and other risky actions wait for approval in the
desktop app.

Sender approval is an access-control boundary. Review the messaging workspace,
approved senders, bot assignment, and unattended-tools setting together.

## Workspace boundary

Reads inside the workspace do not prompt. Reads and writes outside it require
approval in every mode except Auto and Full access. Auto-Accept grants write access to the
workspace, not to the rest of the machine.

Some paths remain protected from agent file tools, including `.git`, `.env`, and
`node_modules`. These checks do not make the desktop process a sandbox. The
agent may read sensitive files, and content it reads can enter the request sent
to your model provider.

## Approval behavior

An approval pauses the tool call until you allow or reject it. The app does not
run the action and roll it back later.

Approving a shell prefix can allow the same command shape later. A compound
command must pass the rule for every part. Pipes, redirects, substitutions, and
background operators force a new approval because a prefix check cannot prove
what they will do.

Delegated tasks and specialist document, design, browser, and deck tasks ask
before starting. Their agents work without access to the parent's approval
dialog. Plan mode rejects delegation.

An unanswered request is rejected after 15 minutes. Set
`ABACUSAI_BOT_APPROVAL_TIMEOUT_MS` to another duration in milliseconds, or `0`
to wait without a deadline. Sessions record requests, decisions, expirations,
and mode changes.

## Where commands run

Host execution is the default. Commands run through your login shell with the
workspace as the working directory. They have the same operating-system access
as the desktop app, subject to the permission gate and command guardrails.

Long-running commands can move to a background process. The agent receives a
process identifier and can read more output or stop the process later. Every
tool call also has a deadline, but a background process may continue after the
call that started it.

### Kernel sandbox

macOS, Linux and supported Windows versions run commands under a kernel
sandbox in every mode but Full access. macOS and Linux use Anthropic's sandbox
runtime (Seatbelt and bubblewrap, with its loopback proxies for the network);
Windows uses the bundled Sandy CLI's AppContainer with BusyBox, without an
administrator setup. Plan mode keeps the workspace read-only. Default, Auto-Accept and Auto allow
writes to the workspace and temporary directories. Full access is the one
mode with no sandbox. Bots and routines run in the default mode without a card
to answer, so in Auto a hidden store stays hidden and an unlisted host is
refused outright.

On macOS and Linux, reads are allowed everywhere except a short list of credential stores: SSH
private keys, GPG private keys, cloud CLI credential and token caches (AWS,
Google Cloud, Azure), `~/.kube/config`, `~/.docker/config.json`, `~/.netrc`,
`~/.pypirc`, browser profiles, the macOS keychain files, Windows credential
stores, and this app's own settings and browser data. Configuration beside
them stays readable, so `~/.ssh/config`, known hosts, public keys and
`~/.aws/config` still work. The ssh and gpg agent sockets stay reachable, so
`git push` and signed commits work with the keys hidden; other unix sockets
(the session bus, Docker) do not.

A command that names one of the developer stores (SSH and GPG keys, cloud
credentials, kube and docker config, `.netrc`, `.pypirc`) asks first, even
when the command itself was already allowed. The card lists the paths.
"Allow once" unhides them for that command; "Always" keeps them readable for
the rest of the session. `ABACUSAI_BOT_SANDBOX_READABLE`, a path-delimited
list where `~` expands to the home directory, exempts a path without
prompting.

On macOS and Linux, beyond the workspace and temp, a confined command may also write to the
caches and toolchains a build uses (`~/.npm`, `~/.cache`, `~/.cargo`, `~/go`,
`~/.m2`, `~/Library/Caches` and the like, where they exist).

The command's own text decides one more thing before it runs. A plainly
written command that only makes new things in the user's own folders (a file
on the Desktop, a directory beside the project, a `git clone` there) gets
those paths added to its write list for that run, and a command may change or
remove again what this session made. Nothing else is granted: deleting or
replacing something that is not the session's, appending to an existing file,
changing permissions, anything under a dotfile, `~/Library`, the system, or
another volume, and any line that cannot be read with confidence (command or
variable substitution, `eval`, `sh -c`, `xargs`, `find -exec`, an interpreter
with inline code, `sudo`, unbalanced quotes) all go to the kernel as before,
and one refused step means nothing on the line is granted. The reading is
static and can only add the literal paths the command names; a wrong reading
costs a card, never grants a write the text did not spell out. The same rule
applies to the file tools in Auto: a new file in the user's folders is
written, an edit outside the workspace asks.

When the sandbox refuses something a command tried, a write outside the
workspace, a read of a hidden store the command did not name, or a host the
proxy turned down, a card lists exactly what was refused, and says what the
command's text meant to do there ("deletes …", "replaces …"). "Allow" runs the
same command again with that access; "Always" keeps it for the session;
"Deny" leaves the refusal. The card cannot help a tool that ignores the proxy
variables, since its connection never reached the proxy; Node tools are told
to honour them (`NODE_USE_ENV_PROXY=1`, which Node 22.21 and 24 understand).

On macOS and Linux, outbound connections from a confined command go only
through the runtime's HTTP and SOCKS proxies. Package registries and code
hosts (npm, PyPI, crates.io, Go, RubyGems, Maven, GitHub, GitLab, Docker Hub,
Hugging Face, Debian and Ubuntu mirrors) are allowed without asking; any other
host raises a prompt while the connection waits. "Allow once" lets that
connection through, "Always" allows the host for the session. Connections to
loopback are direct, so a dev server the command starts still answers.
`ABACUSAI_BOT_SANDBOX_HOSTS`, a comma-separated list where `*.example.com`
allows a domain, pre-approves hosts. A tool that ignores `HTTP_PROXY`,
`HTTPS_PROXY` and `ALL_PROXY` cannot connect at all. On Windows the network is
open to internet hosts without per-host approvals. Sandy blocks LAN and
loopback access, so local development servers and local proxies do not have
the same connectivity as on macOS and Linux.

On Windows, Sandy grants access to the workspace, BusyBox, readable Git
configuration, a private temporary directory, and approved paths. System
files that Windows makes available to AppContainers remain readable.
Other user files and tool caches may need approval. Explicit absolute-path
permission-denied diagnostics can raise the existing file approval card;
ambiguous or silent failures cannot. Creating a file outside the workspace
requires approval for its existing parent directory, which the card names.
Grants that cover a protected credential store are refused instead of
silently exposing it. Git init, add and commit run inside the sandbox;
authentication helpers and signing agents may require additional access.

Each Windows command uses a temporary drive alias for the workspace so Git
can resolve its working directory without read access to the workspace's
ancestors. Use relative paths inside the workspace; changing to its original
absolute path can still fail in Git. The alias is removed when the command
finishes or is cancelled. Sandy file grants are cleaned up before an approved
retry. A missing or broken runner refuses commands in confined modes.

Linux needs `bubblewrap` and `socat` installed, and unprivileged user
namespaces with capabilities (Ubuntu 24.04 restricts them by default; see the
runtime's notes on `kernel.apparmor_restrict_unprivileged_userns`). The app
probes this once at launch. Where the sandbox cannot run, or on a Windows
older than Windows 10 1903 on x64 or Windows 11 on ARM64, Auto is not offered: the picker and the Profile
page show Full access alone, which is what such a machine has. A confined mode
picked anyway on an unsupported platform still runs its commands unconfined.
`ABACUSAI_BOT_SANDBOX=strict` refuses them instead; `off` never confines.

The sandbox applies to shell commands, including commands started by delegated
agents and verification tools. It does not confine Electron, model requests,
MCP tools, device tools, or service connectors.

### Docker

The Docker backend starts commands in a container and mounts the workspace at
the same absolute path. Docker must be installed and running. The backend is not
available on Windows because a Windows workspace path cannot be mounted at the
same path inside the Linux guest.

Local and Docker are the only implemented execution backends. If a saved Docker
choice becomes unavailable, the app uses local execution and shows the backend
currently in effect.

Permission modes control tool execution. They do not disable transcript, log,
or diagnostic uploads. See [Privacy](privacy.md).
