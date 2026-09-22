# Models

You can start AbacusAIBot without an existing paid model subscription. A free
Abacus.AI account starts with 2,000 credits and a selection of free models.
OpenRouter and Google AI Studio add other free model options. Provider quotas,
catalogs, and free-tier limits can change.

You can also connect paid provider keys, subscriptions, cloud platforms, model
gateways, or a local model. AbacusAIBot does not proxy every request through an
AbacusAIBot service.

Open Settings, then Models, to paste a provider key or use a supported sign-in
flow. The page lists the providers available in the installed version and links
to each provider's key page. The app supports direct providers, model gateways,
AWS Bedrock, Google Vertex, Azure OpenAI, and OpenAI-compatible local endpoints
such as llama.cpp and vLLM.

## Local models

Settings, then Models, has an "On this machine" section: the app can download
a model (a Qwen build in GGUF form, pinned by checksum) into
`~/.abacusai-bot/models` and run it with the bundled llama.cpp server. It
appears in the model picker under "On this machine" and joins RouteLLM - Open
as its last resort, after Abacus.AI, Google AI Studio and OpenRouter. The
recommendation follows the machine's memory. A local model needs no account,
key or quota; it is slower than the cloud, and the server is stopped after
fifteen idle minutes so the memory comes back.

## Key precedence

The app stores pasted keys in `~/.abacusai-bot/config.json`. A non-empty
environment variable overrides the saved value. This lets a shell profile or a
secret manager supply credentials without writing them to the app config.

Common variables include:

| Provider | Variable |
| --- | --- |
| Abacus.AI | `ABACUS_API_KEY` |
| Anthropic | `ANTHROPIC_API_KEY` |
| OpenAI | `OPENAI_API_KEY` |
| Google AI Studio | `GEMINI_API_KEY` |
| OpenRouter | `OPENROUTER_API_KEY` |
| DeepSeek | `DEEPSEEK_API_KEY` |

The Models page is the source of truth for the full list. Providers that need
several settings, including Bedrock, Vertex, and Azure OpenAI, read their
standard environment variables.

Search, generation, and service connectors have their own settings. A saved
Abacus.AI key also enables account services and automatic diagnostic uploads.
See [Privacy](privacy.md).

## RouteLLM - Open

`RouteLLM - Open` is the picker label for `openllm/auto`. It builds a pool from
eligible models available through your Google AI Studio, OpenRouter, and
Abacus.AI keys. It retries a failed request once, then moves the conversation to
another eligible model. A failed model waits on a cooldown before the router
uses it again.

Provider-wide quota errors pause that provider tier. Model-specific errors only
pause the failed model. The pool never moves onto a premium model merely because
a free model failed.

This route needs at least one eligible Abacus.AI, OpenRouter, or Google AI
Studio connection. Connect more than one provider for fallback across
independent quotas.

## Per-session selection

Choose a model from the composer. The session keeps that choice across restarts.
A bot also keeps its configured model. If a provider becomes unavailable, the
app reports the provider error instead of silently changing a pinned model.

Model catalogs, prices, and context limits come from the bundled provider
catalog or the configured endpoint. They can change between app releases and
may differ from a provider's current billing page.

## Usage

The Usage page reads session logs stored on your machine. It reports requests,
input and output tokens, model use, and estimated cost for the current day and
the last 30 days. RouteLLM - Open also reports which concrete models ran and
which ones hit limits.

These numbers do not replace provider billing. A provider may price cached
tokens, tool calls, or subscription usage differently from the catalog data
available to the app.

The app computes usage totals locally. This does not disable transcript, log,
or diagnostic uploads described in [Privacy](privacy.md).
