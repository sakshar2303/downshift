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

## 2026-10-26 14:50 IST — Alan Code / OpenCode ingestion

**Alan Code runs on an OpenCode engine; we read its SQLite DB natively.** The
engine keeps sessions in `~/.alan/alan-code/engine/share/opencode/opencode.db`
(plain OpenCode uses `~/.local/share/opencode/opencode.db`). We copy the DB
plus its `-wal` and `-shm` sidecars into a temp dir and open the copy read-only
with Node's built-in `node:sqlite`. Touching the live file would take locks
while the agent is still writing, so ingestion never disturbs a running app.
No `better-sqlite3`, no native build.

**Segmentation is the correctness problem here, not token math.** One assistant
message is not one step: OpenCode emits repeated `step-start` .. `step-finish`
segments inside a single message, and each segment carries its own token
breakdown, cost and tool parts. We order parts by `time_created` then `id`,
build one step per segment, take tokens from that segment's `step-finish`, and
fall back to the message-level tokens only when a segment is unfinished. Tool
output is stringified and clipped at 4000 chars, same as the Claude Code path.
`reasoning` parts stay out of step text because they are not replayable.

**Cost is a placeholder.** Alan-hosted usage records `cost: 0` on every step, so
`recordedCostUsd` is kept for provenance and cost is always recomputed later
from the pricing table. If we trusted the recorded value, every Alan session
would look free and the downshift savings would be fiction.

Session discovery now spans both sources: `~/.claude/projects/*/*.jsonl`
transcripts and both OpenCode DBs, newest first. `downshift sessions` lists the
newest 15 and `downshift analyze <target>` accepts a transcript path, an
OpenCode session id, or `latest`. Tests build a synthetic SQLite DB in a temp
dir (two assistant messages, three step segments, tool parts) and assert the
segmentation, per-step tokens and tool capture.

Tooling note: Vitest 2's bundled vite-node stripped `node:` before checking
builtins and could not load `node:sqlite`; Vitest 3 knows the new builtin.
