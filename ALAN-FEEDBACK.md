# Built with Alan

Downshift was built inside Alan Code sessions running DeepSeek V4.1 Flash. Each
step in `DEVLOG.md` corresponds to one of those sessions: the agent read the
repo, wrote the change, ran the tests, and committed. The session transcripts
those runs left behind are also the dataset the tool was developed against,
which made the feedback loop unusually tight — bugs in ingestion showed up
immediately as wrong numbers in the very session being used to measure the
tool.

## What worked

- **The engine's database is the transcript.** Alan Code writes OpenCode-format
  SQLite, so Downshift could read real sessions without instrumenting anything.
  Being able to open the same database the product uses, read-only and on a
  copy, made debugging ingestion a matter of comparing two numbers.
- **Recorded cost is $0, which forced a better design.** Because hosted usage
  records zero cost, the tool had to recompute prices from list rates and say so
  out loud. That single constraint produced the most honest part of the project.
- **Long sessions are the interesting ones.** A 176-step session has enough
  reads, searches and test runs to show structure that a five-step toy session
  hides.

## What was hard

- **Bash hides the work.** Alan's agent reads with `cat`, searches with
  `grep`, and lists with `ls`, so a tool-name classifier sees "shell" for most
  of a session. Splitting commands into pipeline stages and classifying by
  program was the single largest correction to the spend map.
- **Free tiers are slow, and that shapes the tool.** Groq's free tier is token
  bucketed, so a full replay or bench matrix can run for tens of minutes. That
  is why replay results are cached on disk and why the bench prints progress per
  step instead of sitting silent.
- **Segment boundaries are correctness, not detail.** OpenCode emits several
  `step-start`/`step-finish` segments per assistant message. Treating a message
  as a step mixes token counts and makes per-kind attribution meaningless.

## Feedback for the platform

- A first-class, documented read-only view of the session database (or an
  export command) would remove the copy-the-DB-plus-WAL dance from every tool
  that wants to analyse its own sessions.
- Recording a non-zero list-price estimate alongside `cost: 0` would let
  hosted sessions show what they would have cost, without changing billing.
- Persistent session ids that survive renames made `latest` and
  `latest:alan` possible; keeping that stable is worth treating as an API.

The raw notes behind this file are in `DEVLOG.md`, including the bugs that only
appeared against real transcripts.
