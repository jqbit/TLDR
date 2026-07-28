# Honest Numbers

TLDR saves tokens on some workloads and costs tokens on others. This page
says which is which, using only numbers this repository has actually
measured — and flags every number that is historical. No marketing. If
TLDR is net-negative for your workload, turn it off (`stop tldr`).

## What TLDR actually does

TLDR is an output-style instruction: a small memory-file prompt
([`TLDR.md`](../TLDR.md)), with optional skill, hook, and slash-command
layers on top. It makes the model **write shorter prose output**. That is
the whole mechanism. It does not compress your input, your context, your
files, or the model's thinking tokens.

## The measured numbers

| What | Number | How measured | Source |
|---|---|---|---|
| Prose-output reduction (**historical**) | ~60–75% typical; −82.1% aggregate on the v0.13.1 run; −77% to −87% per agent | multi-harness CLI benches; `tiktoken o200k_base`; prose outside code fences only | [`data/benchmarks.md`](../data/benchmarks.md) |
| Input reduction from the prompt | 0% | it is an output-style instruction | — |
| Input cost the prompt **adds**, per turn | ~470 tokens (prompt-only install: `TLDR.md` is 1,892 bytes) up to ~1–1.5k tokens (skill + hook installs: [`skills/tldr/SKILL.md`](../skills/tldr/SKILL.md) is ~3.3 KB, plus skill-list entries and session-start rule injection) | file sizes at ≈4 chars/token | repo files |
| Accuracy under TLDR | **not measured** | the bench suite is style-focused, not correctness-focused | [`data/philosophy.md`](../data/philosophy.md), §6.5 |
| Latency | **not measured** | — | — |

**Every reduction number above is historical.** The benched prompts were
the v0.13–v0.18 generations. The shipped `TLDR.md` (1,892 bytes) and
`commands/tldr.md` were later tightened to a 1-sentence / 3-word-default /
6-word-max profile and have **not** been rerun through the full suite. The
same caveat heads [`data/benchmarks.md`](../data/benchmarks.md) and
[`data/methodology.md`](../data/methodology.md).

## When TLDR wins

- **Long chatty outputs.** Explanations, architecture discussion, code
  review, debugging walkthroughs — anywhere the model would write 1k+
  output tokens per reply. This is where the historical 60–87% cuts
  happened.
- **Long sessions with verbose agents.** Per-reply savings compound; the
  fixed per-turn overhead stays flat.
- **Reading speed.** Shorter replies finish sooner and read faster. For
  many users this — not cost — is the real win, and it holds regardless
  of billing model.

## When TLDR loses (net-negative)

Plainly: **the skill/hook install costs roughly 1–1.5k input tokens every
turn (the prompt-only install ~470). If it saves less output than that,
you are paying to use it.**

- **Terse workloads.** If your normal replies are already ~150 output
  tokens, TLDR saves perhaps 70–100 of them and the skill install costs
  ~1k input tokens per turn. Net loss. Use the prompt-only install
  (`bash install.sh`) or turn it off.
- **Per-request or per-credit billing.** Agents that charge per premium
  request (not per token) see zero cost benefit: a shorter answer is the
  same request. The reading-speed benefit still applies; the cost benefit
  does not.
- **Session-level totals are always smaller than the output-reduction
  headline**, because in agentic coding input tokens (your prompts, your
  files, tool results, the injected rules) dwarf output tokens. We have
  not measured a session-level figure for the current prompt; do not
  expect the headline percentage on your bill.
- **Tool-side counters can go the wrong way.** Rule re-injection,
  retries, and cache/context accounting differ per agent. If your own
  A/B shows more tokens with TLDR than without, believe your A/B and
  turn it off.

## Measure it yourself

1. **`/tldr-stats`** (Claude Code) reads your real session log and prints
   actual input/output token counts. The "saved" line is an **estimate**:
   it extrapolates what the output would have been without TLDR using a
   fixed benchmark ratio (0.65, `full` mode only — lite/ultra/wenyan show
   no estimate). Real usage, estimated baseline; the output labels it
   `est.` for exactly that reason.
2. **The only fully honest test is an A/B**: run the same task with and
   without TLDR and compare your provider's own usage/billing page. That
   number outranks anything this repo prints.
3. **Reproduce numbers yourself**: the eval harness in
   [`evals/`](../evals/README.md)
   (`evals/llm_run.py` to generate, `evals/measure.py` to read). No eval
   snapshot is committed to this repository — every number you quote
   should come from your own run.

## Rule of thumb

> Normal reply longer than ~1.5–2k output tokens → TLDR probably saves
> you money.
> Normal reply shorter than that, or you pay per request → TLDR probably
> costs you money.
> Either way, TLDR replies are faster to read. That part is free.

Found a workload where these numbers are wrong?
[Open an issue](https://github.com/0p9b/TLDR/issues) with your A/B and it
goes on this page.

---

*Page format adapted from the upstream caveman project's honest-numbers
doc; see [`legal/ATTRIBUTION.md`](legal/ATTRIBUTION.md).*
