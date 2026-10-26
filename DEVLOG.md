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

## 2026-10-26 15:10 IST — Fixes from real sessions

**These bugs only showed up against real data.** Cross-checking the parser with
actual transcripts and Alan Code sessions turned up three things the fixtures
never exercised: titles were being taken from the first user line, which is
usually a `<system-reminder>` blob (and ignored the `custom-title` rename the
user actually chose); `<synthetic>` assistant messages ("Credit balance is too
low", "No response requested.") were counted as steps, inflating step counts
for sessions that never made a real API call; and `latest` always meant "newest
of anything", so there was no way to ask for the newest Alan Code session
specifically.

Titles now prefer the last `custom-title`, otherwise the first user message
with machine tags stripped and tool-result-only messages skipped; discovery
reuses the parser rather than re-deriving titles. `latest:alan`,
`latest:opencode`, `latest:claude-code` and `downshift sessions --source` make
source-scoped views possible.

**The reassuring part:** once synthetic steps were excluded, Downshift's token
totals match Alan's own session totals exactly. The ingestion is reading the
same numbers the product shows, which is the baseline the whole cost story
depends on.

## 2026-10-26 15:20 IST — Pricing and step classification

**Cost is now recomputed, not trusted.** Alan-hosted usage records every step at
$0, so the numbers in the database say a session was free. `analyze` now prices
each step from OpenRouter's public list rates: input at prompt, output at
completion, cache reads at the cached rate, and cache writes at a derived rate
(1.25x prompt for Anthropic, prompt otherwise, since OpenRouter publishes no
cache-write price). The session total and the per-kind table are the first
honest view of where money actually goes. When the recorded cost is $0 and the
recomputed cost is not, the CLI says so explicitly.

**Classification is deterministic on purpose.** Kind comes only from tool names
and, for bash/execute, the command text. A step with several tools takes the
highest-ranked kind (edit > test > shell > delegate > web > search > read), so a
step that edited a file is an edit even if it also read one. No model call, no
sampling, no judgement — the same transcript always yields the same table, which
is what makes the savings claim reproducible.

Model ids needed a translation layer: Claude Code reports
`claude-opus-4-8`/`claude-sonnet-4-5-20250929`, OpenRouter wants
`anthropic/claude-opus-4.8`/`anthropic/claude-sonnet-4.5`. Local Ollama models
price at $0, and unknown ids warn once rather than pretending to be free.

## 2026-10-26 15:25 IST — Bash commands are not all shell

**The real-data finding.** Alan Code's agent rarely calls a `read` tool. It
opens files with `cat`, searches with `grep -rn`, lists with `ls`, pages with
`sed -n`, and inspects state with `git status`. Every one of those was a single
`bash` tool call, so classification marked the step `shell` — the bucket that
looks least downshiftable. The potential was there; the label hid it.

Bash commands are now split into pipeline stages on `&&`, `||`, `;` and `|`
(quote-aware), leading `cd` and env assignments are dropped, and each stage is
classified by its program and subcommand. `cat`/`head`/`sed` without `-i` are
reads, `grep`/`rg`/`ls`/`git status`/`git log` are searches, `npm run typecheck`
and `npx tsc` are tests, and anything that writes (`>`, `>>`, `<<`, `sed -i`,
`git commit`) stays shell. A stage-level result rolls up to the step with the
same priority order as before.

Plan tools also only name a step when they are the *only* tools in it. A step
that writes a todo and then edits a file is an edit, not a plan.

**Before/after on `downshift analyze latest:alan`.** The session is live and grew
from 82 to 96 steps while this change landed, so compare shares, not totals:

| | before (82 steps) | after (96 steps) |
| --- | --- | --- |
| shell | 45 steps, 45.0% of spend | 42 steps, 37.8% |
| search | 0 steps | 12 steps, 7.4% |
| read | 2 steps, 1.6% | 5 steps, 2.5% |
| test | 16 steps, 14.0% | 17 steps, 17.6% |

`analyze` now also reports the headline directly: **42 of 89 bash calls were
really reads/searches/tests**. That is the downshift opportunity the old
classifier was throwing away.

## 2026-10-26 15:40 IST — Cost flamegraph

`downshift analyze` now writes `downshift-report/flame.speedscope.json` and
`steps.json`. The flamegraph uses speedscope's evented format with cost as the
x-axis: each step's width is its recomputed spend in integer micro-dollars, and
the frames nest session -> phase -> kind -> step. Phases are contiguous runs:
explore (read/search/web), plan (plan/delegate), implement (edit/shell/other),
verify (test). Step frames read like the transcript: `read src/cli.ts`,
`grep "pattern"`, `edit src/y.ts`, `npm test`, `plan`.

When a step has no recomputed cost, its token count becomes the width and the
profile is labelled `(tokens)` so a partially-priced session still renders
instead of collapsing to zero. `validateSpeedscope()` checks the invariants that
speedscope is unforgiving about — balanced LIFO opens/closes, in-range frame
indices, non-decreasing `at`, and `endValue` matching the final tick — and
`analyze` refuses to write a file that fails it.

This is the first view that makes the pitch visual: long bars are where the
money actually goes, and the read/search bars sitting under an expensive shell
bucket are the downshift targets.

## 2026-10-26 17:40 IST — Self-contained HTML report

`downshift analyze` now writes `downshift-report/report.html`, a single file
with inline CSS, JS and SVG — no CDN, no external font, no network request. It
opens on a dark page: header cards for total cost, tokens, steps, model and the
share of spend on read+search+test; an icicle chart with session, phase, kind
and step rows whose widths are cost; and the by-kind table. Hovering a block
shows label/$/tokens, clicking zooms into that block, and clicking the top row
resets. `--open` launches it in the browser.

Paths are now display-only relative to the session cwd (`src/cli.ts`) or home
(`~/.claude/...`), including the flamegraph frames and `steps.json`. Absolute
paths were leaking the username into screenshots and getting truncated; the
session itself is still read from its real path.

Every string that comes from a transcript — title, model, frame labels, tool
names, paths — is HTML-escaped before it reaches the page or an attribute. The
report is meant to be shared, so a prompt containing markup must render as text,
not execute.

## 2026-10-26 18:20 IST — Readable report: legend and grouped view

The report now shows a legend with the exact per-kind colors used by the chart,
and opens in a Grouped view that merges same-named blocks under the same parent
and packs them widest first — speedscope's "left heavy" layout. Chronology is
still one click away with the Timeline toggle, and hover/zoom work in both
views. Grouped is the default because the question the report answers is "where
did the money go", not "what happened first".

`downshift analyze --title <text>` overrides the session title in the HTML
report and the speedscope profile, which makes shared screenshots and
side-by-side runs easier to label without renaming the underlying transcript.
