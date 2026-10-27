# Downshift

Find where your AI agent can downshift to an open model — and prove it.

## Problem

Coding agents send every step of a long session to a frontier model, even when
the step is a file read, a search or a test run. Nobody knows which steps
actually need the expensive model. Downshift measures that from transcripts the
agent already wrote, using only free and local models.

## Demo

**Demo video: TODO — add link before submission.**

The same run leaves `downshift-report/report.html`, a self-contained cost
flamegraph, and `downshift-report/flame.speedscope.json`. Both open offline.

## How it works

Downshift treats one assistant turn plus the tools it called as the unit of
analysis. Nothing is instrumented: the input is the transcript the agent already
writes.

```
 Claude Code JSONL ─┐
                    ├─► ingest ─► classify ─► price at list rates ─► report.html
 Alan/OpenCode DB ──┘      │             │             │              + speedscope
                           │             │             └─► per-kind spend map
                           │             └─► read / search / edit / test / shell / plan
                           ▼
                    sampled steps ─► replay on free/local models ─► action match
                                                                        │
                                              plan steps only ─► LLM judge
                                                                        │
                                                                        ▼
                                                              downshift.policy.yaml
                                                                        │
                                                                        ▼
                                              speculative bench ─► proof at $0
```

- **Ingest** — parse Claude Code JSONL, or copy and read the Alan Code /
  OpenCode SQLite database plus its WAL sidecars. Merge split assistant lines,
  attach tool results, and keep every human turn.
- **Flamegraph** — attribute recomputed cost and tokens to each step kind, then
  write an HTML icicle chart and a speedscope profile.
- **Replay** — deterministically sample steps per kind and replay them against a
  local or free model, rebuilding the conversation in chronological order.
- **Judge** — score replayed tool calls by exact action match (normalised paths,
  search terms, commands, edited text). Only plan steps, which have no tool call
  to compare, go to an LLM judge.
- **Policy** — aggregate match rates per kind and emit a YAML routing rule, with
  the frontier model as the fallback and projected list-price savings.
- **Speculative bench** — run one task on the big model, the small model and a
  router. The router accepts only small-model reads, searches, listings and test
  commands; everything else escalates, and both calls are priced.

## Results

These are the numbers in `downshift-report/` and `DEVLOG.md`, not estimates.

**Cost map — `downshift-report/steps.json`.** Session "Building Downshift in
Alan": 194 steps on `deepseek/deepseek-v4.1-flash`, 26,763,641 tokens (1,700,613
input, 92,916 output, 24,970,112 cache read), **$0.6009 list-price equivalent**.

| Kind | Steps | Share of list-price cost |
| --- | ---: | ---: |
| shell | 77 | 36.2% |
| edit | 47 | 32.7% |
| search | 26 | 12.4% |
| test | 23 | 10.4% |
| read | 12 | 4.2% |
| plan | 9 | 4.1% |

Read + search + test are 61 steps and **27.1%** of the recomputed spend.

**Replay and policy — `downshift-report/replays.json`,
`downshift.policy.yaml`.** 48 replay calls were made (4 sampled steps per kind
on each of `ollama:gemma4:latest` and `groq:openai/gpt-oss-120b`). 30 produced a
score; only one cleared the 0.8 action-match threshold (a read on gpt-oss). At
the 0.9 policy threshold no kind qualified, so the emitted policy keeps all six
kinds on the frontier model, with read evidence at 50% over 2 samples and
search/edit/test/shell at 0% over 4. The honest result is that neither free
model was a safe substitute on this session's sampled steps.

**Speculative bench — `downshift-report/bench.json`.** Task
`bench/tasks/csv-export`, 2 runs per config, actual spend **$0**.

| Config | Pass rate | Mean steps | Mean list-price cost | Escalation |
| --- | ---: | ---: | ---: | ---: |
| big (`gpt-oss-120b`) | 0.5 | 13.0 | $0.004140 | — |
| small (`gemma4`) | 0.0 | 1.0 | $0 | — |
| downshift (small → big) | 0.0 | 1.0 | $0 | 0% |

The sample is two runs per config, and the recorded run is dominated by
`Request timed out`: every small and downshift run, plus one big run, hit the
timeout before finishing. One big run passed in 19 steps. That is enough to
exercise the harness, not enough to claim a general success rate.

## Quickstart

Requires Node >= 22.

```bash
npm install
cp .env.example .env          # add free-tier keys; never add credits

npx tsx src/cli.ts doctor     # probe Ollama, Groq and OpenRouter
npx tsx src/cli.ts analyze latest
npx tsx src/cli.ts replay latest
npx tsx src/cli.ts policy latest
npx tsx src/cli.ts bench
```

`analyze` and `policy` are local and cheap. `replay` and `bench` call live
models and are slow on free tiers; they cache results under `.downshift/` so a
rerun does not spend the free quota twice. Use `npx tsx src/cli.ts sessions` to
find a session id if `latest` is not the one you want.

For a production build:

```bash
npm run build
node dist/cli.js --help
```

## Zero-cost by design

- **Ollama** runs locally and is priced at $0.
- **Groq** uses the free tier with token-bucket aware rate limiting.
- **OpenRouter** is restricted to `:free` model ids; a guard refuses anything
  else unless `--allow-paid` is passed explicitly.
- Replay and judge results are cached on disk and keyed by model plus prompt, so
  reruns cost nothing and stay reproducible offline.

Every dollar figure is a **list-price equivalent** computed from OpenRouter's
public rates, not money spent. Alan-hosted steps record `cost: 0`; the report
says so wherever a total appears.

## Supported sources

- **Claude Code** JSONL transcripts under `~/.claude/projects/<project>/`.
- **Alan Code / OpenCode** SQLite sessions at
  `~/.alan/alan-code/engine/share/opencode/opencode.db` and
  `~/.local/share/opencode/opencode.db`. The database is copied, with its
  `-wal` and `-shm` files, and opened read-only so a live agent is not
  disturbed.

Sidechain (sub-agent) steps are read for accounting but excluded from replay
sampling and replay context.

## Design decisions

- **Dedupe by `message.id`.** Claude Code writes one assistant response across
  several JSONL lines and repeats the full usage object on each. Counting lines
  would triple the tokens; usage is taken once per message id.
- **Recompute prices from list rates.** Alan records `cost: 0` for hosted usage,
  so trusting the transcript would make every session look free. The recorded
  value is kept for provenance only.
- **Deterministic first, LLM only where necessary.** Replayed tool calls are
  compared mechanically. Only plan steps go to the LLM judge, which gets a
  narrow question, a zod-validated JSON answer and one retry.
- **Sample and cache for free tiers.** Replaying every step would exhaust the
  free quota, so steps are sampled per kind and every result is cached.
- **Measure speculative routing instead of assuming it.** The bench counts
  rejected small-model proposals, escalates the rest, prices both calls, and
  requires the task's test files to remain byte-for-byte unchanged.

## Limitations

- Transcripts do not contain the original system prompt, so replay context is a
  neutral reconstruction plus prior turns.
- Counterfactuals are single-step: a replay changes one step in isolation and
  assumes the rest of the trajectory would still happen.
- OpenRouter publishes no cache-write rate. Downshift approximates it as 1.25x
  the prompt rate for `anthropic/*` models and the prompt rate otherwise.
- The bench is one small task with two runs per config. It demonstrates the
  routing loop end to end; it is not a general success-rate estimate.

## Built with Alan

Every step was built in an Alan Code session running DeepSeek V4.1 Flash. The
sessions themselves became the dataset the tool was developed against. Notes on
what worked, what was hard and what the platform could improve are in
[ALAN-FEEDBACK.md](ALAN-FEEDBACK.md); the chronological build log is in
[DEVLOG.md](DEVLOG.md).

## License

MIT. See [LICENSE](LICENSE).
