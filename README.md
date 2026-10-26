# Downshift

Find where your AI agent can downshift to an open model — and prove it.

## Problem

Coding agents send every step to expensive frontier models. Most steps are file
reads, searches and test runs. Nobody knows which steps really need the big
model. Downshift measures it using only free/open models.

## Install

```bash
npm install
npm run build
```

## Usage

```bash
downshift --help
```

## Development

```bash
npm run dev         # tsx watch on src/cli.ts
npm test            # vitest
npm run typecheck   # tsc --noEmit
```

Requires Node >= 22.
## Pricing

Costs are recomputed from [OpenRouter](https://openrouter.ai/api/v1/models)
public list prices, fetched without an API key and cached for 24 hours at
`.downshift/pricing.json`. Offline, Downshift falls back to that cache; if it
has never been seeded, the command fails with a clear error rather than
guessing.

OpenRouter does not publish a cache-write price. Downshift derives one: **1.25x
the prompt rate for `anthropic/*` models**, and the plain prompt rate for every
other model. Local models (Ollama, `gemma4:latest`) are priced at $0. Unknown
model ids warn once and leave cost unknown instead of silently reporting zero.

Override any model mapping in `downshift.config.yaml`:

```yaml
modelMap:
  claude-opus-4-8: anthropic/claude-opus-4.6
```
