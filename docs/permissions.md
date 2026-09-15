# Permissions and command execution

Supervised sessions have a permission mode. A session keeps its mode when you
move between conversations.

| Mode        | File changes               | Shell commands     |
| ----------- | -------------------------- | ------------------ |
| Default     | Ask first                  | Ask first          |
| Auto-Accept | Apply inside the workspace | Ask first          |
| Plan        | Refuse                     | Refuse             |
| Bypass      | Apply without asking       | Run without asking |

Plan mode is read-only. The agent can inspect files and prepare a plan, but its
tools reject mutations. Bypass removes the approval gate and should only be used
when the workspace and request are trusted.

## Bots, routines, and remote messages

Bot chats run in Bypass mode. They do not show the session mode picker. A bot
can use enabled tools, connected accounts, and any files available to the
operating-system user without asking for each action.

Routine runs also use Bypass mode. Their instructions give them the routine
folder and every workspace registered in the app. Bypass can reach other paths
available to the operating-system user. New routines normally run once when
created, then follow their saved schedule or webhook trigger.

Messaging accounts record incoming messages but do not start agent turns by
default. If you enable inbound responses, only approved senders can start a
turn. "Run remote turns unattended" is on by default and gives those turns
Bypass mode. Turn it off to use Auto-Accept instead. Workspace edits then
proceed, while shell commands and other risky actions wait for approval in the
desktop app.

Sender approval is an access-control boundary. Review the messaging workspace,
approved senders, bot assignment, and unattended-tools setting together.

## Workspace boundary

Reads inside the workspace do not prompt. Reads and writes outside it require
approval in every mode except Bypass. Auto-Accept grants write access to the
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

macOS, Linux and Windows 11 24H2 or newer can run commands under an optional
kernel sandbox. macOS and Linux use Anthropic's sandbox runtime (Seatbelt and
bubblewrap, with its loopback proxies for the network); Windows uses a
Microsoft process container run by the `wxc-exec` runner the app ships. Plan
mode allows no writes. Default and Auto-Accept allow writes to the workspace
and temporary directories. Bypass remains unconfined.

Reads are allowed everywhere except a short list of credential stores: SSH
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
the rest of the session. The app's own settings, browser data and keychain
files are never offered. A command that reaches a store without naming it,
through a script or a variable, fails at the kernel and is told to name the
path so the prompt can be raised. `ABACUSAI_BOT_SANDBOX_READABLE`, a
path-delimited list where `~` expands to the home directory, exempts a path
without prompting.

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
not confined yet.

Linux needs `bubblewrap` and `socat` installed, and unprivileged user
namespaces with capabilities (Ubuntu 24.04 restricts them by default; see the
runtime's notes on `kernel.apparmor_restrict_unprivileged_userns`). Without
them the backend exists but cannot start, and commands are refused rather than
run unconfined.

The sandbox applies to shell commands, including commands started by delegated
agents and verification tools. It does not confine Electron, model requests,
MCP tools, device tools, or service connectors. A Windows older than 24H2
(build 26100) has no backend. `ABACUSAI_BOT_SANDBOX=strict` refuses commands
when no sandbox is available; `auto` runs them unconfined on a platform with
no backend, and refuses when the platform's backend exists but cannot start.

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
