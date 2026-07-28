# DSPy-style optimization bench (v0.17 / v0.18)

Custom DSPy-style instruction-evolution loop for optimizing the single shipped TLDR.md prompt against multi-objective metrics. Designed for environments without an Anthropic API key — wraps the `claude` CLI as the LM.

## What it does

1. **Optimization** (`dspy_optimize.py`) — COPRO-style instruction evolution. At each round, a meta-LM proposes N variations of the current best prompt; each is evaluated on the train set; top-K seed the next round. No few-shot demos added (keeps prompts short).
2. **Cross-model held-out** (`cross_model_holdout.py`) — generates responses to held-out probes using 5 agent CLIs (claude, codex, cursor-agent, gemini, opencode). Uses prepend-to-user-message for uniformity across agents that don't expose system-prompt injection.
3. **Independent judge analysis** (`cross_model_analyze.py`) — uses codex (different model family from the typical generator) to judge pushback, agreement, informativeness. Aggregates per-agent and runs paired t-tests.

## Files

| File | Purpose |
|---|---|
| `dspy_claude_lm.py` | Custom `dspy.LM` subclass wrapping `claude -p` (no API key needed) |
| `expanded_corpus.py` | Probe corpus (n=210) with train/test splits |
| `dspy_optimize.py` | Core optimization loop + scorers (`score_tldr_probe`, `score_blunt_probe`) |
| `dspy_optimize.py` | Entry point — `dspy_optimize.py {tldr|blunt} [breadth] [depth]` |
| `cross_model_holdout.py` | Cross-model generation across 5 agents |
| `cross_model_analyze.py` | Codex-as-judge analysis + paired t-tests |

## Reproduce

```bash
# Optional: override scratch output location
export TLDR_DSPY_DIR=/tmp/tldr-test/dspy

# 1. Install
python3 -m pip install --user dspy

# 2. Build probe corpus
python3 bench/dspy/expanded_corpus.py
# → /tmp/tldr-test/dspy/probe_splits_10x.json

# 3. Run optimization (~30-90 min wall time, ~1500 calls)
# Uses TLDR.md as the seed.
python3 bench/dspy/dspy_optimize.py tldr
# → /tmp/tldr-test/dspy/v2/tldr_best.md
# → /tmp/tldr-test/dspy/v2/tldr_history.json

# 4. Cross-model held-out generation (~25 min wall time)
python3 bench/dspy/cross_model_holdout.py tldr
# → /tmp/tldr-test/dspy/cross/tldr_responses.json

# 5. Independent codex judge + statistical analysis
python3 bench/dspy/cross_model_analyze.py tldr
# → /tmp/tldr-test/dspy/cross/tldr_summary.json
# → printed per-agent table with p-values
```

## Total cost

- Optimization: ~1,500 calls × $0.02 ≈ $30
- Cross-model held-out: ~400 calls
- Judge: ~400 calls
- **Total per full bench: ~$70**

## Method honesty

This bench is COPRO's algorithm (instruction-only optimization, no demos) implemented manually because DSPy's signature-based `Predict` formats prompts as structured Q&A templates, NOT as raw system prompts. TLDR.md is deployed as a raw memory file (raw system prompt). Implementing the loop manually preserves deployment fidelity.

The cross-model phase uses prepend-to-user-message for uniform comparison across agents — this is NOT how the prompts are deployed in real use. Treat cross-model results as "does this prompt's intent translate across model families given consistent presentation," not as direct deployment performance numbers.

See `data/methodology.md` (v0.18 section) for full methodology.
