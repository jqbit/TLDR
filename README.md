<div align="center">
  <img src="docs/assets/tldr-mascot.png" width="120" alt="TLDR mascot" />
</div>

<h1 align="center">TLDR</h1>

<p align="center">
  <strong>Verdict first. Filler never.</strong>
</p>

<p align="center">
  <a href="https://github.com/0p9b/TLDR/stargazers"><img src="https://img.shields.io/github/stars/0p9b/TLDR?style=flat&color=yellow" alt="Stars"></a>
  <a href="https://github.com/0p9b/TLDR/commits/main"><img src="https://img.shields.io/github/last-commit/0p9b/TLDR?style=flat" alt="Last Commit"></a>
  <a href="LICENSE"><img src="https://img.shields.io/github/license/0p9b/TLDR?style=flat" alt="License"></a>
  <img src="https://img.shields.io/badge/works%20with-30%2B%20agents-2c2a26?style=flat" alt="30+ agents" />
</p>

<p align="center">
  <a href="#before--after">Before/After</a> •
  <a href="#the-prompt--tldrmd">Prompt</a> •
  <a href="#install--prompt-only-installsh">Prompt install</a> •
  <a href="#install--full-stack-bininstalljs">Full install</a> •
  <a href="./docs/INSTALL.md">Install</a> •
  <a href="data/benchmarks.md">Benchmarks</a>
</p>

---

Terse, high-signal responses for AI coding agents — less filler, same accuracy on tools, code, and safety.

**One repo, two install paths:**

| Path | What you get | Best for |
|------|----------------|----------|
| **[`TLDR.md`](TLDR.md) + [`install.sh`](install.sh)** | Copies the system prompt (and `/tldr` command) into standard agent config locations | Quick global rules file, no Node required |
| **[`bin/install.js`](bin/install.js)** (via `npx`) | Detects installed agents; plugins, hooks, skills, optional MCP shrink | Claude Code, Cursor, Codex, Gemini, 30+ agents — see **[docs/INSTALL.md](docs/INSTALL.md)** |

> Historical prompt variants and benchmarks: [`data/changelog.md`](data/changelog.md), [`data/progression.md`](data/progression.md).

## Before / After

<table>
<tr>
<td width="50%">

### 🗣️ Normal agent (verbose)

> "Sure! I'd be happy to help. The reason your React component is re-rendering is likely because you're creating a new object reference on each render. I'd recommend wrapping it in `useMemo`."

</td>
<td width="50%">

### <img src="docs/assets/tldr-mascot.png" width="20" alt="TLDR"/> TLDR mode

> New object ref each render. Inline prop = new ref = re-render. `useMemo`.

</td>
</tr>
</table>

**Same fix. ~60–75% fewer prose tokens in historical benchmarks** (earlier prompt generations; the current prompt has not been rerun) — tools, code, and safety unchanged. Writeup: [`data/benchmarks.md`](data/benchmarks.md) · honest cost/benefit: [`docs/HONEST-NUMBERS.md`](docs/HONEST-NUMBERS.md).

## The prompt — `TLDR.md`

[`TLDR.md`](TLDR.md) is the active prompt (1,892 bytes). It changes **prose style only** — not tools, reasoning, or safety.

| File | Bytes |
|------|------:|
| [`TLDR.md`](TLDR.md) | 1,892 |
| [`commands/tldr.md`](commands/tldr.md) | 1,274 |

**Current defaults (prompt):**
- default: 1 sentence
- target: 3 words
- default max: 6 words
- one-word greeting for plain greetings
- `/tldr` (supported agents) re-applies rules live in long sessions

## Install — prompt only (`install.sh`)

No Node required. Writes `TLDR.md` to seven standard agent paths and installs `/tldr` where supported.

```bash
curl -fsSL https://raw.githubusercontent.com/0p9b/TLDR/main/install.sh | bash -s --
```

Optional Hermes merge into `~/.hermes/SOUL.md`:

```bash
curl -fsSL https://raw.githubusercontent.com/0p9b/TLDR/main/install.sh | bash -s -- --with-hermes
```

(Prompt-only. Full Hermes skill suite → `node bin/install.js --only hermes`.)

Preview: `curl -fsSL https://raw.githubusercontent.com/0p9b/TLDR/main/install.sh`

Manual paths and copy/paste commands: [`data/agent-locations.md`](data/agent-locations.md).

## Install — full stack (`bin/install.js`)

Node ≥18. Auto-detects agents, installs the right plugin/extension/skills/hooks per agent.

```bash
npx -y github:0p9b/TLDR
```

From a clone:

```bash
git clone https://github.com/0p9b/TLDR.git && cd TLDR
node bin/install.js          # detected agents
node bin/install.js --all    # hooks + per-repo init (mcp-shrink needs upstream — opt in)
node bin/install.js --with-mcp-shrink="npx @modelcontextprotocol/server-filesystem /tmp"
node bin/install.js --list   # agent matrix
```

Windows: [`install.ps1`](install.ps1) runs the Node installer.

**Full flags, per-agent table, verify, uninstall, troubleshooting:** **[docs/INSTALL.md](docs/INSTALL.md)**.

### Updating

```bash
tldr update                 # or: node bin/install.js update
tldr update --check         # report available update only
```

Refreshes the git tree (local clone or `~/.tldr/src`), then reinstalls agent hooks/skills. Details: **[docs/INSTALL.md § Updating](docs/INSTALL.md#updating)**. Slash: `/tldr-update`.

## Verify (prompt install)

```bash
for p in ~/.claude/CLAUDE.md ~/.gemini/AGENTS.md ~/.codex/AGENTS.md \
         ~/AGENTS.md ~/.config/opencode/AGENTS.md \
         ~/.factory/AGENTS.md ~/.pi/agent/AGENTS.md; do
  [ -f "$p" ] && grep -q "^## Prime directive" "$p" && echo "✓ $p" || echo "✗ $p"
done
grep -q "^## Prime directive" ~/.hermes/SOUL.md 2>/dev/null && echo "✓ ~/.hermes/SOUL.md" || echo "✗ ~/.hermes/SOUL.md"
```

## Repository map

| Path | Purpose |
|------|---------|
| `TLDR.md` | Canonical terse system prompt |
| `commands/tldr.md` | `/tldr` slash command |
| `install.sh` | Prompt-only installer (+ optional Hermes) |
| `install.ps1` | Windows entry → `bin/install.js` |
| `bin/install.js` | Unified multi-agent installer |
| `skills/` | TLDR skill suite (source of truth for behavior) |
| `plugins/tldr/` | Claude Code / distribution mirrors (CI-synced) |
| `src/hooks/` | Claude Code SessionStart / mode hooks |
| `docs/INSTALL.md` | Full installer documentation |
| `.github/CONTRIBUTING.md` | How to change skills or add agents |
| `data/agent-locations.md` | Per-agent install paths |

## Research & benchmarks

- [data/agent-locations.md](data/agent-locations.md)
- [data/benchmarks.md](data/benchmarks.md)
- [data/dspy-cross-model-results.md](data/dspy-cross-model-results.md)
- [data/changelog.md](data/changelog.md)

## License

MIT — see [`LICENSE`](LICENSE). Third-party lineage/notices: [`ATTRIBUTION.md`](docs/legal/ATTRIBUTION.md), [`THIRD_PARTY_NOTICES.md`](docs/legal/THIRD_PARTY_NOTICES.md).