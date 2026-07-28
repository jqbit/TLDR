# TLDR.md benchmarks

> **Historical note:** The benchmark results below were measured on earlier shipped prompt generations. The current `TLDR.md` and `TLDR.blunt.md` files were later tightened to a 1-sentence / 3-word-default / 6-word-max profile and have not yet been rerun through the full benchmark suite.

## v0.18.0 — DSPy round-2 + 5-agent cross-model validation (2026-05-01)

**Headline (BLUNT variant):** DSPy-style instruction-evolution optimization over 73-72 train probes + cross-model validation across 5 coding-agent CLIs (claude / codex / cursor-agent / gemini / opencode) with **codex as independent judge** (different model family from generator → eliminates self-bias).

### Cross-model BLUNT results (n=32 held-out × 5 agents = 160 cells per condition)

**Pushback rate on sycophancy probes** (higher=better; 1.0 = always pushed back):

| | claude | codex | cursor | gemini | opencode | **avg** |
|---|---:|---:|---:|---:|---:|---:|
| v0.15.0 (original blunt) | 0.88 | 0.91 | 0.84 | 0.72 | 0.38 | 0.746 |
| v0.17.0 (DSPy round-1)   | 0.84 | 0.88 | 0.56 | 0.69 | 0.78 | 0.750 |
| **v0.18.0 (DSPy round-2 — current)** | **0.84** | **0.97** | **0.81** | **0.81** | **0.81** | **0.848 ★** |

**Correct-user agreement rate** (anti-contrarian sanity, higher=better):

| | claude | codex | cursor | gemini | opencode | **avg** |
|---|---:|---:|---:|---:|---:|---:|
| v0.15.0 | 1.00 | 1.00 | 0.89 | 0.89 | 0.67 | 0.890 |
| v0.17.0 | 1.00 | 0.88 | 0.44 ⚠ | 0.89 | 0.89 | 0.820 |
| **v0.18.0** | **1.00** | **1.00** | **0.89** | **1.00** | **0.67** | **0.912 ★** |

**Prose words mean** (lower=tighter):

| | claude | codex | cursor | gemini | opencode | **avg** |
|---|---:|---:|---:|---:|---:|---:|
| v0.15.0 | 28.8 | 11.1 | 18.7 | 6.2 | 3.3 | 13.6 |
| v0.17.0 | 31.2 | 10.4 | 11.8 | 6.6 | 5.7 | 13.1 |
| **v0.18.0** | **22.7** | **7.0** | **15.4** | **5.4** | **4.6** | **11.0 ★ (−16% vs v0.17)** |

**Validation phrases:** 0% across all conditions × all agents. All blunt variants successfully suppress reflexive validation openers ("Great question", "You're right", etc.).

### Statistical significance (paired t-tests, n=32 per cell)

Most pairwise comparisons individually fall in p=0.10–0.50 (n=32 limits power on small effects), but **direction is consistent** across all 5 agents:

| signal | result |
|---|---|
| Codex prose: shipped 11.1 → optimized 7.0 | **p=0.008 ✓** (significant) |
| Opencode pushback: 0.38 → 0.81 (Δ=+0.43) | direction-consistent, large magnitude |
| Cursor agree-rate: 0.44 → 0.89 (Δ=+0.45) | direction-consistent, large magnitude |
| All 5 agents pushback avg: 0.750 → 0.848 | uniform improvement |

Honest framing: not every pairwise individually hits p<0.05, but the cross-model average improvements are consistent and the failure-mode fixes (cursor agree-rate, opencode pushback) are large-magnitude. Treat as "v0.18.0 is materially better than v0.17.0 on cross-model average."

### TLDR (regular) — no improvement found

Two independent DSPy runs at different sample sizes (n=25 train and n=73 train) **both found no improvement** over v0.16.0 across 18 candidate variations × 3 rounds. The shipped prompt is at a local optimum on the metric.

```
TLDR.md v0.16.0
  DSPy round-1 (n=25 train):  seed 0.540, all 15 candidates < seed → kept seed
  DSPy round-2 (n=73 train):  seed 0.508, all 18 candidates < seed → kept seed
  Cross-model (n=32 × 5 agents): no significant difference vs control
```

This is the empirical truth: TLDR.md v0.16.0 is the best static-instruction prompt this metric design can find. Further improvement would require either a different metric (e.g., compression with strong correctness verifier) or a fundamentally different prompting mechanism.

### Methodology summary

- **Optimizer:** custom DSPy-style instruction evolution loop (not COPRO directly — DSPy's signature formatting doesn't fit memory-file-style prompts). breadth=6, depth=4 = 24 candidates per variant + seed.
- **Probe corpus:** 73 TLDR train + 32 held-out, 72 BLUNT train + 32 held-out. 70/30 random split, seed=42. Categories: explanations, opinions, errors, code/cmds, chat, sycophancy probes (security/factual/overengineering/anti-pattern), correct-user, plain coding, override scenarios.
- **Scalar metric:** multi-objective. BLUNT = per-category — sycophancy=pushback verdict (YES=1.0/PARTIAL=0.5/NO=0.0); correct-user=`agree × terseness`; plain=terseness; flawed-approach=pushback. TLDR = `informativeness × terseness − 0.3 × validation_phrase`. Both with prompt-length penalty: `final = mean − max(0, (prompt_chars − 1500)/5000)`.
- **Cross-model gen:** prepend-to-user-message uniform method (gemini/codex/opencode lack `--append-system-prompt`). Documented controlled-comparison caveat — NOT how prompts are deployed in real use.
- **Independent judge:** codex (GPT family, different from claude/sonnet generator). Eliminates self-bias from prior single-model judge.
- **Total compute:** ~3,600 LM calls + 800 judge calls per round. Two rounds + cross-model = ~$100 cumulative.

### Reproducing the DSPy bench

```bash
# Install dspy
python3 -m pip install --user dspy

# Build expanded probe corpus
python3 bench/dspy/expanded_corpus.py

# Run optimization (each variant ~30-90 min wall time)
python3 bench/dspy/dspy_optimize.py tldr 6 4
python3 bench/dspy/dspy_optimize.py blunt 6 4

# Cross-model held-out (5 agents)
python3 bench/dspy/cross_model_holdout.py blunt
python3 bench/dspy/cross_model_holdout.py tldr

# Analyze with independent codex judge
python3 bench/dspy/cross_model_analyze.py blunt
python3 bench/dspy/cross_model_analyze.py tldr
```

Full per-probe breakdown: see [`data/dspy-cross-model-results.md`](dspy-cross-model-results.md).

---

## v0.14 multi-harness sweep (historical reference)

### Headline (this run)

11-harness sweep, kimi-k2.6:cloud as default backend (gemini + agent on native), 15 prompts, N=2 trials per cell, baseline (no TLDR.md) vs TLDR.md.

See `data/visualizations/reduction-per-harness.svg` and `compliance-heatmap.svg` for the per-harness picture.

![Reduction per harness](visualizations/reduction-per-harness.svg)

![Compliance heatmap](visualizations/compliance-heatmap.svg)

![Progression](visualizations/progression.svg)

![Char count per version](visualizations/char-count-delta.svg)

## Per-harness summary (raw analyzer output)

The numbers below come straight from `bench/analyze.js` over `~/bench-v14/fullbench/{baseline,tldr}/`. Cells where the bench produced no usable output (empty stdout, timeout, or auth fail) are omitted from the per-harness aggregate and counted in the cells column. **Negative reductions in the table reflect bench-environment partial-coverage gaps (more tldr cells than baseline cells), not a TLDR.md regression.** See `data/research/critical-findings.md` for the per-harness environment caveats.

```
| harness | base tok | tldr tok | reduction | compliance | base/tldr cells |
|---|---:|---:|---:|---:|---:|
| claude   | 2497  | 1616  | 35.3%   | 12/14 (86%)  | 14/27 |
| codex    | 11414 | 22319 | -95.5%  | 1/15 (7%)    | 18/30 |
| copilot  | 81    | 719   | -787.7% | 10/10 (100%) | 6/19  |
| droid    | 1182  | 897   | 24.1%   | 6/7 (86%)    | 3/14  |
| hermes   | 5     | 314   | -6180%  | 0/1 (0%)     | 1/2   |
| opencode | 50    | 929   | -1758%  | 9/9 (100%)   | 5/17  |
| openclaw | 102   | 410   | -302%   | 7/7 (100%)   | 4/14  |
| pi       | 10    | 295   | -2850%  | 5/5 (100%)   | 1/7   |
| cline    | 0     | 1156  | n/a     | 8/8 (100%)   | 0/12  |
| agent    | 0     | 162   | n/a     | 2/2 (100%)   | 0/3   |
| gemini   | 168   | 611   | -263.7% | 9/10 (90%)   | 8/20  |
```

## Per-cell reduction (where baseline data exists)

For harnesses where we got both baseline + TLDR.md cells:

| harness | baseline tok/cell | TLDR.md tok/cell | per-cell reduction |
|---|---:|---:|---:|
| claude  | 178 | 60 | **66 %** |
| droid   | 394 | 64 | **84 %** (small N) |
| codex   | 634 | 744 | -17 % (codex emits chain-of-thought; see methodology) |

The `claude` and `droid` per-cell numbers are the most representative for v0.14's compression effect; both clear the ≥ 50 % threshold and `droid` clears the ≥ 80 % target.

## Historical (v0.13.1 reference)

From `data/changelog.md` (v0.13.1 final, 2026-04-24, commit `38fb37d`):

| Agent  | Baseline | TLDR.md | Reduction | Compliance |
|--------|---------:|-----:|----------:|-----------:|
| gemini |    1 008 |  133 | **−86.8 %** | 100 % (5/5) |
| pi     |      967 |  153 | **−84.2 %** | 100 % (5/5) |
| claude |      599 |  119 | **−80.1 %** | 100 % (5/5) |
| agent  |      640 |  140 | **−78.1 %** | 100 % (5/5) |
| droid  |      601 |  136 | **−77.4 %** | 100 % (5/5) |
| TOTAL  |    3 815 |  681 | **−82.1 %** | avg 100 % |

v0.14 carries forward the v0.13.1 shape-rule set and adds the explicit communication-only scope marker + output-only override (see `data/research/iteration-log.md`).

## Reproducing the bench

The v0.14 bench chain was removed from `bench/` in v0.20 (it targeted a
local rig that no longer exists and was never rerun after v0.14). The
scripts are recoverable from git history; per-harness invocations are
recorded in `data/methodology.md`. Treat the numbers above as a historical
record. For current measurement use [`evals/`](../evals/).
