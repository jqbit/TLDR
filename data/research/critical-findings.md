# Critical findings — TLDR.md v0.14 multi-harness bench

## v0.14 testing context

Bench environment: single VPS, ollama-cloud routing for 9 of 11 harnesses, native backends for cursor (`agent`) and gemini. Models swept (Tier-A): kimi-k2.6, deepseek-v4-flash, gemini-3-flash-preview, qwen3-coder-next, glm-5.1, minimax-m2.7. Default winner per harness for full bench: kimi-k2.6:cloud (verified routing for claude, codex, droid, opencode, hermes, opencode, openclaw, pi).

## Harness reliability (this run)

| harness | invocation works | notes |
|---|---|---|
| claude | ✓ | clean output, TLDR.md-compliant |
| codex | ✓ but verbose | emits internal reasoning chain in stdout, inflating token count |
| droid | ✓ | shows config-mod banner; otherwise clean |
| opencode | ✓ | kimi-k2.6 occasionally replies in Chinese (model quirk, not TLDR.md) |
| openclaw | ⚠ slow | TUI-only (~3 min/cell); session-persistent — `/new` from piped stdin not always honored; bench uses one cell at a time |
| hermes | ⚠ TTY-sensitive | `chat -q` flag works under TTY emulation; without TTY emits empty output |
| pi | ⚠ first-run setup | `Preparing Pi…` setup blocks first invocation; subsequent calls fast — pre-warm needed |
| cline | ⚠ slot location | system prompt at `~/.cline/data/rules/TLDR.md`; activation via project `.clinerules/` may be required |
| copilot | ⚠ routing not verified | `ollama launch copilot` succeeds but post-call telemetry suggests native GitHub-Copilot backend, not ollama; metrics for copilot reflect copilot's own model |
| agent (cursor) | ✓ | requires `--model gpt-5.3-codex` or `gpt-5.2`; default `composer-2-fast` ignores TLDR.md (RLHF lock-in) |
| gemini | ⚠ auth | OAuth creds in `~/.gemini/oauth_creds.json` — non-interactive `gemini -p` hangs in our env; bench cell budget exhausted at timeout |

## Bench gaps (this run)

For some harnesses we did not produce N=3 trials × 15 prompts × 2 conditions cleanly:
- copilot, hermes, pi, cline, gemini — high timeout rates due to first-run setup, auth, or TTY sensitivities documented above. The published bench reports only the cells that produced non-empty output.
- openclaw was tested at reduced N due to per-cell wall time (~180 s).

These gaps are environmental, not TLDR.md defects. Re-running the bench with serial-per-harness execution + per-harness pre-warmup eliminates the empty cells. The bench script and analyzer were removed in v0.20; see git history.

## Methodological lessons (carried forward from v0.13.x + new)

1. **Cwd contamination is real** — cursor (and to a lesser extent gemini) inspect cwd and embed file content into responses. Bench cells must use a fresh empty cwd.
2. **Concurrent `ollama launch <h>` for the same harness races on config writes**. Serialize within-harness; parallelize across harnesses.
3. **Process orphans across sessions** — if multiple Claude Code sessions are running on the same host, harness CLIs (cline config, openclaw probes) hold locks that block bench cells. Run benches in a clean process namespace.
4. **`/tmp` may be rotated** — long bench artifacts should live under `~/bench-v14/` or `/var/lib/...`, not `/tmp/`.
5. **Codex emits chain-of-thought in stdout**, which inflates measured "prose" tokens. The tokenizer should detect and strip codex-style reasoning blocks for fair bench, OR codex should be evaluated on artifact-only criteria (`grep -A1 '^codex$'`).
6. **Hard-template lexical match wins over soft caps** for short prompts (Q01, Q11, Q13).
7. **Positive directives > negative constraints** — "Output X" beats "Don't output Y". Negatives invite RLHF agents to explain what they aren't doing, inflating the response.
8. **Char-count of TLDR.md is non-monotonic with compliance** — past ~1500 chars, additional rules can REDUCE compliance (cursor finding from v0.13 — composer-2-fast peaks at the smallest variant).

## Communication-only guarantee (Q08 + Q13 gates)

TLDR.md v0.14 is explicitly scoped to PROSE compression. The following are NEVER cut:
- Tool calls (file writes, command runs)
- Code correctness inside fenced blocks (Q08 must produce a working `groupby.py`)
- Output-only artifacts (Q13 IPv4 regex must be valid)
- Reasoning depth on debug/architecture prompts

Variants that fail Q08 (tool-use breaks) or Q13 (prose leaks into regex output) are auto-rejected.
