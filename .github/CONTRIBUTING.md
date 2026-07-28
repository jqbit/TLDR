# Contributing to TLDR

Thanks for considering a contribution. TLDR is a multi-agent skill that
makes 30+ AI coding agents talk in compressed tldr-style prose. Most
contributions fall into one of three buckets:

1. **Editing skill prose** — change how TLDR speaks, what intensity levels do, what slash commands trigger.
2. **Adding a new agent** — wire a fresh editor/CLI/IDE into the unified installer.
3. **Fixing the hooks or installer** — Claude Code hooks, the Node installer, the per-repo init script.

TLDR like simple. Small focused PR > big rewrite.

---

## Quick orientation

The repo distributes one skill (`tldr`) plus a handful of sub-skills
(tldr-commit, tldr-review, tldr-compress, tldrcrew-*) to many
agents through different distribution mechanisms (Claude Code plugin, Codex
plugin, Gemini extension, Cursor/Windsurf/Cline rule files, `npx skills` for
the long tail). A single Node installer at `bin/install.js` detects which
agents are on the user's machine and installs the right thing for each.

Sources of truth live at the **top level** of the repo. There are no
checked-in mirrors: `skills/`, `agents/`, and `commands/` are the only
copies, and the installer reads them directly.

---

## What to edit (sources of truth)

| I want to change... | Edit this file |
|---|---|
| TLDR behavior (intensity levels, voice, rules) | `skills/tldr/SKILL.md` |
| TLDR commit-message format | `skills/tldr-commit/SKILL.md` |
| TLDR code-review format | `skills/tldr-review/SKILL.md` |
| TLDR compress logic | `skills/tldr-compress/SKILL.md` and `skills/tldr-compress/scripts/` |
| TLDR quick-reference card | `skills/tldr-help/SKILL.md` |
| tldrcrew decision guide (when to delegate to subagents) | `skills/tldrcrew/SKILL.md` |
| tldrcrew subagent definitions | `agents/tldrcrew-investigator.md`, `agents/tldrcrew-builder.md`, `agents/tldrcrew-reviewer.md` |
| Auto-activation rule body (Cursor/Windsurf/Cline/Copilot) | `src/rules/tldr-activate.md` |
| Add support for a new agent | `bin/install.js` (PROVIDERS array) |
| Per-repo init script (drops rule files into a user's repo) | `src/tools/tldr-init.js` |
| Claude Code hooks | `src/hooks/tldr-activate.js`, `src/hooks/tldr-mode-tracker.js`, `src/hooks/tldr-config.js`, `src/hooks/tldr-statusline.sh`, `src/hooks/tldr-statusline.ps1` |
| Settings.json read/write helpers | `bin/lib/settings.js` |
| MCP shrink server | `src/mcp-servers/tldr-shrink/` |

That's it. Every other markdown file with `SKILL.md` in the path is a copy.

---

## Adding a new agent

The unified Node installer at `bin/install.js` is the **single source of
truth** for the supported-agent list. The README and `INSTALL.md` install
tables mirror it by hand — bash and PowerShell shims at the repo root just
delegate to it.

1. Confirm the agent has a distribution path. Either:
   - it has a profile slug in upstream [vercel-labs/skills](https://github.com/vercel-labs/skills) (most common), or
   - it has a native plugin / extension / rule-file mechanism we can target.
2. Append a row to the `PROVIDERS` array in `bin/install.js`. Each row needs:
   - `id` — short kebab-case identifier (e.g. `windsurf`)
   - `label` — human display name (e.g. `Windsurf`)
   - `mech` — distribution mechanism (`plugin`, `extension`, `rules-file`, `skills-cli`, …)
   - `detect` — clause spec like `command:foo||dir:$HOME/x` describing how to detect the agent
   - `profile` — the vercel-labs/skills slug, if applicable
   - `soft: true` — set when detection is config-dir-only (best-effort)
3. Run `node bin/install.js --list` and confirm the new row renders correctly. Soft probes should show as `(soft)`.
4. Add a row to the install tables in `README.md` and `INSTALL.md`.
5. No CI changes needed — the workflow re-reads `bin/install.js` automatically.

Bad slug? `npx skills add` fails at install **runtime**, not at install-script
load. Always verify the slug against the vercel-labs/skills README before
merging.

---

## Adding a new skill

1. Create `skills/<name>/SKILL.md` with frontmatter:
   ```yaml
   ---
   name: <name>
   description: <one sentence, present tense>
   ---
   ```
2. Create `skills/<name>/README.md` — human-facing summary, install hint, example.
3. Add `skills/<name>/scripts/` if the skill ships helpers (Python or Node).
5. If it's user-invocable as a slash command, add a row to the slash-command table in `README.md` and `INSTALL.md`.
6. Add an eval prompt to `evals/prompts/en.txt` if you want the eval harness to score it.

---

## Running tests

```bash
# Primary CI / merge gates
python3 tests/verify_repo.py
python3 tests/check-doc-sync.py
npm test

# Additional standalone suites
python3 -m unittest tests.test_compress_safety
python3 -m unittest tests.test_hooks
python3 -m unittest tests.test_validate_inline
node tests/test_tldr_init.js
node tests/test_symlink_flag.js
node tests/test_repo_local_config.js
node tests/test_tldr_stats.js
node tests/test_mcp_shrink.js
```

CI runs all of the above on every PR. If any test depends on a network or
external SDK, it must skip cleanly when the dependency is missing — never
gate the whole suite on optional creds.

---

## Running benchmarks and evals

Benchmarks hit the real Claude API and record raw token counts:

```bash
```

Evals are a three-arm offline harness (`__baseline__`, `__terse__`, each skill):

```bash
python evals/llm_run.py             # regenerates evals/snapshots/results.json
python evals/measure.py             # reads snapshot, prints token deltas
```

No eval snapshot is committed to git — generate your own with
`evals/llm_run.py` before quoting numbers (see `evals/README.md` and
`evals/snapshots/README.md` for why). Numbers in `README.md` and any docs
come from real runs against this repo's skills — never invent, round, or
relabel another project's data.

---

## Pull-request guidelines

- **Conventional Commits** for the commit subject. See `skills/tldr-commit/SKILL.md` for the format we use here.
- **One concern per PR.** A README copy-edit and an installer fix go in separate PRs.
- **Update `package.json` `files`** if you add a new top-level directory the installer needs to ship to npm. Files outside that array don't get published.
- **Show before/after** for prose changes to any `SKILL.md`. One sentence on why the new wording is better.

PR descriptions don't need to be long. TLDR style fine. Just say what change, why.

---

## Code style

A handful of invariants that have bitten us before. Keep them.

- **Hooks must silent-fail on filesystem errors.** A `try/catch` that swallows the error is correct here. A hook that throws blocks Claude Code session start — that's user-facing breakage. See existing patterns in `src/hooks/tldr-activate.js`.
- **Settings.json reads and writes go through `bin/lib/settings.js`.** It tolerates JSONC comments. Direct `JSON.parse` on a user's `settings.json` will crash on a single `// comment`.
- **Validate hook entries before writing.** Use `validateHookFields()` in `bin/lib/settings.js`. Claude Code's Zod schema silently discards the **entire** `settings.json` on a single bad hook entry — one malformed write poisons the user's whole config.
- **Symlink-safe flag writes via `safeWriteFlag()`** in `src/hooks/tldr-config.js`. The flag file lives at a predictable path under `$CLAUDE_CONFIG_DIR/`; without `O_NOFOLLOW` and a parent-symlink check, a local attacker can clobber any file the user can write.
- **Honor `CLAUDE_CONFIG_DIR`.** Hooks, the installer, and the statusline scripts must respect it — never hardcode `~/.claude`.
- **`install.sh`** — prompt-only Bash installer (no Node): copies `TLDR.md` + `commands/tldr.md` to standard paths.
- **`install.ps1` / `bin/install.js`** — full multi-agent stack (Node ≥18). Do not duplicate installer logic in `install.sh`.

---

## Ideas

See [issues labeled `good first issue`](https://github.com/0p9b/TLDR/issues?q=label%3A%22good+first+issue%22)
for starter tasks. Or grep `TODO` / `FIXME` in `src/hooks/`, `bin/`, `src/tools/` —
each one is a real lead.

Contributions welcome. Open a PR — small, focused changes merge fastest.
