#!/usr/bin/env bash
set -euo pipefail

usage() {
  cat <<'EOF'
Usage:
  install.sh [--with-hermes] [--overwrite-hermes] [--dry-run]

Examples:
  install.sh
  install.sh --with-hermes
  curl -fsSL https://raw.githubusercontent.com/0p9b/TLDR/main/install.sh | bash -s -- --with-hermes

Behavior:
  - Installs TLDR.md to the 8 standard coding-agent locations (claude, gemini,
    codex, opencode, factory, pi, grok, and a repo-root AGENTS.md).
  - Overwrites an existing rules file (a timestamped .bak is kept first). For a
    NON-destructive, per-agent native install of all 38 supported agents, use
    the full installer instead: `npx -y github:0p9b/TLDR -- --all`.
  - Also installs /tldr command to supported agents' command dirs (claude, opencode, factory, cursor).
  - --with-hermes updates ~/.hermes/SOUL.md too (prompt merge only).
  - If SOUL.md already exists, --with-hermes preserves it and appends or updates
    a managed TLDR block instead of blindly overwriting the whole file.
  - --overwrite-hermes replaces ~/.hermes/SOUL.md with TLDR.md only.
  - Hermes skill-suite install (tldr, tldr-commit, tldr-review, tldr-help,
    tldr-stats, tldr-compress, tldrcrew → ~/.hermes/skills/productivity/) is
    handled by the full installer: node bin/install.js --only hermes
EOF
}

PROMPT_NAME="TLDR.md"
COMMAND_SRC="commands/tldr.md"
WITH_HERMES=0
OVERWRITE_HERMES=0
DRY_RUN=0

while [ "$#" -gt 0 ]; do
  case "$1" in
    --with-hermes)
      WITH_HERMES=1
      ;;
    --overwrite-hermes)
      WITH_HERMES=1
      OVERWRITE_HERMES=1
      ;;
    --dry-run)
      DRY_RUN=1
      ;;
    -h|--help)
      usage
      exit 0
      ;;
    *)
      printf 'Unknown argument: %s\n\n' "$1" >&2
      usage >&2
      exit 1
      ;;
  esac
  shift
 done

# Pin remote fetches to an immutable release tag, never the moving `main` — a
# push to main must never silently change what a `curl|bash` install downloads.
# Keep the default in lockstep with PINNED_REF in bin/install.js. Override with
# TLDR_REF for branch testing.
RAW_BASE="https://raw.githubusercontent.com/0p9b/TLDR/${TLDR_REF:-v0.20.0}"
if [ -f "${BASH_SOURCE[0]:-}" ]; then
  SCRIPT_DIR="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" >/dev/null 2>&1 && pwd || true)"
  LOCAL_PROMPT="${SCRIPT_DIR}/${PROMPT_NAME}"
  LOCAL_COMMAND="${SCRIPT_DIR}/commands/tldr.md"
else
  SCRIPT_DIR=""
  LOCAL_PROMPT=""
  LOCAL_COMMAND=""
fi
TMP_PROMPT=""
TMP_COMMAND=""
PROMPT_PATH=""
COMMAND_PATH=""

cleanup() {
  if [ -n "$TMP_PROMPT" ] && [ -f "$TMP_PROMPT" ]; then
    rm -f "$TMP_PROMPT"
  fi
  if [ -n "$TMP_COMMAND" ] && [ -f "$TMP_COMMAND" ]; then
    rm -f "$TMP_COMMAND"
  fi
}
trap cleanup EXIT


download_file() {
  local url="$1"
  local out="$2"
  if command -v curl >/dev/null 2>&1; then
    curl -fsSL --retry 3 --proto =https "$url" -o "$out.tmp"
    mv -f "$out.tmp" "$out"
  elif command -v wget >/dev/null 2>&1; then
    wget -qO "$out.tmp" "$url"
    mv -f "$out.tmp" "$out"
  else
    printf 'Need curl or wget.\n' >&2
    exit 1
  fi
}

resolve_prompt() {
  if [ -n "$LOCAL_PROMPT" ] && [ -f "$LOCAL_PROMPT" ]; then
    PROMPT_PATH="$LOCAL_PROMPT"
    return
  fi

  TMP_PROMPT="$(mktemp)"
  PROMPT_PATH="$TMP_PROMPT"
  download_file "${RAW_BASE}/${PROMPT_NAME}" "$PROMPT_PATH"
}

resolve_command() {
  if [ -n "$LOCAL_COMMAND" ] && [ -f "$LOCAL_COMMAND" ]; then
    COMMAND_PATH="$LOCAL_COMMAND"
    return
  fi

  TMP_COMMAND="$(mktemp)"
  COMMAND_PATH="$TMP_COMMAND"
  set +e
  download_file "${RAW_BASE}/commands/tldr.md" "$COMMAND_PATH" > /dev/null 2>&1
  ret=$?
  set -e
  if [ $ret -ne 0 ]; then
    rm -f "$TMP_COMMAND"
    COMMAND_PATH=""
    return
  fi
}

write_standard_path() {
  local target="$1"
  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'DRY RUN  would write %s -> %s\n' "$PROMPT_NAME" "$target"
    return
  fi
  mkdir -p "$(dirname "$target")"
  if [ -f "$target" ]; then
    if cmp -s "$PROMPT_PATH" "$target"; then
      printf 'UNCHANGED %s\n' "$target"
      return
    fi
    cp "$target" "${target}.bak.$(date +%Y%m%d-%H%M%S)"
  fi
  cp "$PROMPT_PATH" "$target"
  printf 'INSTALLED %s\n' "$target"
}

install_standard_locations() {
  write_standard_path "$HOME/.claude/CLAUDE.md"
  write_standard_path "$HOME/.gemini/AGENTS.md"
  write_standard_path "$HOME/.codex/AGENTS.md"
  write_standard_path "$HOME/AGENTS.md"
  write_standard_path "$HOME/.config/opencode/AGENTS.md"
  write_standard_path "$HOME/.factory/AGENTS.md"
  write_standard_path "$HOME/.pi/agent/AGENTS.md"
  write_standard_path "$HOME/.grok/AGENTS.md"
}

install_hermes() {
  local soul="$HOME/.hermes/SOUL.md"

  if [ "$DRY_RUN" -eq 1 ]; then
    if [ "$OVERWRITE_HERMES" -eq 1 ]; then
      printf 'DRY RUN  would overwrite %s with %s\n' "$soul" "$PROMPT_NAME"
    else
      printf 'DRY RUN  would merge %s into %s\n' "$PROMPT_NAME" "$soul"
    fi
    return
  fi

  mkdir -p "$HOME/.hermes"

  if [ "$OVERWRITE_HERMES" -eq 1 ]; then
    cp "$PROMPT_PATH" "$soul"
    printf 'INSTALLED %s\n' "$soul"
    return
  fi

  if ! command -v python3 >/dev/null 2>&1; then
    printf 'python3 required for --with-hermes merge mode.\n' >&2
    exit 1
  fi

  python3 - "$soul" "$PROMPT_PATH" <<'PY'
from pathlib import Path
import shutil
import sys
from datetime import datetime

soul = Path(sys.argv[1]).expanduser()
prompt_path = Path(sys.argv[2])
prompt = prompt_path.read_text(encoding="utf-8")
start = "<!-- TLDR.MD START -->"
end = "<!-- TLDR.MD END -->"
prompt_body = prompt.rstrip("\n")

if not soul.exists() or soul.read_text(encoding="utf-8").strip() == "":
    soul.write_text(prompt, encoding="utf-8")
    print(f"INSTALLED {soul}")
    raise SystemExit(0)

text = soul.read_text(encoding="utf-8")
if prompt_body in text:
    print(f"UNCHANGED {soul} already contains the current prompt block")
    raise SystemExit(0)

backup = soul.with_name(soul.name + ".bak." + datetime.now().strftime("%Y%m%d-%H%M%S-%f"))
shutil.copy2(soul, backup)

managed = f"{start}\n{prompt_body}\n{end}"

if start in text and end in text and text.index(start) < text.index(end):
    before, rest = text.split(start, 1)
    _, after = rest.split(end, 1)
    new_text = before.rstrip() + "\n\n" + managed
    if after.strip():
        new_text += "\n\n" + after.lstrip("\n")
    else:
        new_text += "\n"
    soul.write_text(new_text, encoding="utf-8")
    print(f"UPDATED {soul} (backup: {backup})")
else:
    new_text = text.rstrip() + "\n\n" + managed + "\n"
    soul.write_text(new_text, encoding="utf-8")
    print(f"MERGED {soul} (backup: {backup})")
PY
}

verify_path() {
  local target="$1"
  if [ -f "$target" ] && grep -q '^## Prime directive' "$target"; then
    printf '✓ %s\n' "$target"
  else
    printf '✗ %s\n' "$target"
  fi
}

verify_hermes() {
  local soul="$HOME/.hermes/SOUL.md"
  if grep -q '^## Prime directive' "$soul" 2>/dev/null; then
    printf '✓ %s\n' "$soul"
  else
    printf '✗ %s\n' "$soul"
  fi
}

install_commands() {
  if [ ! -f "$COMMAND_PATH" ]; then
    printf 'SKIP commands (no %s)\n' "$COMMAND_SRC"
    return
  fi

  # claude legacy commands (body only)
  write_command "$HOME/.claude/commands/tldr.md" "claude"

  # claude skills (with frontmatter)
  write_command "$HOME/.claude/skills/tldr/SKILL.md" "skill"

  # opencode global commands (with frontmatter)
  write_command "$HOME/.config/opencode/commands/tldr.md" "opencode"

  # factory/droid commands (with frontmatter)
  write_command "$HOME/.factory/commands/tldr.md" "factory"

  # cursor commands (body, for IDE + partial CLI)
  write_command "$HOME/.cursor/commands/tldr.md" "cursor"
}

write_command() {
  local target="$1"
  local kind="$2"
  local body
  body="$(cat "$COMMAND_PATH")"

  if [ "$DRY_RUN" -eq 1 ]; then
    printf 'DRY RUN  would write %s -> %s\n' "$COMMAND_SRC" "$target"
    return
  fi

  mkdir -p "$(dirname "$target")"

  local content="$body"
  if [ "$kind" = "skill" ] || [ "$kind" = "opencode" ] || [ "$kind" = "factory" ]; then
    content="---
description: Live TLDR reminder. Re-applies 1-sentence/3-word-target/6-word-max rules in long sessions.
argument-hint: [query]
---
$body"
  fi

  if [ -f "$target" ]; then
    if printf '%s\n' "$content" | cmp -s - "$target" 2>/dev/null; then
      printf 'UNCHANGED %s\n' "$target"
      return
    fi
    cp "$target" "${target}.bak.$(date +%Y%m%d-%H%M%S)"
  fi

  printf '%s\n' "$content" > "$target"
  printf 'INSTALLED %s\n' "$target"
}

resolve_prompt
resolve_command
install_standard_locations
install_commands

if [ "$WITH_HERMES" -eq 1 ]; then
  install_hermes
fi

if [ "$DRY_RUN" -eq 1 ]; then
  printf '\nDry run only; verification skipped.\n'
  exit 0
fi

printf '\nVerification:\n'
verify_path "$HOME/.claude/CLAUDE.md"
verify_path "$HOME/.gemini/AGENTS.md"
verify_path "$HOME/.codex/AGENTS.md"
verify_path "$HOME/AGENTS.md"
verify_path "$HOME/.config/opencode/AGENTS.md"
verify_path "$HOME/.factory/AGENTS.md"
verify_path "$HOME/.pi/agent/AGENTS.md"

# command files (light check)
for c in "$HOME/.claude/commands/tldr.md" "$HOME/.claude/skills/tldr/SKILL.md" \
         "$HOME/.config/opencode/commands/tldr.md" "$HOME/.factory/commands/tldr.md" \
         "$HOME/.cursor/commands/tldr.md"; do
  if [ -f "$c" ] && grep -q 'Re-apply TLDR rules' "$c" 2>/dev/null; then
    printf '✓ %s\n' "$c"
  else
    printf '✗ %s\n' "$c"
  fi
done

if [ "$WITH_HERMES" -eq 1 ]; then
  verify_hermes
fi
