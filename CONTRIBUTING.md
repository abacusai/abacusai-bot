# Contributing

AbacusAI Bot accepts community input through issues. The maintainers currently keep implementation, documentation, and release responsibility within the project team, so external pull requests are not reviewed.

You may inspect, modify, and distribute forks under the [MIT license](LICENSE). The policy above only describes how changes enter this repository.

## Choose the right channel

| Need | Channel |
| --- | --- |
| Reproducible product defect | [Bug report](https://github.com/abacusai/abacusai-bot/issues/new?template=bug_report.yml) |
| Product or workflow proposal | [Feature request](https://github.com/abacusai/abacusai-bot/issues/new?template=feature_request.yml) |
| Setup, diagnostics, account, or provider help | [Support](SUPPORT.md) |
| Suspected vulnerability | [Private security report](SECURITY.md#report-a-vulnerability) |

Search existing issues before opening a new one. Keep one problem per issue and remove credentials, private conversations, file contents, and other sensitive data.

## Bug reports

A useful report contains:

- the AbacusAI Bot version or source commit;
- operating system and architecture;
- model provider and permission mode when relevant;
- exact steps to reproduce the problem;
- expected and observed behavior; and
- a minimal log excerpt, screenshot, or sample file when it adds evidence.

Paste text as text when possible. Do not upload an entire diagnostics archive to a public issue. The [troubleshooting guide](docs/troubleshooting.md) explains how to collect and redact logs.

## Feature requests

Describe the problem before proposing an interface. Include the current workaround, who encounters the problem, and any constraints that would change the design. A focused request is easier to evaluate than a list of unrelated features.

## Technical analysis

Root-cause analysis, reduced test cases, and implementation notes are welcome in an issue. Verify commands and code against the current repository before posting them. Generated text or a speculative patch is not evidence by itself.

If you maintain a fork, start with [Build from source](docs/getting-started.md#build-from-source) and run `pnpm check` before distributing a build. An issue is still the right place to discuss a change with the maintainers; unsolicited pull requests may be closed without review.

## Code style

Comments follow [the code-style guide](docs/code-style.md). These rules also help keep a fork consistent with the project.

## Conduct

Follow the [Code of Conduct](CODE_OF_CONDUCT.md) in all project spaces. Report security problems privately under the [Security policy](SECURITY.md).
