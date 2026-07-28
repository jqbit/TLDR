#!/usr/bin/env python3
"""Local verification runner for TLDR install surfaces."""

from __future__ import annotations

import hashlib
import json
import os
import shutil
import subprocess
import sys
import tempfile
import zipfile
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]


class CheckFailure(RuntimeError):
    pass


def section(title: str) -> None:
    print(f"\n== {title} ==")


def ensure(condition: bool, message: str) -> None:
    if not condition:
        raise CheckFailure(message)


def run(
    args: list[str],
    *,
    cwd: Path = ROOT,
    env: dict[str, str] | None = None,
    check: bool = True,
) -> subprocess.CompletedProcess[str]:
    merged_env = os.environ.copy()
    # Keep Python subprocess output decodable on Windows when the CLI prints Unicode.
    merged_env.setdefault("PYTHONIOENCODING", "utf-8")
    if env:
        merged_env.update(env)
    result = subprocess.run(
        args,
        cwd=cwd,
        env=merged_env,
        text=True,
        encoding="utf-8",
        capture_output=True,
        check=False,
    )
    if check and result.returncode != 0:
        raise CheckFailure(
            f"Command failed ({result.returncode}): {' '.join(args)}\n"
            f"stdout:\n{result.stdout}\n"
            f"stderr:\n{result.stderr}"
        )
    return result


def read_json(path: Path) -> object:
    return json.loads(path.read_text(encoding="utf-8"))


def shell_path(path: Path) -> str:
    return str(path).replace("\\", "/") if os.name == "nt" else str(path)


def _frontmatter_description(path: Path) -> str:
    lines = path.read_text(encoding="utf-8").splitlines()
    ensure(lines and lines[0] == "---", f"{path} missing YAML frontmatter")

    description_lines: list[str] = []
    collecting = False
    block_indent: int | None = None
    for line in lines[1:]:
        if line == "---":
            break
        if collecting:
            stripped = line.strip()
            if not stripped:
                description_lines.append("")
                continue
            indent = len(line) - len(line.lstrip(" \t"))
            if block_indent is None:
                if indent == 0:
                    break
                block_indent = indent
            elif indent < block_indent:
                break
            description_lines.append(stripped)
            continue
        if line.startswith("description:"):
            value = line.split(":", 1)[1].strip()
            # Folded (>) and literal (|) block scalars, with optional chomping (-/+).
            if value and value[0] in ("|", ">"):
                collecting = True
                continue
            return value.strip("'\"")
    return " ".join(part for part in description_lines if part)


def verify_skill_frontmatter_upload_compatibility() -> None:
    section("Skill Frontmatter Upload Compatibility")

    skill_paths = [
        ROOT / "skills/tldr/SKILL.md",
        ROOT / "skills/tldr-commit/SKILL.md",
        ROOT / "skills/tldr-help/SKILL.md",
        ROOT / "skills/tldr-review/SKILL.md",
        ROOT / "skills/tldr-compress/SKILL.md",
    ]
    for path in skill_paths:
        description = _frontmatter_description(path)
        ensure(
            "<" not in description and ">" not in description,
            f"{path} description contains XML-like angle brackets",
        )

    print("Skill frontmatter descriptions avoid XML-like tags")


def verify_synced_files() -> None:
    section("Entrypoints")

    ensure(
        (ROOT / "bin" / "install.js").exists(),
        "bin/install.js missing — package.json bin entry would break npx TLDR",
    )
    ensure(
        (ROOT / "bin" / "lib" / "settings.js").exists(),
        "bin/lib/settings.js missing — installer would crash on JSONC settings.json",
    )

    print("Installer entrypoints OK")


def verify_hook_checksums() -> None:
    section("Hook Checksums")

    manifest = ROOT / "src" / "hooks" / "checksums.sha256"
    ensure(manifest.exists(), "src/hooks/checksums.sha256 missing (hook integrity manifest)")

    listed: dict[str, str] = {}
    for line in manifest.read_text(encoding="utf-8").splitlines():
        line = line.strip()
        if not line:
            continue
        parts = line.split(None, 1)
        ensure(len(parts) == 2, f"malformed checksums.sha256 line: {line!r}")
        digest, name = parts[0], parts[1].lstrip("*").strip()
        listed[name] = digest.lower()

    for name, want in listed.items():
        target = ROOT / "src" / "hooks" / name
        ensure(target.exists(), f"checksums.sha256 lists a missing file: {name}")
        actual = hashlib.sha256(target.read_bytes()).hexdigest()
        ensure(
            actual == want,
            f"checksums.sha256 is stale for {name}: recorded {want}, actual {actual}. "
            f"Regenerate: cd src/hooks && sha256sum {' '.join(listed)} > checksums.sha256",
        )

    print(f"src/hooks/checksums.sha256 verified ({len(listed)} hook file(s))")


def verify_manifests_and_syntax() -> None:
    section("Manifests And Syntax")

    manifest_paths = [
        ROOT / ".claude-plugin/plugin.json",
        ROOT / ".claude-plugin/marketplace.json",
        ROOT / ".codex/hooks.json",
        ROOT / "gemini-extension.json",
    ]
    for path in manifest_paths:
        read_json(path)

    run(["node", "--check", "src/hooks/tldr-config.js"])
    run(["node", "--check", "src/hooks/tldr-activate.js"])
    run(["node", "--check", "src/hooks/tldr-mode-tracker.js"])
    run(["node", "--check", "src/hooks/tldrcrew-model-overrides.js"])
    run(["node", "--check", "bin/install.js"])
    run(["node", "--check", "bin/lib/opencode-agent.js"])
    run(["node", "--check", "bin/lib/settings.js"])
    run(["bash", "-n", "src/hooks/tldr-statusline.sh"])

    ensure((ROOT / "commands/tldr.toml").exists(), "commands/tldr.toml missing — bare /tldr TOML command not represented")
    ensure((ROOT / "bin/lib/opencode-agent.js").exists(), "opencode agent sanitizer missing")

    print("JSON manifests and JS/bash syntax OK")


def verify_powershell_static() -> None:
    section("PowerShell Static Checks")
    statusline_text = (ROOT / "src/hooks/tldr-statusline.ps1").read_text(encoding="utf-8")
    ensure("[TLDR" in statusline_text, "tldr-statusline.ps1 missing badge output")

    print("Windows statusline wired")


def load_compress_modules():
    sys.path.insert(0, str(ROOT / "skills/tldr-compress"))
    import scripts.benchmark  # noqa: F401
    import scripts.cli as cli
    import scripts.compress  # noqa: F401
    import scripts.detect as detect
    import scripts.validate as validate

    return cli, detect, validate


def verify_compress_fixtures() -> None:
    section("Compress Fixtures")
    _, detect, validate = load_compress_modules()

    fixtures = sorted((ROOT / "tests/tldr-compress").glob("*.original.md"))
    ensure(fixtures, "No tldr-compress fixtures found")

    for original in fixtures:
        compressed = original.with_name(original.name.replace(".original.md", ".md"))
        ensure(compressed.exists(), f"Missing compressed fixture for {original.name}")
        result = validate.validate(original, compressed)
        ensure(result.is_valid, f"Fixture validation failed for {compressed.name}: {result.errors}")
        ensure(detect.should_compress(compressed), f"Fixture should be compressible: {compressed.name}")

    print(f"Validated {len(fixtures)} tldr-compress fixture pairs")


def verify_compress_cli() -> None:
    section("Compress CLI")

    skip_result = run(
        ["python3", "-m", "scripts", "../../install.sh"],
        cwd=ROOT / "skills/tldr-compress",
        check=False,
    )
    ensure(skip_result.returncode == 0, "compress CLI skip path should exit 0")
    ensure("Detected: code" in skip_result.stdout, "compress CLI skip path missing detection output")
    ensure(
        "Skipping: file is not natural language" in skip_result.stdout,
        "compress CLI skip path missing skip output",
    )

    missing_result = run(
        ["python3", "-m", "scripts", "../../does-not-exist.md"],
        cwd=ROOT / "skills/tldr-compress",
        check=False,
    )
    ensure(missing_result.returncode == 1, "compress CLI missing-file path should exit 1")
    ensure("File not found" in missing_result.stdout, "compress CLI missing-file output mismatch")

    print("Compress CLI skip/error paths OK")



def main() -> int:
    checks = [
        verify_skill_frontmatter_upload_compatibility,
        verify_synced_files,
        verify_hook_checksums,
        verify_manifests_and_syntax,
        verify_powershell_static,
        verify_compress_fixtures,
        verify_compress_cli,
    ]

    try:
        for check in checks:
            check()
    except CheckFailure as exc:
        print(f"\nFAIL: {exc}", file=sys.stderr)
        return 1

    print("\nAll local verification checks passed")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
