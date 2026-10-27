# Research notes

What the two transcript formats actually look like, what already exists in this
space, and what Downshift does that those tools do not.

## Data formats

### Claude Code (JSONL transcripts)

Stored as `~/.claude/projects/<project>/<session>.jsonl`, one JSON object per
line.

- **One API response is many lines.** Claude Code writes a line per streamed
  content block, and every line repeats the same `message.id` and the full
  `usage` object. Parsing line-by-line triple-counts a response that emitted
  text, thinking and a tool call. The parser keys assistant lines by
  `message.id`, merges content blocks in first-appearance order, and takes usage
  from the first line that reports it.
- **Tool results arrive separately.** A `tool_use` block is on an assistant
  line; the matching `tool_result` is on a later `user` line and refers to it by
  `tool_use_id`. Results must be re-attached by id, and are clipped at 4000
  characters so one noisy command cannot swamp a session.
- **`content` is polymorphic.** It is either a string or an array of blocks, so
  every reader stringifies before inspecting.
- **Titles need care.** The first user line is usually a
  `<system-reminder>` blob. The real title is the last `custom-title` line if the
  user renamed the session, otherwise the first user message with machine tags
  stripped and tool-result-only messages skipped.
- **Synthetic assistant messages exist.** Lines like "Credit balance is too
  low" or "No response requested." are not API steps; counting them inflates
  step counts and token totals.
- **Sidechains** (`isSidechain`) are sub-agent work. They are excluded from
  replay context and from sampling, because they were not part of the main
  trajectory.

### Alan Code / OpenCode (SQLite)

Alan Code runs on an OpenCode engine and keeps sessions in
`~/.alan/alan-code/engine/share/opencode/opencode.db`; plain OpenCode uses
`~/.local/share/opencode/opencode.db`.

- **The database is live.** The agent may still be writing, so ingestion copies
  the DB plus its `-wal` and `-shm` sidecars into a temp directory and opens the
  copy read-only with Node's built-in `node:sqlite`. No native dependency, no
  lock on the running app.
- **One assistant message is not one step.** OpenCode emits repeated
  `step-start` .. `step-finish` segments inside a single message, each with its
  own token breakdown, cost and tool parts. Steps are built per segment, ordered
  by `time_created` then `id`, with tokens from that segment's `step-finish`.
- **Hosted usage records `cost: 0`.** Every Alan-hosted step reports zero cost,
  so the recorded value is kept for provenance only and all prices are
  recomputed from OpenRouter list rates. Trusting the recorded value would make
  every session look free.
- **Reasoning parts are not replayable** and stay out of step text.

### What the real data changed

- **Bash hides the work.** Alan's agent rarely calls a `read` tool; it opens
  files with `cat`, searches with `grep -rn`, lists with `ls`, pages with
  `sed -n`, inspects state with `git status`. A naive classifier buckets all of
  that as `shell`, the kind that looks least downshiftable. Commands are now
  split into pipeline stages and classified by program and subcommand, which
  turned 42 of 89 bash calls in one real session into reads/searches/tests.
- **Token totals now match Alan's own session totals** once synthetic steps are
  excluded — the ingestion reads the same numbers the product shows.

## Prior art

| Tool | What it does | Where it stops |
| --- | --- | --- |
| [agent-replay](https://github.com/harness-hub/agent-replay) | Records tool calls and LLM responses as fixtures, replays them, and reports divergences in tool names, arguments and call order. A regression-testing framework. | Answers "did my agent change?", not "which steps could a cheaper model do?". No pricing, no routing. |
| [Kitaru](https://github.com/zenml-io/kitaru) (ZenML) | Replay-based evals: records or imports runs as sessions, re-executes your agent code against recorded tool responses, and compares a candidate model/prompt change to the baseline. Supports CLI-harness agents through an adapter. | Evaluates a change across whole sessions; produces pass/fail evidence, not a per-kind spend map or a routing policy. |
| [agentskit `replayAgainst`](https://www.agentskit.io/docs/reference/recipes/replay-different-model) | Replays every recorded turn of a session against a different (often cheaper) model adapter and returns a per-turn comparison. | The closest single feature to `downshift replay`, but it is a comparison tool: no cost attribution, no per-kind aggregation, no policy file, no end-to-end proof. |
| [burnie](https://pypi.org/project/burnie) / codeburn | Local cost analytics for Claude Code and other agents: parse transcripts, price tokens, break spend down by session, model and project, render an HTML report. | Closest to `downshift analyze`; stops at reporting. No replay, no judge, no routing decision, no speculative run. |
| FrugalGPT-style cascades (Chen, Zaharia, Zou, 2023) | Send a request to a cheap model first, score the answer, and escalate to a stronger model only when the scorer is not confident. | Cascade over whole requests with a scorer trained on labelled queries. Downshift asks the same question one level down: which *steps inside a real agent trajectory* are safe to route, using the recorded trajectory itself as the label. |

## What is new here

1. **The unit of analysis is the agent step**, not a request or a session: one
   assistant turn plus the tool calls it made, taken from a transcript the agent
   already wrote. No instrumentation, no SDK, no adapter.
2. **Cost map and routing decision share one pipeline**: classify deterministically
   → price at list rates → replay sampled steps → score the replay → aggregate per
   kind → emit `downshift.policy.yaml` → prove it with a speculative bench.
3. **Scoring is deterministic where it can be.** A replayed tool call is scored
   by normalised path equality, token Jaccard over search patterns, command and
   executable comparison, and normalized Levenshtein over new file text. Before
   comparing, a single-segment shell read/search/listing (`cat`, `sed -n`,
   `grep`, `rg`, `ls`, `find`, `tree`, optionally behind `cd dir &&`) is
   canonicalised to the equivalent `read_file`/`search`/`list_files` action, so
   an agent that opens files with bash is not scored against the wrong tool
   name. Only plan steps (text with no tool) go to an LLM judge, and that judge
   is asked a narrow question with a zod-validated JSON answer and one retry.
   The same transcript therefore produces the same score, for free.
4. **The evidence loop runs at $0.** Local Ollama, Groq's free tier and
   OpenRouter `:free` models only, with a free guard that refuses non-`:free`
   OpenRouter ids, rate-limit-aware clients, and an on-disk cache keyed by model
   and prompt so reruns cost nothing and stay reproducible offline.
5. **Speculative routing is measured, not assumed.** The bench counts the small
   model's *rejected* proposals, reports the escalation rate, and requires the
   task's tests to pass with the test files byte-for-byte unchanged.
6. **Accounting is explicit.** Hosted usage records $0, so every dollar figure is
   labelled a list-price equivalent, and every savings projection says
   "projected at list prices — actual spend $0".

## Limits of this research

- Transcripts do not store the original system prompt, so replay context is
  reconstructed from the system message equivalent plus prior turns.
- Counterfactuals are single-step: a replay changes one step in isolation and
  assumes the rest of the trajectory holds.
- Cache-write prices are derived (1.25x prompt for `anthropic/*`, prompt
  otherwise) because OpenRouter publishes no cache-write rate.
- The bench is one small task; it demonstrates the routing rule end to end, it
  does not estimate a general success rate for open models.
