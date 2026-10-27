---
name: downshift
description: Find where a long coding-agent session spent its tokens, and which steps could run on a cheaper open model. Use after a long agent session, when the user asks "where did the tokens go", "why was this session expensive", or "what could I have run on a cheaper model".
---

# Downshift

Downshift reads the transcripts your coding agent already writes, prices them at
public list rates, and reports which step kinds could be handled by an open
model.

Use this skill to turn one long session into a short, factual answer about cost.
Do not guess numbers; every figure you report comes from the command output.

## When to use it

- The user just finished a long agent session and asks what it cost.
- The user asks where tokens or money went in a session.
- The user asks whether a cheaper or local model could handle part of the work.
- You are about to recommend a routing or model change and need evidence.

## Run it

Prefer an installed binary. Fall back to the repository entrypoint only when
working inside the Downshift repo.

```bash
downshift sessions                 # find the session id, newest first
downshift analyze latest           # price it, classify steps, write the report
```

Inside the Downshift repo, use `npx tsx src/cli.ts analyze latest` instead.

- `latest:claude-code` and `latest:alan` scope to one source.
- `analyze` writes `downshift-report/report.html`, `steps.json` and
  `flame.speedscope.json`. Never edit them by hand.
- If pricing has never been fetched and the machine is offline, the command
  fails with a clear error rather than inventing a price. Report that, do not
  estimate.

Deeper evidence, only when the user asks for it:

```bash
downshift replay latest            # replay sampled steps on local + free models
downshift policy latest            # turn replay scores into a routing policy
downshift bench --runs 2           # prove it end to end on a tiny task
```

`replay` and `bench` call live models and are slow on free tiers. Ask before
starting a long run.

## Summarise the result

Answer in this shape, in three or four sentences plus one small table:

1. Session, steps, model, and the recomputed total at list prices.
2. The two or three kinds that dominate spend, with their share.
3. The downshift opportunity: the share of spend on read, search and test, and
   how many shell calls were really reads/searches/tests.
4. One concrete next step (for example `downshift replay latest`).

Call out explicitly that Alan-hosted sessions record `$0` per step and that the
figure shown is a list-price equivalent, not money actually spent.

## Guardrails

- Never invent, round up, or extrapolate a cost figure. Quote the command.
- Do not claim a model "will" handle a step; without replay evidence, say it is
  a candidate.
- `analyze` output is deterministic for a given transcript. If two runs differ,
  the transcript changed (the session may still be running) — say so.
- Transcripts do not contain the original system prompt. Replays reconstruct
  context from prior turns only, so treat replay scores as evidence about the
  action, not a full behavioural equivalence proof.
