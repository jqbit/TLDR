#!/usr/bin/env python3
"""Validate local Markdown links in this repository."""

from __future__ import annotations

import re
import sys
from pathlib import Path
from urllib.parse import unquote

ROOT = Path(__file__).resolve().parents[1]
LINK_RE = re.compile(r"!?\[[^\]]*\]\(([^)]+)\)")
SKIP_SCHEMES = ("http://", "https://", "mailto:", "tel:")


def iter_markdown_lines(path: Path):
    in_fence = False
    for lineno, line in enumerate(path.read_text(encoding="utf-8", errors="replace").splitlines(), 1):
        stripped = line.lstrip()
        if stripped.startswith("```") or stripped.startswith("~~~"):
            in_fence = not in_fence
            continue
        if not in_fence:
            yield lineno, line


def normalize_target(raw_href: str) -> str | None:
    href = raw_href.strip()
    if not href or href.startswith("#") or href.startswith(SKIP_SCHEMES):
        return None

    target = href.split("#", 1)[0].strip()
    if not target:
        return None

    if target.startswith("<") and target.endswith(">"):
        target = target[1:-1]

    # Drop optional Markdown titles: [x](path.md "title")
    target = target.split(' "', 1)[0].split(" '", 1)[0]
    return unquote(target)


def main() -> int:
    errors: list[str] = []
    checked = 0

    for path in sorted(ROOT.rglob("*.md")):
        if ".git" in path.parts:
            continue
        for lineno, line in iter_markdown_lines(path):
            for match in LINK_RE.finditer(line):
                target = normalize_target(match.group(1))
                if target is None:
                    continue
                checked += 1
                resolved = (path.parent / target).resolve()
                if not resolved.exists():
                    rel = path.relative_to(ROOT)
                    errors.append(f"{rel}:{lineno}: missing link target: {match.group(1)}")

    if errors:
        print("Broken Markdown links:", file=sys.stderr)
        for error in errors:
            print(f"  {error}", file=sys.stderr)
        return 1

    print(f"Checked {checked} local Markdown links.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
