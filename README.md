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