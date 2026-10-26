# DEVLOG

## 2026-10-26 14:13 IST — Scaffold

**The idea.** Coding agents route every single step to a frontier model. Most
steps are mundane: read this file, grep for that symbol, run the tests, look at
the error. Paying frontier prices for file reads is waste. Downshift finds the
steps an open model can handle and proves it with a replay + judge loop.

**Zero-cost constraint.** The whole project must run at $0. That means local
Ollama for anything we can self-host, and provider free tiers (Groq,
OpenRouter `:free` models) for the rest. No credits get added to any account,
no paid fallbacks. If a model isn't free, it isn't in the loop.

**Planned steps.**

1. Session ingestion — parse recorded agent transcripts into a normal format.
2. Pricing — per-step cost accounting for frontier vs open models.
3. Classification — tag each step by kind (read, search, test, edit, plan).
4. Flame graph — visualize where cost and tokens actually go.
5. Replay — rerun individual steps against an open model.
6. Judge — grade replay output against the frontier baseline.
7. Policy — emit a routing policy for which steps can downshift.
8. Bench — fixed task suite so the claim is reproducible, not anecdotal.

Storage will use Node's built-in `node:sqlite` (Node >= 22). No native
dependencies, no `better-sqlite3`.
## 2026-10-26 14:25 IST — Claude Code ingestion

**Duplicate `message.id` discovery.** Claude Code does not write one JSONL line
per API response. It writes one line per streamed content chunk, and every line
carries the same `message.id` plus a full copy of the same `usage` object. Naive
line-by-line parsing triple-counts tokens on a response that emitted text,
thinking and a tool call. The parser now keys assistant lines by `message.id`,
merges their content blocks into a single step in first-appearance order, and
takes usage from the first line that reports it — once per id.

Two smaller things the transcript forced us to handle: `tool_result` blocks
arrive on separate `user` lines and have to be re-attached to a `tool_use` by
id, and `content` is either a string or an array, so results are stringified and
clipped at 4000 chars to keep one noisy command from swamping a session.

**Lesson.** Token counts are the whole product here. If ingestion double-counts,
every cost number downstream is wrong, and the downshift savings look bigger
than they are. Dedupe is not an optimization, it is correctness.

Todo: next up is pricing (src/pricing) over the normalized steps.
