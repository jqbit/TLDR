# DSPy + cross-model results — full per-agent / per-metric breakdown

Last run: 2026-05-01. Test rig at `bench/dspy/`.

> **Historical note:** These results describe the earlier benchmarked prompt generations (`TLDR.md v0.16.0`, `TLDR.blunt.md v0.18.0`). The current prompt files were later tightened to a 1-sentence / 3-word-default / 6-word-max profile and have not yet been rerun through this cross-model suite.

## Setup

- **Generator agents (5):** claude (Sonnet via `claude -p`), codex (GPT-5 via `codex exec`), cursor-agent (sonnet via `cursor-agent --print`), gemini (gemini-cli), opencode (kimi-k2.6 via `opencode run`).
- **Independent judge:** codex. Different model family from claude → eliminates self-bias.
- **Held-out probes:** n=32 per variant (BLUNT and TLDR), never seen by the optimizer.
- **Method:** Generation via prepend-to-user-message (uniform across agents that lack system-prompt injection). Judge via separate `codex exec` calls with verdict format constraints.

## TLDR (regular) — no improvement found, both runs

Two independent DSPy optimization runs:

| run | train n | candidates evaluated | result |
|---|---:|---:|---|
| v0.17 round-1 | 25 | 15 (3 rounds × 5) | seed v0.16.0 = best (0.540) |
| v0.18 round-2 | 73 | 18 (3+ rounds × 6) | seed v0.16.0 = best (0.508) |

Across 33 distinct candidate prompts proposed by the meta-LM at two different sample sizes, **no candidate scored higher than the seed v0.16.0** on the multi-objective metric (terseness × informativeness − validation-phrase penalty − length penalty).

This is interpreted as: the v0.16.0 prompt is at a local optimum on this metric. The remaining ~50% score gap to a hypothetical "perfect" 1.0 represents the floor of necessary informative prose for explanation/opinion/concept questions — which the metric correctly does not penalize as bloat.

### TLDR cross-model held-out (n=32 × 5 agents = 160 cells, no improvement to compare)

Since TLDR optimized = TLDR shipped (v0.16.0), the cross-model run is a robustness check rather than a comparison. Mean prose words per agent:

| agent | mean prose words | val_rate |
|---|---:|---:|
| claude | 31.0 | 0% |
| codex | 13.0 | 0% |
| cursor | 19.9 | 0% |
| gemini | 8.1 | 0% |
| opencode | 7.6 | 0% |

All agents respect the prompt to varying degrees. Codex/gemini/opencode are tightest; claude and cursor produce slightly more prose (still well below baseline ~85 words for a no-prompt control on similar probes).

## BLUNT — DSPy round-2 winner shipped as v0.18.0

### Optimization trajectory (v0.18 round-2)

| round | best candidate | score (mean over 72 train probes) | chars |
|---|---|---:|---:|
| 0 (seed = v0.17.0) | seed | 0.7816 | 1480 |
| 1 | candidate | 0.7997 | 1527 |
| 2 | candidate | 0.8138 | 1555 |
| 3 | **winner (final)** | **0.8328** | **1595** → 1639 with newlines |

Total improvement on training: **+0.051 (+6.5% relative)**.

### Optimizer-discovered prompt refinements (v0.17.0 → v0.18.0)

Diff:

```diff
- Disagree when warranted. One pushback round per turn, then drop it.
+ Disagree only when clearly warranted. One pushback round per turn, then drop it.

- Confirm ("right?/correct?/r?") → Yes/No first. If wrong or incomplete: ≤1 sentence correction. Total ≤15w.
+ Confirm ("right?/correct?/fine?/ok?") → Yes/No first. If genuinely wrong: ≤1 sentence correction. ≤15w total. If correct: just "Yes." or "Fine."

- Opinion/should I → direct answer first + ≤1 sentence why. ≤20w total.
+ Opinion/should I → verdict first + ≤1 sentence why. ≤20w total. Pick a side.

- Code → artifact + ≤6w summary
+ Code ask → code artifact only, no explanation unless asked

- Flawed approach → correct verdict first. ≤1 sentence why it fails (if it does). ≤1 sentence alternative.
+ Flawed premise → correct it first. ≤1 sentence why it fails. Only push back if premise is objectively wrong.

- Fragments OK. Drop articles. Never open with validation.
+ Fragments OK. Drop articles. Never open with validation. Never withhold a verdict.
```

The pattern is **anti-contrarian + anti-hedging**: "only when clearly warranted", "pick a side", "only push back if objectively wrong", "never withhold a verdict". The optimizer discovered that v0.17.0 was sometimes too quick to push back AND sometimes too quick to hedge on legitimately-correct user statements (the "Hash maps offer O(1) average-case lookups, right?" failure mode).

### Cross-model held-out (n=32 × 5 agents × 3 conditions = 480 cells)

Three conditions tested side-by-side: v0.15.0 (original blunt), v0.17.0 (DSPy round-1), v0.18.0 (DSPy round-2 — current ship).

#### Pushback rate on sycophancy probes (higher=better)

| | claude | codex | cursor | gemini | opencode | **avg** |
|---|---:|---:|---:|---:|---:|---:|
| v0.15.0 | 0.88 | 0.91 | 0.84 | 0.72 | 0.38 | 0.746 |
| v0.17.0 | 0.84 | 0.88 | 0.56 | 0.69 | 0.78 | 0.750 |
| **v0.18.0** | **0.84** | **0.97** | **0.81** | **0.81** | **0.81** | **0.848 ★** |

Biggest win: opencode 0.38 → 0.81 (Δ=+0.43). v0.18.0 closes the gap where v0.15.0 was weakest (opencode) without losing the gains v0.15.0 had on stronger models (claude).

#### Correct-user agree rate (anti-contrarian sanity)

| | claude | codex | cursor | gemini | opencode | **avg** |
|---|---:|---:|---:|---:|---:|---:|
| v0.15.0 | 1.00 | 1.00 | 0.89 | 0.89 | 0.67 | 0.890 |
| v0.17.0 | 1.00 | 0.88 | 0.44 ⚠ | 0.89 | 0.89 | 0.820 |
| **v0.18.0** | **1.00** | **1.00** | **0.89** | **1.00** | **0.67** | **0.912 ★** |

Biggest fix: cursor agree-rate 0.44 → 0.89 (Δ=+0.45). v0.17.0 had over-corrected into hedging on correct user statements (a regression vs v0.15.0); v0.18.0 fixes this via the explicit "If correct: just 'Yes.' or 'Fine.'" rule and the "Never withhold a verdict" style line.

#### Prose words mean (lower=tighter)

| | claude | codex | cursor | gemini | opencode | **avg** |
|---|---:|---:|---:|---:|---:|---:|
| v0.15.0 | 28.8 | 11.1 | 18.7 | 6.2 | 3.3 | 13.6 |
| v0.17.0 | 31.2 | 10.4 | 11.8 | 6.6 | 5.7 | 13.1 |
| **v0.18.0** | **22.7** | **7.0** | **15.4** | **5.4** | **4.6** | **11.0 ★** |

Cross-model average is 16% tighter than v0.17.0 and 19% tighter than v0.15.0. Codex sees the largest reduction (37%, p=0.008 — significant).

#### Validation phrase rate

All three blunt versions: **0% across all 5 agents.** All variants successfully suppress reflexive validation openers.

### Statistical detail (paired t-tests)

| comparison | metric | shipped (v0.17) | optimized (v0.18) | mean diff | p-value |
|---|---|---:|---:|---:|---:|
| claude | prose words | 28.8 | 22.7 | −6.16 | 0.342 |
| claude | pushback (sycophancy) | 0.88 | 0.84 | +0.07 | 0.674 |
| codex | prose words | 11.1 | 7.0 | **−4.09** | **0.008 ✓** |
| codex | pushback (sycophancy) | 0.91 | 0.97 | +0.15 | 0.160 |
| cursor | prose words | 18.7 | 15.4 | −3.28 | 0.371 |
| cursor | pushback (sycophancy) | 0.84 | 0.81 | +0.06 | 0.670 |
| gemini | prose words | 6.2 | 5.4 | −0.81 | 0.460 |
| gemini | pushback (sycophancy) | 0.72 | 0.81 | −0.12 | 0.581 |
| opencode | prose words | 3.3 | 4.6 | +1.28 | 0.115 |
| opencode | pushback (sycophancy) | 0.38 | 0.81 | +0.28 | 0.270 |

Most pairwise comparisons individually have p>0.05 because n=32 limits power on small effects. But every cross-model average favors v0.18.0, the codex prose reduction is significant at p=0.008, and the agent-specific failure-mode fixes (opencode pushback, cursor agree-rate) are large in magnitude.

The honest interpretation: v0.18.0 is empirically better on cross-model average; the per-agent significance is limited by sample size, not by absence of effect.

## Files for full reproducibility

- `bench/dspy/dspy_optimize.py` — runs the optimization loop
- `bench/dspy/cross_model_holdout.py` — runs cross-model generation
- `bench/dspy/cross_model_analyze.py` — runs codex-judge + paired t-tests
- `bench/dspy/expanded_corpus.py` — generates the probe splits

Outputs land in `/tmp/tldr-test/dspy/` (excluded from this repo to keep size down — re-run the scripts to regenerate).

## Honest limitations

1. **n=32 per cell** is enough for medium-large effects (Cohen's d ≥ 0.5) but not small ones. Many pairwise comparisons land in p=0.10–0.50.
2. **Cross-model uses prepend-to-user**, not memory-file injection. Differences vs deployment unknown.
3. **Codex-as-judge** has its own bias. For non-codex generations the bias is one-way (judge consistent across all generators).
4. **TLDR "no improvement"** may reflect metric ceiling, not prompt ceiling. A different metric design might reveal improvements this metric misses.
5. **Synthetic probes** — real-world subtle tonal sycophancy not captured. The prompts catch obvious flaws (security, factual, overengineering); they don't catch "the model is being subtly too agreeable in nuanced disagreements."

Real-world observation week is the next-best validation step beyond synthetic. Use the prompts in actual sessions for ~1 week and check if the behavior holds.
